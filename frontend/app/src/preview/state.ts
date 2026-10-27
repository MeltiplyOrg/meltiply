import { Schema } from "effect";
import { previewObjectSchema } from "./contract-types";
import type { PreviewObject, PreviewOperation, PreviewResponse } from "./contract-types";
import { mergeExample } from "./values";

type Collection = { path: string; field: string; envelope: PreviewObject; items: PreviewObject[] };
type Parameters = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Projects generated collection examples into tab-local CRUD state. It models frontend read-after-save/delete behavior, not backend business rules or external effects. */
export function createPreviewState(
  operations: PreviewOperation[],
  assets: Map<string, PreviewObject>,
) {
  const collections: Collection[] = [];
  for (const operation of operations) {
    const body = operation.success.body;
    if (
      operation.method !== "get" ||
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.id === "string" ||
      typeof body.user_id === "string"
    )
      continue;
    for (const [field, value] of Object.entries(body)) {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            item === null ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (typeof item.id !== "string" && typeof item.user_id !== "string"),
        )
      )
        continue;
      const items: PreviewObject[] = [];
      for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        items.push(item);
        if (Array.isArray(item.attachments)) {
          const attachments = Schema.decodeUnknownSync(
            Schema.Array(Schema.Struct({ asset: previewObjectSchema })),
          )(item.attachments);
          for (const { asset } of attachments)
            if (typeof asset.id === "string") assets.set(asset.id, asset);
        }
      }
      collections.push({ path: operation.path, field, envelope: body, items });
      break;
    }
  }
  collections.sort((left, right) => right.path.length - left.path.length);
  const owners = new Map(
    operations.map((operation) => [
      operation.operationId,
      collections.find(
        (collection) =>
          operation.path === collection.path || operation.path.startsWith(`${collection.path}/{`),
      ),
    ]),
  );

  /** Resolves exact collection/entity operations from their generated paths and keeps uploaded Asset references current in saved Posts. */
  function respond(
    operation: PreviewOperation,
    request: Request,
    params: Parameters,
    input: PreviewObject,
  ): PreviewResponse | undefined {
    const collection = owners.get(operation.operationId);
    if (!collection) return undefined;
    const suffix = operation.path.slice(collection.path.length);
    const parameter = /^\/\{([^}]+)\}$/.exec(suffix)?.[1];
    const id = parameter ? params[parameter] : undefined;
    const item = collection.items.find((item) => item.id === id || item.user_id === id);
    if (operation.method === "get" && suffix === "") {
      const query = new URL(request.url).searchParams;
      const filtered = collection.items.filter((item) =>
        ["brand_profile_id", "post_id", "platform_account_id", "status"].every(
          (key) => !query.has(key) || item[key] === query.get(key),
        ),
      );
      const limit = Math.min(
        100,
        Math.max(
          1,
          Number(query.get("limit")) ||
            (typeof collection.envelope.limit === "number" ? collection.envelope.limit : 60),
        ),
      );
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      return {
        status: operation.success.status,
        body: {
          ...collection.envelope,
          [collection.field]: Object.hasOwn(collection.envelope, "limit")
            ? filtered.slice(offset, offset + limit)
            : filtered,
          ...(Object.hasOwn(collection.envelope, "has_more")
            ? { has_more: offset + limit < filtered.length, limit, offset }
            : {}),
        },
      };
    }
    if (operation.method === "get" && parameter)
      return item ? { status: operation.success.status, body: item } : { status: 404 };
    if (operation.method === "delete" && parameter) {
      if (!item) return { status: 404 };
      collection.items.splice(collection.items.indexOf(item), 1);
      if (typeof item.id === "string")
        for (const related of collections)
          for (let index = related.items.length - 1; index >= 0; index--)
            if (related.items[index]?.post_id === item.id) related.items.splice(index, 1);
      return {
        status: operation.success.status,
        ...(operation.success.body === undefined ? {} : { body: item }),
      };
    }
    const creating = operation.method === "post" && suffix === "";
    if (!creating && !(operation.method === "patch" && parameter)) return undefined;
    if (!creating && !item) return { status: 404 };
    const base = creating ? operation.success.body : item;
    if (base === undefined) return undefined;
    const merged = mergeExample(base, input);
    if (merged === null || typeof merged !== "object" || Array.isArray(merged)) return undefined;
    if (creating && "id" in merged) merged.id = crypto.randomUUID();
    if ("revision" in merged && typeof merged.revision === "number" && !creating) merged.revision++;
    if ("updated_at" in merged) merged.updated_at = new Date().toISOString();
    if (Array.isArray(input.attachment_ids) && "attachments" in merged) {
      merged.attachments = input.attachment_ids.flatMap((assetId, position) => {
        const asset = typeof assetId === "string" ? assets.get(assetId) : undefined;
        return asset ? [{ asset_id: assetId, position, asset }] : [];
      });
    }
    if (creating) collection.items.unshift(merged);
    else if (item) Object.assign(item, merged);
    return { status: operation.success.status, body: merged };
  }
  return respond;
}
