import { Schema } from "effect";
import {
  previewObjectSchema,
  type PreviewObject,
  type PreviewValue,
} from "./src/preview/contract-types";

/** Resolves local OpenAPI references at build time. External/missing references fail explicitly instead of creating misleading mock responses. */
export function resolvePreviewReference(value: unknown, document: PreviewObject): PreviewObject {
  const object = Schema.decodeUnknownSync(previewObjectSchema)(value);
  if (typeof object.$ref !== "string") return object;
  if (!object.$ref.startsWith("#/"))
    throw new Error(`Unsupported external preview reference: ${object.$ref}`);
  let target: PreviewValue = document;
  for (const segment of object.$ref.slice(2).split("/")) {
    if (target === null || typeof target !== "object" || Array.isArray(target))
      throw new Error(`Missing preview reference: ${object.$ref}`);
    const next: PreviewValue | undefined = target[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (next === undefined) throw new Error(`Missing preview reference: ${object.$ref}`);
    target = next;
  }
  return resolvePreviewReference(target, document);
}

/** Builds deterministic examples only when the canonical catalog lacks a documented response. Existing examples/defaults/enums win; required fields, local refs, unions, and collection bounds follow the schema. */
export function exampleForSchema(value: unknown, document: PreviewObject, depth = 0): PreviewValue {
  if (depth > 32) throw new Error("Recursive preview response schema needs a canonical example");
  const schema = resolvePreviewReference(value, document);
  for (const key of ["example", "const", "default"])
    if (schema[key] !== undefined) return schema[key];
  if (Array.isArray(schema.enum) && schema.enum[0] !== undefined) return schema.enum[0];
  for (const union of [schema.oneOf, schema.anyOf])
    if (Array.isArray(union) && union.length) {
      const preferred = union.find(
        (variant) =>
          variant !== null &&
          typeof variant === "object" &&
          !Array.isArray(variant) &&
          variant.type !== "null",
      );
      return exampleForSchema(preferred ?? union[0], document, depth + 1);
    }
  if (Array.isArray(schema.allOf)) {
    const result: PreviewObject = {};
    for (const part of schema.allOf) {
      const example = exampleForSchema(part, document, depth + 1);
      if (example !== null && typeof example === "object" && !Array.isArray(example))
        Object.assign(result, example);
    }
    return result;
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type;
  if (type === "null") return null;
  if (type === "boolean") return false;
  if (type === "number" || type === "integer")
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (type === "array")
    return Array.from({ length: typeof schema.minItems === "number" ? schema.minItems : 0 }, () =>
      exampleForSchema(schema.items ?? {}, document, depth + 1),
    );
  if (type === "object" || schema.properties !== undefined) {
    const properties = Schema.decodeUnknownSync(previewObjectSchema)(schema.properties ?? {});
    const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
    return Object.fromEntries(
      required
        .filter((key): key is string => typeof key === "string")
        .map((key) => [key, exampleForSchema(properties[key] ?? {}, document, depth + 1)]),
    );
  }
  if (type === "string") {
    if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
    if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
    if (schema.format === "date") return "2026-01-01";
    if (schema.format === "email") return "preview@example.test";
    if (schema.format === "uri" || schema.format === "url")
      return "https://preview.invalid/resource";
    const minimum = typeof schema.minLength === "number" ? schema.minLength : 1;
    const maximum = typeof schema.maxLength === "number" ? schema.maxLength : Math.max(7, minimum);
    return "preview".padEnd(minimum, "x").slice(0, maximum);
  }
  return {};
}
