import { Effect } from "effect";
import type { Hono } from "hono";
import type { z } from "zod";

import { CoreApiError } from "./api-errors";
import { requireActor } from "./authorization";
import type { ApiWorkerEnvironment } from "./env";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import type { PublishingQueueApiService } from "./publishing-queue-service";
import { idempotencyHeaders, jsonResponse, noContentResponse } from "./responses";
import {
  idempotencyKey,
  integerParam,
  jsonBody,
  queueConfigurationSchema,
  queuePatchSchema,
  queueScopeSchema,
  uuidParam,
} from "./validation";

function parseQueueSchema<S extends z.ZodType>(
  schema: S,
  body: Record<string, unknown>,
  fallbackMessage?: string,
): Effect.Effect<z.infer<S>, CoreApiError> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return Effect.succeed(parsed.data);
  return Effect.fail(
    new CoreApiError(
      422,
      "validation_error",
      fallbackMessage ??
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    ),
  );
}

export function registerPublishingQueueRoutes(
  app: Hono<ApiWorkerEnvironment>,
  configured?: PublishingQueueApiService,
): void {
  let servicePromise: Promise<PublishingQueueApiService> | undefined;
  const queues = async (): Promise<PublishingQueueApiService> => {
    if (configured) return configured;
    servicePromise ??= import("./publishing-queue-service").then((module) =>
      module.createPublishingQueueApiService(),
    );
    return servicePromise;
  };

  app.get("/api/v1/queues", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileId = yield* fromPromise(() =>
          uuidParam(c.req.query("brand_profile_id") ?? "", "brand_profile_id"),
        );
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const cursor = c.req.query("cursor");
        if (cursor !== undefined) yield* fromPromise(() => uuidParam(cursor, "cursor"));
        const api = yield* fromPromise(queues);
        return jsonResponse(
          yield* api.list(c.env, requireActor(c).claims, brandProfileId, limit, cursor),
          200,
          c.get("requestId"),
        );
      }),
    ),
  );

  app.get("/api/v1/queues/:queueId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const id = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
        const api = yield* fromPromise(queues);
        return jsonResponse(
          yield* api.get(c.env, requireActor(c).claims, id),
          200,
          c.get("requestId"),
        );
      }),
    ),
  );

  app.post("/api/v1/queues", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* parseQueueSchema(queueConfigurationSchema, body);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const api = yield* fromPromise(queues);
        const result = yield* api.createQueue(c.env, requireActor(c).claims, input, key);
        return jsonResponse(
          result.value,
          201,
          c.get("requestId"),
          idempotencyHeaders(result.replayed),
        );
      }),
    ),
  );

  app.patch("/api/v1/queues/:queueId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const id = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* parseQueueSchema(queuePatchSchema, body);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const api = yield* fromPromise(queues);
        const result = yield* api.updateQueue(c.env, requireActor(c).claims, id, input, key);
        return jsonResponse(
          result.value,
          200,
          c.get("requestId"),
          idempotencyHeaders(result.replayed),
        );
      }),
    ),
  );

  app.delete("/api/v1/queues/:queueId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const id = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* parseQueueSchema(queueScopeSchema, body);
        const key = yield* fromPromise(() => idempotencyKey(c));
        const api = yield* fromPromise(queues);
        const result = yield* api.deleteQueue(c.env, requireActor(c).claims, id, input, key);
        return noContentResponse(c.get("requestId"), idempotencyHeaders(result.replayed));
      }),
    ),
  );

  app.delete("/api/v1/queues/:queueId/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const queueId = yield* fromPromise(() => uuidParam(c.req.param("queueId"), "queue_id"));
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* parseQueueSchema(
          queueScopeSchema,
          body,
          "Supply only the owning brand_profile_id.",
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const api = yield* fromPromise(queues);
        const result = yield* api.removePost(
          c.env,
          requireActor(c).claims,
          queueId,
          postId,
          input.brand_profile_id,
          key,
        );
        return jsonResponse(
          result.value,
          200,
          c.get("requestId"),
          idempotencyHeaders(result.replayed),
        );
      }),
    ),
  );
}
