import { Effect } from "effect";
import type { Hono } from "hono";
import { CoreApiError } from "./core-types";
import type { ApiWorkerEnvironment } from "./env";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import { idempotencyHeaders } from "./idempotent-response";
import { createPublishingQueueApiService, type PublishingQueueApiService } from "./publishing-queue-service";
import { queueConfigurationSchema, queuePatchSchema, queueScopeSchema } from "./publishing-queue-store";
import { jsonResponse } from "./responses";
import { idempotencyKey, integerParam, jsonBody, stringField, uuidParam } from "./validation";

/** Registers the strict Queue HTTP seam. Schema validation precedes tenant writes; dependencies are constructed without capturing request state. */
export function registerPublishingQueueRoutes(app: Hono<ApiWorkerEnvironment>, configured?: PublishingQueueApiService): void {
  const api = configured ?? createPublishingQueueApiService();
  app.get("/api/v1/queues", (c) => runRouteEffect(c, Effect.gen(function* () {
    const brandProfileId = yield* fromPromise(() => uuidParam(c.req.query("brand_profile_id"), "brand_profile_id"));
    const limit = yield* fromPromise(() => integerParam(c.req.query("limit"), "limit", 20, 1, 100));
    const cursor = c.req.query("cursor");
    if (cursor !== undefined) yield* fromPromise(() => uuidParam(cursor, "cursor"));
    return jsonResponse(yield* api.list(c.env, c.get("actor").claims, brandProfileId, limit, cursor), 200, c.get("requestId"));
  })));
  app.get("/api/v1/queues/:queueId", (c) => runRouteEffect(c, Effect.gen(function* () {
    const id = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
    return jsonResponse(yield* api.get(c.env, c.get("actor").claims, id), 200, c.get("requestId"));
  })));
  for (const action of ["create", "update", "delete"] as const) {
    const method = action === "create" ? "POST" : action === "update" ? "PATCH" : "DELETE";
    app.on(method, action === "create" ? "/api/v1/queues" : "/api/v1/queues/:queueId", (c) => runRouteEffect(c, Effect.gen(function* () {
      const id = action === "create" ? undefined : yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
      const body = yield* fromPromise(() => jsonBody(c));
      const parsed = (action === "create" ? queueConfigurationSchema : action === "update" ? queuePatchSchema : queueScopeSchema).safeParse(body);
      if (!parsed.success) return yield* Effect.fail(new CoreApiError(422, "validation_error", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")));
      const key = yield* fromPromise(() => idempotencyKey(c));
      const result = yield* api.mutate(c.env, c.get("actor").claims, action, id, parsed.data, key);
      const headers = { ...idempotencyHeaders(result.replayed), "X-Request-ID": c.get("requestId") };
      return action === "delete" ? new Response(null, { status: 204, headers }) : jsonResponse(result.value, action === "create" ? 201 : 200, c.get("requestId"), headers);
    })));
  }
  app.delete("/api/v1/queues/:queueId/posts/:postId", (c) => runRouteEffect(c, Effect.gen(function* () {
    const queueId = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
    const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
    const body = yield* fromPromise(() => jsonBody(c));
    const parsed = queueScopeSchema.safeParse(body);
    if (!parsed.success) return yield* Effect.fail(new CoreApiError(422, "validation_error", "Supply only the owning brand_profile_id."));
    const brandProfileId = yield* fromPromise(() => uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"));
    const key = yield* fromPromise(() => idempotencyKey(c));
    const result = yield* api.removePost(c.env, c.get("actor").claims, queueId, postId, brandProfileId, key);
    return jsonResponse(result.value, 200, c.get("requestId"), idempotencyHeaders(result.replayed));
  })));
}
