import { Effect } from "effect";
import { requireActor } from "../authorization";
import type { Context, Hono } from "hono";

import type { AnalyticsFilters } from "../core-types";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import { jsonResponse } from "../responses";
import {
  analyticsFormatParam,
  analyticsMetricParam,
  dateRange,
  integerParam,
  optionalDateParam,
  platformParam,
  uuidParam,
  validateDateSpan,
} from "../validation";
import { optionalBrandProfileParam, type CoreRouteServices } from "./shared";

function parseAnalyticsFilters(c: Context<ApiWorkerEnvironment>): AnalyticsFilters {
  const requested = dateRange(c.req.query("start"), c.req.query("end"), 366);
  const platformValue = c.req.query("platform");
  const platform = platformValue ? platformParam(platformValue) : undefined;
  const brandProfileId = optionalBrandProfileParam(c);
  const accountValue = c.req.query("account_id");
  const accountId = accountValue ? uuidParam(accountValue, "account_id") : undefined;
  const format = analyticsFormatParam(c.req.query("format"));
  return {
    ...requested,
    ...(platform ? { platform } : {}),
    ...(brandProfileId ? { brandProfileId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(format ? { format } : {}),
  };
}

export function registerAnalyticsRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/analytics", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const filters = yield* fromPromise(() => parseAnalyticsFilters(c));
        const core = yield* fromPromise(services.service);
        const summary = yield* core.summaryAnalytics(c.env, requireActor(c).claims, filters);
        return jsonResponse(summary, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/analytics/posts", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const filters = yield* fromPromise(() => parseAnalyticsFilters(c));
        const metric = yield* fromPromise(() => analyticsMetricParam(c.req.query("metric")));
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 10, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 2_147_483_647),
        );
        const core = yield* fromPromise(services.service);
        const posts = yield* core.analyticsPosts(c.env, requireActor(c).claims, {
          ...filters,
          limit,
          metric,
          offset,
        });
        return jsonResponse(posts, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/analytics/dashboard", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const filters = yield* fromPromise(() => parseAnalyticsFilters(c));
        const core = yield* fromPromise(services.service);
        const dashboard = yield* core.dashboardAnalytics(c.env, requireActor(c).claims, filters);
        return jsonResponse(dashboard, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/analytics/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const start = yield* fromPromise(() => optionalDateParam(c.req.query("start"), "start"));
        const end = yield* fromPromise(() => optionalDateParam(c.req.query("end"), "end"));
        if (start && end) {
          yield* fromPromise(() => validateDateSpan(start, end, 366));
        }
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 100, 1, 500),
        );
        const core = yield* fromPromise(services.service);
        const snapshots = yield* core.distributionAnalytics(
          c.env,
          requireActor(c).claims,
          distributionId,
          { end, limit, start },
        );
        return jsonResponse({ snapshots }, 200, c.get("requestId"));
      }),
    ),
  );
}
