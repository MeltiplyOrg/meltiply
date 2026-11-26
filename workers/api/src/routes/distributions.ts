import { createProviderServiceLive } from "@meltiply/providers";
import { Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import { endBroadcastEffect, readBroadcastEffect } from "../broadcast-service";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import {
  conditionalJsonResponse,
  idempotencyHeaders,
  jsonResponse,
  noContentResponse,
} from "../responses";
import {
  dateField,
  dateRange,
  DISTRIBUTION_STATUS_VALUES,
  enumParam,
  idempotencyKey,
  integerParam,
  jsonBody,
  onlyKeys,
  optionalDateParam,
  optionalStringField,
  platformParam,
  stringArrayField,
  uuidParam,
} from "../validation";
import { optionalBrandProfileParam, type CoreRouteServices } from "./shared";

export function registerDistributionRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/distributions", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const platformValue = c.req.query("platform");
        const postId = c.req.query("post_id");
        const start = yield* fromPromise(() => optionalDateParam(c.req.query("start"), "start"));
        const end = yield* fromPromise(() => optionalDateParam(c.req.query("end"), "end"));
        if (start && end && end < start) {
          return yield* Effect.fail(
            new CoreApiError(400, "invalid_range", "end must be at or after start."),
          );
        }
        const status = yield* fromPromise(() =>
          enumParam(c.req.query("status"), "status", DISTRIBUTION_STATUS_VALUES),
        );
        const validatedPostId = postId
          ? yield* fromPromise(() => uuidParam(postId, "post_id"))
          : undefined;
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const validatedPlatform = platformValue
          ? yield* fromPromise(() => platformParam(platformValue))
          : undefined;
        const core = yield* fromPromise(services.service);
        const distributions = yield* core.listDistributions(c.env, c.get("actor").claims, {
          ...(validatedPostId ? { postId: validatedPostId } : {}),
          ...(brandProfileId ? { brandProfileId } : {}),
          end,
          limit,
          offset,
          ...(validatedPlatform ? { platform: validatedPlatform } : {}),
          ...(status ? { status } : {}),
          start,
        });
        return jsonResponse(distributions, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/distributions/:distributionId/broadcast", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const session = c.get("actor").claims;
        const details = yield* readBroadcastEffect(
          c.env,
          session,
          yield* fromPromise(() => uuidParam(c.req.param("distributionId"), "distribution_id")),
          c.get("requestId"),
        );
        return jsonResponse(details, 200, c.get("requestId"), { "Cache-Control": "no-store" });
      }).pipe(Effect.provide(createProviderServiceLive(services.registry()))),
    ),
  );

  app.post("/api/v1/distributions/:distributionId/broadcast/end", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const session = c.get("actor").claims;
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        yield* fromPromise(() => idempotencyKey(c));
        const result = yield* endBroadcastEffect(
          c.env,
          session,
          distributionId,
          c.get("requestId"),
        );
        return jsonResponse(result, 200, c.get("requestId"), { "Cache-Control": "no-store" });
      }).pipe(Effect.provide(createProviderServiceLive(services.registry()))),
    ),
  );

  app.get("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const core = yield* fromPromise(services.service);
        const distribution = yield* core.getDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
        );
        return yield* fromPromise(() => conditionalJsonResponse(c, distribution));
      }),
    ),
  );

  app.patch("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() =>
          onlyKeys(body, ["scheduled_at", "title_override", "description_override", "hashtags"]),
        );
        const scheduledAt =
          body.scheduled_at === undefined
            ? undefined
            : yield* fromPromise(() => dateField(body, "scheduled_at"));
        const patch = {
          ...(scheduledAt !== undefined ? { scheduledAt } : {}),
          ...(body.title_override !== undefined
            ? {
                titleOverride: yield* fromPromise(() =>
                  optionalStringField(body, "title_override"),
                ),
              }
            : {}),
          ...(body.description_override !== undefined
            ? {
                descriptionOverride: yield* fromPromise(() =>
                  optionalStringField(body, "description_override"),
                ),
              }
            : {}),
          ...(body.hashtags !== undefined
            ? {
                hashtags: yield* fromPromise(() => stringArrayField(body, "hashtags")),
              }
            : {}),
        };
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(services.service);
        const result = yield* core.updateDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          patch,
          key,
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(services.service);
        const result = yield* core.cancelDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          key,
          c.get("requestId"),
        );
        if (result.status === 204) {
          return noContentResponse(c.get("requestId"), idempotencyHeaders(result.replayed));
        }
        return jsonResponse(result.value, 202, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/distributions/:distributionId/retry", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(services.service);
        const result = yield* core.retryDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          key,
          c.get("requestId"),
        );
        return jsonResponse(result.value, 202, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/calendar", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const requested = yield* fromPromise(() =>
          dateRange(c.req.query("start"), c.req.query("end"), 63),
        );
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 500, 1, 1_000),
        );
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const core = yield* fromPromise(services.service);
        const events = yield* core.calendar(
          c.env,
          c.get("actor").claims,
          requested.start,
          requested.end,
          limit,
          brandProfileId,
        );
        return jsonResponse({ events }, 200, c.get("requestId"));
      }),
    ),
  );
}
