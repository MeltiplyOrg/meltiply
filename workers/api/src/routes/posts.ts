import { Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import { requireActor } from "../authorization";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import type { PostTargetInput, SchedulePostInput } from "../post-types";
import { conditionalJsonResponse, idempotencyHeaders, jsonResponse } from "../responses";
import {
  dateField,
  dateRange,
  enumParam,
  idempotencyKey,
  integerParam,
  jsonBody,
  onlyKeys,
  optionalStringField,
  parseProviderOptionsField,
  POST_STATUS_VALUES,
  postTextField,
  postTitleField,
  stringArrayField,
  stringField,
  uuidArrayField,
  uuidParam,
} from "../validation";
import { optionalBrandProfileParam, type CoreRouteServices } from "./shared";

function postTarget(body: Record<string, unknown>): PostTargetInput {
  onlyKeys(body, [
    "platform_account_id",
    "title_override",
    "description_override",
    "hashtags",
    "provider_options",
    "signature",
    "attachment_ids",
  ]);
  const signature = optionalStringField(body, "signature");
  if (signature !== null && signature !== undefined && signature.length > 1_000) {
    throw new CoreApiError(400, "validation_error", "signature is too long.");
  }
  return {
    attachmentIds: uuidArrayField(body, "attachment_ids"),
    descriptionOverride: optionalStringField(body, "description_override"),
    hashtags: stringArrayField(body, "hashtags"),
    platformAccountId: uuidParam(stringField(body, "platform_account_id"), "platform_account_id"),
    providerOptions: parseProviderOptionsField(body),
    signature: signature ?? null,
    titleOverride: optionalStringField(body, "title_override"),
  };
}

function postTargets(body: Record<string, unknown>): PostTargetInput[] | undefined {
  const value = body.targets;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "targets must be an array.");
  }
  if (value.length > 20) {
    throw new CoreApiError(400, "validation_error", "targets must contain at most 20 entries.");
  }
  return value.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new CoreApiError(400, "validation_error", "Each target must be an object.");
    }
    return postTarget(target as Record<string, unknown>);
  });
}

function postComposition(body: Record<string, unknown>): {
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
} {
  onlyKeys(body, ["brand_profile_id", "title", "default_text", "attachment_ids", "targets"]);
  return {
    attachmentIds: uuidArrayField(body, "attachment_ids") ?? undefined,
    brandProfileId: uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
    defaultText: postTextField(body, "default_text"),
    targets: postTargets(body),
    title: postTitleField(body, "title"),
  };
}

export function registerPostRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/posts", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const status = yield* fromPromise(() =>
          enumParam(c.req.query("status"), "status", POST_STATUS_VALUES),
        );
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const queueId = c.req.query("queue_id");
        if (queueId !== undefined) yield* fromPromise(() => uuidParam(queueId, "queue_id"));
        const from = c.req.query("queue_assigned_from");
        const before = c.req.query("queue_assigned_before");
        const queueWindow =
          from === undefined && before === undefined
            ? undefined
            : yield* fromPromise(() => {
                if (!queueId) {
                  throw new CoreApiError(
                    400,
                    "invalid_request",
                    "Queue assignment windows require queue_id.",
                  );
                }
                return dateRange(from, before, 63);
              });
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const postService = yield* fromPromise(services.posts);
        const result = yield* postService.listPosts(c.env, requireActor(c).claims, {
          ...(brandProfileId ? { brandProfileId } : {}),
          ...(queueId ? { queueId } : {}),
          ...(queueWindow ? { queueWindow } : {}),
          limit,
          offset,
          ...(status ? { status } : {}),
        });
        return jsonResponse(result, 200, c.get("requestId"));
      }),
    ),
  );

  app.post("/api/v1/posts", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* fromPromise(() => postComposition(body));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(services.posts);
        const result = yield* postService.createPost(
          c.env,
          requireActor(c).claims,
          input,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 201, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const postService = yield* fromPromise(services.posts);
        const post = yield* postService.getPost(c.env, requireActor(c).claims, postId);
        return yield* fromPromise(() => conditionalJsonResponse(c, post));
      }),
    ),
  );

  app.patch("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* fromPromise(() => postComposition(body));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(services.posts);
        const result = yield* postService.updatePost(
          c.env,
          requireActor(c).claims,
          postId,
          input,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["brand_profile_id"]));
        const input = {
          brandProfileId: yield* fromPromise(() =>
            uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
          ),
        };
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(services.posts);
        const result = yield* postService.deletePost(
          c.env,
          requireActor(c).claims,
          postId,
          input,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/posts/:postId/schedule", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() =>
          onlyKeys(body, ["brand_profile_id", "scheduled_at", "queue_id", "targets"]),
        );
        if ("scheduled_at" in body === "queue_id" in body) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "validation_error",
              "Supply exactly one of scheduled_at or queue_id.",
            ),
          );
        }
        const input: SchedulePostInput = yield* fromPromise(() => ({
          brandProfileId: uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
          targets: postTargets(body),
          ...(body.queue_id !== undefined
            ? { queueId: uuidParam(stringField(body, "queue_id"), "queue_id") }
            : { scheduledAt: body.scheduled_at === null ? null : dateField(body, "scheduled_at") }),
        }));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(services.posts);
        const result = yield* postService.schedulePost(
          c.env,
          requireActor(c).claims,
          postId,
          input,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
}
