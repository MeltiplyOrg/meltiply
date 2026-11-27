import { Effect, Exit } from "effect";
import type { components } from "@meltiply/contracts/schema";
import type { SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  ActiveOrganizationRequiredError,
  type DatabaseError,
  isoDateTime,
  isoDateTimeOrNull,
} from "@meltiply/domain";

import { AnalyticsSummaryCache, type AnalyticsSummaryFlight } from "./analytics-summary-cache";
import { CoreApiError } from "./api-errors";
import { activeBrandProfilePredicate } from "./brand-profile-guard";
import type {
  AnalyticsFilters,
  AnalyticsPostsFilters,
  CoreServiceError,
  SnapshotFilters,
} from "./core-types";
import { withTenantTransactionEffect as defaultTenantTransaction } from "./database";
import type { ApiWorkerEnv } from "./env";

type Schemas = components["schemas"];
type AnalyticsSnapshot = Schemas["AnalyticsSnapshot"];
type AnalyticsSummary = Schemas["AnalyticsSummary"];
type Platform = Schemas["Platform"];
type PlatformCapability = Schemas["PlatformCapability"];

type AnalyticsSummaryTransactionResult =
  | { kind: "ready"; summary: AnalyticsSummary }
  | { kind: "pending"; promise: AnalyticsSummaryFlight["promise"] };

interface AnalyticsRow extends Record<string, unknown> {
  comments: number | string;
  impressions: number | string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platform: Platform;
  post_count: number | string;
  reach: number | string;
  shares: number | string;
  views: number | string;
  watch_time_sec: number | string;
}

interface AnalyticsPostRow extends Record<string, unknown> {
  comments: number | string;
  destination_count: number | string;
  excerpt: string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platforms: Platform[];
  post_id: string;
  published_at: Date | string;
  shares: number | string;
  synced_destination_count: number | string;
  title: string;
  views: number | string;
}

interface AnalyticsSeriesRow extends Record<string, unknown> {
  comments: number | string;
  date: string;
  impressions: number | string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platform: Platform;
  posts: number | string;
  reach: number | string;
  shares: number | string;
  views: number | string;
}

interface AnalyticsBestTimeRow extends Record<string, unknown> {
  avg_comments: number | string;
  avg_engagement: number | string;
  avg_likes: number | string;
  avg_shares: number | string;
  avg_views: number | string;
  day_of_week: number | string;
  hour: number | string;
  posts: number | string;
}

interface AnalyticsFormatRow extends Record<string, unknown> {
  comments: number | string;
  engagement: number | string;
  format: Schemas["AnalyticsFormat"];
  last_synced_at: Date | string | null;
  likes: number | string;
  posts: number | string;
  shares: number | string;
  views: number | string;
}

interface AnalyticsPlatformRow extends Record<string, unknown> {
  clicks: number | string | null;
  comments: number | string;
  engagement_rate: number | string | null;
  impressions: number | string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platform: Platform;
  posts: number | string;
  reach: number | string;
  saves: number | string | null;
  shares: number | string;
  views: number | string;
  watch_time_sec: number | string;
}

interface AnalyticsAggregateRow extends Record<string, unknown> {
  best_times: AnalyticsBestTimeRow[];
  formats: AnalyticsFormatRow[];
  platforms: AnalyticsPlatformRow[];
}

interface AnalyticsFollowerRow extends Record<string, unknown> {
  account_id: string;
  account_name: string | null;
  captured_at: Date | string;
  followers: number | string;
  platform: Platform;
}

interface AnalyticsAccumulationRow extends Record<string, unknown> {
  avg_engagement: number | string;
  elapsed_hours: number | string;
  observations: number | string;
}

interface AnalyticsSnapshotRow extends Record<string, unknown> {
  comments: number | string;
  distribution_id: string;
  id: string;
  impressions: number | string;
  likes: number | string;
  post_id: string;
  reach: number | string;
  shares: number | string;
  snapshot_at: Date | string;
  views: number | string;
  watch_time_sec: number | string;
}

interface DistributionAnalyticsRow extends Record<string, unknown> {
  comments: number | string | null;
  distribution_id: string;
  id: string | null;
  impressions: number | string | null;
  likes: number | string | null;
  post_id: string;
  reach: number | string | null;
  shares: number | string | null;
  snapshot_at: Date | string | null;
  views: number | string | null;
  watch_time_sec: number | string | null;
}

interface AnalyticsAccess {
  organizationId: string;
  role: string | null;
  visibility: string;
}

const ANALYTICS_POST_SORT_COLUMNS = {
  comments: "pp.comments",
  likes: "pp.likes",
  shares: "pp.shares",
  views: "pp.views",
} as const satisfies Record<Schemas["AnalyticsMetric"], string>;

function number(value: number | string | null): number {
  return value === null ? 0 : Number(value);
}

function analyticsFormatExpression(alias: string): string {
  return `CASE
    WHEN COALESCE(array_length(${alias}.attachment_ids, 1), 0) = 0 THEN 'text'
    WHEN array_length(${alias}.attachment_ids, 1) > 1 THEN 'carousel'
    WHEN EXISTS (
      SELECT 1 FROM assets AS format_asset
      WHERE format_asset.id = ${alias}.attachment_ids[1]
        AND format_asset.asset_type = 'video'
    ) THEN 'video'
    ELSE 'image'
  END`;
}

function publishedDistributionCandidatesSql(selectColumns: string): string {
  return `SELECT ${selectColumns}
          FROM distributions d
          WHERE d.status = 'published'
            AND d.published_at >= $1
            AND d.published_at <= $2
            AND ($3::text IS NULL OR d.platform = $3)
            AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
            AND ($5::uuid IS NULL OR d.platform_account_id = $5)
            AND ($6::text IS NULL OR ${analyticsFormatExpression("d")} = $6)
            AND ${activeBrandProfilePredicate("d.brand_profile_id")}`;
}

function analyticsFilterParams(filters: AnalyticsFilters): readonly unknown[] {
  return [
    filters.start,
    filters.end,
    filters.platform ?? null,
    filters.brandProfileId ?? null,
    filters.accountId ?? null,
    filters.format ?? null,
  ];
}

function sumAnalyticsTotals(
  rows: readonly {
    comments: number;
    impressions: number;
    likes: number;
    post_count: number;
    reach: number;
    shares: number;
    views: number;
    watch_time_sec: number;
  }[],
): AnalyticsSummary["totals"] {
  return rows.reduce(
    (totals, row) => ({
      comments: totals.comments + row.comments,
      impressions: totals.impressions + row.impressions,
      likes: totals.likes + row.likes,
      post_count: totals.post_count + row.post_count,
      reach: totals.reach + row.reach,
      shares: totals.shares + row.shares,
      views: totals.views + row.views,
      watch_time_sec: totals.watch_time_sec + row.watch_time_sec,
    }),
    {
      comments: 0,
      impressions: 0,
      likes: 0,
      post_count: 0,
      reach: 0,
      shares: 0,
      views: 0,
      watch_time_sec: 0,
    },
  );
}

function analyticsAccessEffect(
  client: EffectTransactionClient,
  brandProfileId: string | undefined,
): Effect.Effect<AnalyticsAccess, DatabaseError | ActiveOrganizationRequiredError> {
  return Effect.gen(function* () {
    const result = yield* client.query<{
      organization_id: string | null;
      role: string | null;
      visibility: string | null;
    }>(
      `SELECT
         access_scope.organization_id,
         access_scope.role,
         encode(sha256(convert_to(COALESCE(
           (
             SELECT string_agg(
               bp.id::text
                 || ':' || extract(epoch FROM bp.updated_at)::text
                 || ':' || COALESCE(extract(epoch FROM bp.deleted_at)::text, ''),
               '|' ORDER BY bp.id
             )
             FROM brand_profiles bp
             WHERE ($1::uuid IS NULL OR bp.id = $1)
               AND ($1::uuid IS NOT NULL OR bp.deleted_at IS NULL)
           ),
           ''
         ), 'UTF8')), 'hex') AS visibility
       FROM (
         SELECT
           public.auth_active_org_id()::text AS organization_id,
           public.auth_active_org_role() AS role
       ) AS access_scope`,
      [brandProfileId ?? null],
    );
    const row = result.rows[0];
    if (!row || !row.organization_id) {
      return yield* Effect.fail(
        new ActiveOrganizationRequiredError({
          message: "The authenticated identity is not an active organization member.",
        }),
      );
    }
    return {
      organizationId: row.organization_id,
      role: row.role ?? null,
      visibility: row.visibility ?? "",
    };
  });
}

function analyticsCapabilityNamespace(
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
): string {
  return [...capabilities.values()]
    .map((capability) => `${capability.platform}:${capability.analytics ? "1" : "0"}`)
    .sort()
    .join(",");
}

function stableStringChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function analyticsDeploymentNamespace(env: ApiWorkerEnv): string {
  const connectionString = env.DB_AUTHENTICATED?.connectionString ?? "";
  let dataSource = "unbound";
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      dataSource = `${url.host}${url.pathname}`;
    } catch {
      dataSource = `unparsed:${connectionString.length}:${stableStringChecksum(connectionString)}`;
    }
  }
  return `${env.ENVIRONMENT}|${env.VERSION}|${dataSource}`;
}

function analyticsSummaryCacheKey(
  access: AnalyticsAccess,
  filters: AnalyticsFilters,
  namespace: string,
  session: SessionClaims,
): string {
  return JSON.stringify([
    namespace,
    access.organizationId,
    session.subject,
    session.userId ?? null,
    access.role,
    filters.brandProfileId?.toLowerCase() ?? null,
    access.visibility,
    filters.platform ?? null,
    filters.accountId?.toLowerCase() ?? null,
    filters.format ?? null,
    filters.start.getTime(),
    filters.end.getTime(),
  ]);
}

export function mapSnapshot(row: AnalyticsSnapshotRow): AnalyticsSnapshot {
  return {
    comments: number(row.comments),
    distribution_id: row.distribution_id,
    id: row.id,
    impressions: number(row.impressions),
    likes: number(row.likes),
    reach: number(row.reach),
    shares: number(row.shares),
    post_id: row.post_id,
    snapshot_at: isoDateTime(row.snapshot_at),
    views: number(row.views),
    watch_time_sec: number(row.watch_time_sec),
  };
}

function computeAnalyticsSummaryEffect(
  client: EffectTransactionClient,
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
  filters: AnalyticsFilters,
): Effect.Effect<AnalyticsSummary, DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* client.query<AnalyticsRow>(
      `WITH candidates AS (
         ${publishedDistributionCandidatesSql("d.id, d.platform")}
       )
       SELECT
         c.platform,
         COALESCE(SUM(latest.views), 0) AS views,
         COALESCE(SUM(latest.likes), 0) AS likes,
         COALESCE(SUM(latest.comments), 0) AS comments,
         COALESCE(SUM(latest.shares), 0) AS shares,
         COALESCE(SUM(latest.watch_time_sec), 0) AS watch_time_sec,
         COALESCE(SUM(latest.reach), 0) AS reach,
         COALESCE(SUM(latest.impressions), 0) AS impressions,
         COUNT(*) AS post_count,
         MAX(latest.snapshot_at) AS last_synced_at
       FROM candidates c
       LEFT JOIN LATERAL (
         SELECT
           s.views, s.likes, s.comments, s.shares,
           s.watch_time_sec, s.reach, s.impressions, s.snapshot_at
         FROM analytics_snapshots s
         WHERE s.distribution_id = c.id
           AND s.snapshot_at <= $2
         ORDER BY s.snapshot_at DESC, s.id DESC
         LIMIT 1
       ) latest ON true
       GROUP BY c.platform
       ORDER BY c.platform ASC`,
      analyticsFilterParams(filters),
    );
    const unsupportedPlatforms = result.rows
      .map((row) => row.platform)
      .filter((platform) => !capabilities.get(platform)?.analytics);
    const lastSynced = result.rows.reduce<number | null>((latest, row) => {
      if (!row.last_synced_at) return latest;
      const timestamp = new Date(row.last_synced_at).getTime();
      return latest === null || timestamp > latest ? timestamp : latest;
    }, null);
    const byPlatform = result.rows.map((row) => ({
      comments: number(row.comments),
      impressions: number(row.impressions),
      last_synced_at: isoDateTimeOrNull(row.last_synced_at),
      likes: number(row.likes),
      platform: row.platform,
      post_count: number(row.post_count),
      reach: number(row.reach),
      shares: number(row.shares),
      views: number(row.views),
      watch_time_sec: number(row.watch_time_sec),
    }));
    return {
      by_platform: byPlatform,
      last_synced_at: lastSynced === null ? null : new Date(lastSynced).toISOString(),
      partial: unsupportedPlatforms.length > 0,
      range: {
        end: filters.end.toISOString(),
        start: filters.start.toISOString(),
      },
      totals: sumAnalyticsTotals(byPlatform),
      unsupported_platforms: unsupportedPlatforms,
    };
  });
}

export function createAnalyticsMethods(
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
  withTenantTransactionEffect = defaultTenantTransaction,
  now: () => Date = () => new Date(),
) {
  const capabilityNamespace = analyticsCapabilityNamespace(capabilities);
  const summaryCache = new AnalyticsSummaryCache();

  return {
    summaryAnalytics(
      env: ApiWorkerEnv,
      session: SessionClaims,
      filters: AnalyticsFilters,
    ): Effect.Effect<AnalyticsSummary, CoreServiceError> {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let flight: AnalyticsSummaryFlight | undefined;
          let computation: { key: string; namespace: string; completedAt: number } | undefined;
          const transaction: Effect.Effect<AnalyticsSummaryTransactionResult, CoreServiceError> =
            withTenantTransactionEffect(env, session, (client) =>
              Effect.gen(function* () {
                const access = yield* analyticsAccessEffect(client, filters.brandProfileId);
                const namespace = `${analyticsDeploymentNamespace(env)}|${capabilityNamespace}`;
                summaryCache.useNamespace(namespace);
                const key = analyticsSummaryCacheKey(access, filters, namespace, session);
                const cached = summaryCache.get(key, now().getTime());
                if (cached !== undefined) return { kind: "ready", summary: cached } as const;
                const acquired = summaryCache.acquire(key);
                if (acquired && !acquired.leader) {
                  return { kind: "pending", promise: acquired.promise } as const;
                }
                flight = acquired;
                const summary = yield* computeAnalyticsSummaryEffect(client, capabilities, filters);
                computation = { key, namespace, completedAt: now().getTime() };
                return { kind: "ready", summary } as const;
              }),
            );
          const exit = yield* Effect.exit(transaction);
          if (Exit.isFailure(exit)) {
            flight?.release();
            flight?.settle(Exit.failCause(exit.cause));
            return yield* Effect.failCause(exit.cause);
          }
          const outcome = exit.value;
          if (outcome.kind === "pending") {
            const shared = yield* restore(Effect.promise(() => outcome.promise));
            return yield* Exit.isSuccess(shared)
              ? Effect.succeed(structuredClone(shared.value))
              : Effect.failCause(shared.cause);
          }
          if (computation) {
            summaryCache.set(
              computation.key,
              outcome.summary,
              computation.completedAt,
              computation.namespace,
            );
            flight?.release();
            flight?.settle(Exit.succeed(structuredClone(outcome.summary)));
          }
          return outcome.summary;
        }),
      );
    },

    analyticsPosts(
      env: ApiWorkerEnv,
      session: SessionClaims,
      filters: AnalyticsPostsFilters,
    ): Effect.Effect<Schemas["AnalyticsPostsResponse"], CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<AnalyticsPostRow>(
            `WITH candidates AS (
               ${publishedDistributionCandidatesSql("d.id AS distribution_id, d.post_id, d.platform, d.published_at")}
             ),
             latest AS (
               SELECT DISTINCT ON (s.distribution_id)
                 s.distribution_id, s.views, s.likes, s.comments, s.shares, s.snapshot_at
               FROM analytics_snapshots s
               JOIN candidates c ON c.distribution_id = s.distribution_id
               WHERE s.snapshot_at <= $2
               ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
             ),
             per_post AS (
               SELECT
                 c.post_id,
                 MIN(c.published_at) AS published_at,
                 COUNT(*) AS destination_count,
                 COUNT(l.distribution_id) AS synced_destination_count,
                 ARRAY_AGG(DISTINCT c.platform ORDER BY c.platform) AS platforms,
                 MAX(l.snapshot_at) AS last_synced_at,
                 COALESCE(SUM(l.views), 0) AS views,
                 COALESCE(SUM(l.likes), 0) AS likes,
                 COALESCE(SUM(l.comments), 0) AS comments,
                 COALESCE(SUM(l.shares), 0) AS shares
               FROM candidates c
               LEFT JOIN latest l ON l.distribution_id = c.distribution_id
               GROUP BY c.post_id
             )
             SELECT
               p.id AS post_id,
               p.title,
               LEFT(btrim(regexp_replace(p.default_text, '\\s+', ' ', 'g')), 140) AS excerpt,
               pp.published_at,
               pp.destination_count,
               pp.synced_destination_count,
               pp.platforms,
               pp.last_synced_at,
               pp.views,
               pp.likes,
               pp.comments,
               pp.shares
             FROM per_post pp
             JOIN posts p ON p.id = pp.post_id AND p.deleted_at IS NULL
             ORDER BY ${ANALYTICS_POST_SORT_COLUMNS[filters.metric]} DESC,
                      pp.published_at DESC,
                      pp.post_id ASC
             LIMIT $7 OFFSET $8`,
            [...analyticsFilterParams(filters), filters.limit + 1, filters.offset],
          );
          return {
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
            posts: result.rows.slice(0, filters.limit).map((row) => ({
              comments: number(row.comments),
              destination_count: number(row.destination_count),
              synced_destination_count: number(row.synced_destination_count),
              excerpt: row.excerpt,
              last_synced_at: isoDateTimeOrNull(row.last_synced_at),
              likes: number(row.likes),
              platforms: row.platforms,
              post_id: row.post_id,
              published_at: isoDateTime(row.published_at),
              shares: number(row.shares),
              title: row.title,
              unsupported_platforms: row.platforms.filter(
                (platform) => !capabilities.get(platform)?.analytics,
              ),
              views: number(row.views),
            })),
          };
        }),
      );
    },

    dashboardAnalytics(
      env: ApiWorkerEnv,
      session: SessionClaims,
      filters: AnalyticsFilters,
    ): Effect.Effect<Schemas["AnalyticsDashboard"], CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const candidates = publishedDistributionCandidatesSql(
            `d.id, d.platform, d.published_at, ${analyticsFormatExpression("d")} AS format`,
          );
          const scope = analyticsFilterParams(filters);
          const latest = `
            latest AS (
              SELECT DISTINCT ON (s.distribution_id)
                s.distribution_id, s.views, s.likes, s.comments, s.shares,
                s.impressions, s.reach, s.watch_time_sec, s.saves, s.clicks,
                s.snapshot_at
              FROM analytics_snapshots s
              JOIN candidates c ON c.id = s.distribution_id
              WHERE s.snapshot_at <= $2
              ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
            )`;

          const seriesResult = yield* client.query<AnalyticsSeriesRow>(
            `WITH candidates AS (${candidates}),
             baseline AS (
               SELECT DISTINCT ON (s.distribution_id)
                 s.distribution_id, s.views, s.likes, s.comments, s.shares,
                 s.impressions, s.reach, s.snapshot_at, s.id, 1 AS is_baseline
               FROM analytics_snapshots s
               JOIN candidates c ON c.id = s.distribution_id
               WHERE s.snapshot_at < $1
               ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
             ),
             events AS (
               SELECT s.distribution_id, s.views, s.likes, s.comments, s.shares,
                      s.impressions, s.reach, s.snapshot_at, s.id, 0 AS is_baseline
               FROM analytics_snapshots s
               JOIN candidates c ON c.id = s.distribution_id
               WHERE s.snapshot_at >= $1 AND s.snapshot_at <= $2
               UNION ALL
               SELECT distribution_id, views, likes, comments, shares,
                      impressions, reach, snapshot_at, id, is_baseline
               FROM baseline
             ),
             deltas AS (
               SELECT e.distribution_id, c.platform, e.snapshot_at, e.is_baseline,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.views - COALESCE(lag(e.views) OVER w, 0), 0) END AS views,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.likes - COALESCE(lag(e.likes) OVER w, 0), 0) END AS likes,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.comments - COALESCE(lag(e.comments) OVER w, 0), 0) END AS comments,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.shares - COALESCE(lag(e.shares) OVER w, 0), 0) END AS shares,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.impressions - COALESCE(lag(e.impressions) OVER w, 0), 0) END AS impressions,
                 CASE WHEN e.is_baseline = 1 THEN 0
                   ELSE GREATEST(e.reach - COALESCE(lag(e.reach) OVER w, 0), 0) END AS reach
               FROM events e
               JOIN candidates c ON c.id = e.distribution_id
               WINDOW w AS (PARTITION BY e.distribution_id ORDER BY e.snapshot_at, e.id)
             ),
             snapshot_days AS (
               SELECT (snapshot_at AT TIME ZONE 'UTC')::date::text AS date, platform,
                      SUM(views) AS views, SUM(likes) AS likes,
                      SUM(comments) AS comments, SUM(shares) AS shares,
                      SUM(impressions) AS impressions, SUM(reach) AS reach,
                      MAX(snapshot_at) AS last_synced_at
               FROM deltas
               GROUP BY 1, 2
             ),
             published_days AS (
               SELECT (published_at AT TIME ZONE 'UTC')::date::text AS date, platform,
                      COUNT(*) AS posts
               FROM candidates
               GROUP BY 1, 2
             )
             SELECT date, platform,
                    SUM(posts)::int AS posts,
                    SUM(views) AS views, SUM(likes) AS likes,
                    SUM(comments) AS comments, SUM(shares) AS shares,
                    SUM(impressions) AS impressions, SUM(reach) AS reach,
                    MAX(last_synced_at) AS last_synced_at
             FROM (
               SELECT date, platform, 0::bigint AS posts, views, likes, comments,
                      shares, impressions, reach, last_synced_at
               FROM snapshot_days
               UNION ALL
               SELECT date, platform, posts, 0, 0, 0, 0, 0, 0, NULL
               FROM published_days
             ) parts
             GROUP BY date, platform
             ORDER BY date ASC, platform ASC`,
            scope,
          );

          const aggregateResult = yield* client.query<AnalyticsAggregateRow>(
            `WITH candidates AS (${candidates}),
             ${latest},
             joined AS MATERIALIZED (
               SELECT c.id, c.platform, c.published_at, c.format,
                      l.views, l.likes, l.comments, l.shares, l.impressions,
                      l.reach, l.watch_time_sec, l.saves, l.clicks, l.snapshot_at
               FROM candidates c
               LEFT JOIN latest l ON l.distribution_id = c.id
             )
             SELECT
               COALESCE((
                 SELECT json_agg(platform_row)
                 FROM (
                   SELECT c.platform,
                          COUNT(*)::int AS posts,
                          COALESCE(SUM(c.views), 0) AS views,
                          COALESCE(SUM(c.likes), 0) AS likes,
                          COALESCE(SUM(c.comments), 0) AS comments,
                          COALESCE(SUM(c.shares), 0) AS shares,
                          COALESCE(SUM(c.impressions), 0) AS impressions,
                          COALESCE(SUM(c.reach), 0) AS reach,
                          COALESCE(SUM(c.watch_time_sec), 0) AS watch_time_sec,
                          SUM(c.saves) AS saves,
                          SUM(c.clicks) AS clicks,
                          CASE WHEN SUM(COALESCE(c.views, 0)) > 0
                            THEN (SUM(COALESCE(c.likes, 0)) + SUM(COALESCE(c.comments, 0))
                                  + SUM(COALESCE(c.shares, 0)))::float8
                                 / SUM(COALESCE(c.views, 0))
                            ELSE NULL END AS engagement_rate,
                          MAX(c.snapshot_at) AS last_synced_at
                   FROM joined c
                   GROUP BY c.platform
                   ORDER BY c.platform ASC
                 ) AS platform_row
               ), '[]'::json) AS platforms,
               COALESCE((
                 SELECT json_agg(format_row)
                 FROM (
                   SELECT c.format,
                          COUNT(*)::int AS posts,
                          COALESCE(SUM(c.views), 0) AS views,
                          COALESCE(SUM(c.likes), 0) AS likes,
                          COALESCE(SUM(c.comments), 0) AS comments,
                          COALESCE(SUM(c.shares), 0) AS shares,
                          (SUM(COALESCE(c.likes, 0)) + SUM(COALESCE(c.comments, 0))
                           + SUM(COALESCE(c.shares, 0))) AS engagement,
                          MAX(c.snapshot_at) AS last_synced_at
                   FROM joined c
                   GROUP BY c.format
                   ORDER BY posts DESC, c.format ASC
                 ) AS format_row
               ), '[]'::json) AS formats,
               COALESCE((
                 SELECT json_agg(best_row)
                 FROM (
                   SELECT EXTRACT(DOW FROM c.published_at)::int AS day_of_week,
                          EXTRACT(HOUR FROM c.published_at)::int AS hour,
                          COUNT(*)::int AS posts,
                          AVG(COALESCE(c.views, 0))::float8 AS avg_views,
                          AVG(COALESCE(c.likes, 0))::float8 AS avg_likes,
                          AVG(COALESCE(c.comments, 0))::float8 AS avg_comments,
                          AVG(COALESCE(c.shares, 0))::float8 AS avg_shares,
                          AVG(COALESCE(c.likes, 0) + COALESCE(c.comments, 0)
                              + COALESCE(c.shares, 0))::float8 AS avg_engagement
                   FROM joined c
                   GROUP BY 1, 2
                   ORDER BY 1 ASC, 2 ASC
                 ) AS best_row
               ), '[]'::json) AS best_times`,
            scope,
          );
          const aggregate = aggregateResult.rows[0] ?? {
            best_times: [],
            formats: [],
            platforms: [],
          };

          const followerResult = yield* client.query<AnalyticsFollowerRow>(
            `WITH baseline AS (
               SELECT account.id AS account_id, account.platform,
                      account.display_name AS account_name,
                      latest.followers, latest.captured_at
               FROM platform_accounts account
               JOIN LATERAL (
                 SELECT snapshot.followers, snapshot.captured_at
                 FROM platform_account_snapshots snapshot
                 WHERE snapshot.platform_account_id = account.id
                   AND snapshot.captured_at < $1
                 ORDER BY snapshot.captured_at DESC
                 LIMIT 1
               ) latest ON true
               WHERE ($3::text IS NULL OR account.platform = $3)
                 AND ($4::uuid IS NULL OR account.brand_profile_id = $4)
                 AND ($5::uuid IS NULL OR account.id = $5)
                 AND ${activeBrandProfilePredicate("account.brand_profile_id")}
             ),
             daily AS (
               SELECT DISTINCT ON (account.id, date_trunc('day', snapshot.captured_at))
                      account.id AS account_id, account.platform,
                      account.display_name AS account_name,
                      snapshot.followers, snapshot.captured_at
               FROM platform_account_snapshots snapshot
               JOIN platform_accounts account ON account.id = snapshot.platform_account_id
               WHERE snapshot.captured_at >= $1
                 AND snapshot.captured_at <= $2
                 AND ($3::text IS NULL OR account.platform = $3)
                 AND ($4::uuid IS NULL OR account.brand_profile_id = $4)
                 AND ($5::uuid IS NULL OR account.id = $5)
                 AND ${activeBrandProfilePredicate("account.brand_profile_id")}
               ORDER BY account.id, date_trunc('day', snapshot.captured_at),
                        snapshot.captured_at DESC
             )
             SELECT * FROM baseline
             UNION ALL
             SELECT * FROM daily
             ORDER BY platform ASC, account_id ASC, captured_at ASC`,
            [
              filters.start,
              filters.end,
              filters.platform ?? null,
              filters.brandProfileId ?? null,
              filters.accountId ?? null,
            ],
          );

          const accumulationResult = yield* client.query<AnalyticsAccumulationRow>(
            `WITH candidates AS (${candidates}),
             snapshots AS (
               SELECT c.id AS distribution_id, c.published_at, s.snapshot_at,
                      EXTRACT(EPOCH FROM (s.snapshot_at - c.published_at)) / 3600 AS elapsed_hours,
                      (s.likes + s.comments + s.shares) AS engagement
               FROM candidates c
               JOIN analytics_snapshots s ON s.distribution_id = c.id
               WHERE s.snapshot_at >= c.published_at AND s.snapshot_at <= $2
                 AND s.snapshot_at <= c.published_at + INTERVAL '720 hours'
             ),
             buckets(hours) AS (VALUES (1), (6), (24), (72), (168), (720)),
             per_bucket AS (
               SELECT buckets.hours, snapshots.distribution_id,
                      MAX(snapshots.engagement) AS engagement
               FROM buckets
               JOIN snapshots ON snapshots.elapsed_hours <= buckets.hours
               GROUP BY buckets.hours, snapshots.distribution_id
             )
             SELECT hours::int AS elapsed_hours,
                    AVG(engagement)::float8 AS avg_engagement,
                    COUNT(*)::int AS observations
             FROM per_bucket
             GROUP BY hours
             ORDER BY hours ASC`,
            scope,
          );

          const followerGroups = new Map<
            string,
            {
              account_id: string;
              account_name: string | null;
              platform: Platform;
              points: { captured_at: string; followers: number }[];
            }
          >();
          for (const row of followerResult.rows) {
            const key = `${row.platform}:${row.account_id}`;
            const existing = followerGroups.get(key) ?? {
              account_id: row.account_id,
              account_name: row.account_name,
              platform: row.platform,
              points: [] as { captured_at: string; followers: number }[],
            };
            existing.points.push({
              captured_at: isoDateTime(row.captured_at),
              followers: number(row.followers),
            });
            followerGroups.set(key, existing);
          }
          const followers = [...followerGroups.values()];
          const startTime = filters.start.getTime();
          const platformFollowers = new Map<
            Platform,
            { followers: number; gain: number; complete: boolean }
          >();
          for (const account of followers) {
            const baseline = [...account.points]
              .reverse()
              .find((point) => new Date(point.captured_at).getTime() <= startTime);
            const current = account.points.at(-1)!;
            const aggregateEntry = platformFollowers.get(account.platform) ?? {
              complete: true,
              followers: 0,
              gain: 0,
            };
            aggregateEntry.followers += current.followers;
            if (baseline) aggregateEntry.gain += current.followers - baseline.followers;
            else aggregateEntry.complete = false;
            platformFollowers.set(account.platform, aggregateEntry);
          }

          const platforms = aggregate.platforms.map((row) => {
            const follower = platformFollowers.get(row.platform);
            return {
              platform: row.platform,
              posts: number(row.posts),
              views: number(row.views),
              likes: number(row.likes),
              comments: number(row.comments),
              shares: number(row.shares),
              impressions: number(row.impressions),
              reach: number(row.reach),
              engagement_rate: row.engagement_rate === null ? null : Number(row.engagement_rate),
              followers: follower?.followers ?? null,
              follower_gain: follower && follower.complete ? follower.gain : null,
              saves: row.saves === null ? null : number(row.saves),
              clicks: row.clicks === null ? null : number(row.clicks),
              last_synced_at: isoDateTimeOrNull(row.last_synced_at),
            };
          });
          const unavailable = new Set<
            Schemas["AnalyticsDashboard"]["unavailable_metrics"][number]
          >();
          if (platforms.length === 0 || platforms.every((row) => row.saves === null)) {
            unavailable.add("saves");
          }
          if (platforms.length === 0 || platforms.every((row) => row.clicks === null)) {
            unavailable.add("clicks");
          }
          if (followers.length === 0) unavailable.add("followers");

          const unsupportedPlatforms = platforms
            .map((row) => row.platform)
            .filter((platform) => !capabilities.get(platform)?.analytics);
          const watchTimeByPlatform = new Map(
            aggregate.platforms.map((row) => [row.platform, number(row.watch_time_sec)]),
          );
          const cohortByPlatform = platforms.map((row) => ({
            comments: row.comments,
            impressions: row.impressions,
            last_synced_at: row.last_synced_at,
            likes: row.likes,
            platform: row.platform,
            post_count: row.posts,
            reach: row.reach,
            shares: row.shares,
            views: row.views,
            watch_time_sec: watchTimeByPlatform.get(row.platform) ?? 0,
          }));
          const lastSyncedAt = platforms.reduce<string | null>((latest, row) => {
            if (row.last_synced_at === null) return latest;
            return latest === null || row.last_synced_at > latest ? row.last_synced_at : latest;
          }, null);

          return {
            range: {
              end: filters.end.toISOString(),
              start: filters.start.toISOString(),
            },
            series: seriesResult.rows.map((row) => ({
              date: row.date,
              platform: row.platform,
              posts: number(row.posts),
              views: number(row.views),
              likes: number(row.likes),
              comments: number(row.comments),
              shares: number(row.shares),
              impressions: number(row.impressions),
              reach: number(row.reach),
              last_synced_at: isoDateTimeOrNull(row.last_synced_at),
            })),
            best_times: aggregate.best_times.map((row) => ({
              day_of_week: number(row.day_of_week),
              hour: number(row.hour),
              posts: number(row.posts),
              avg_views: Number(row.avg_views),
              avg_likes: Number(row.avg_likes),
              avg_comments: Number(row.avg_comments),
              avg_shares: Number(row.avg_shares),
              avg_engagement: Number(row.avg_engagement),
            })),
            formats: aggregate.formats.map((row) => ({
              format: row.format,
              posts: number(row.posts),
              views: number(row.views),
              likes: number(row.likes),
              comments: number(row.comments),
              shares: number(row.shares),
              engagement: number(row.engagement),
              avg_views: number(row.views) / number(row.posts),
              avg_engagement: number(row.engagement) / number(row.posts),
              last_synced_at: isoDateTimeOrNull(row.last_synced_at),
            })),
            platforms,
            cohort: {
              by_platform: cohortByPlatform,
              last_synced_at: lastSyncedAt,
              partial: unsupportedPlatforms.length > 0,
              range: {
                end: filters.end.toISOString(),
                start: filters.start.toISOString(),
              },
              totals: sumAnalyticsTotals(cohortByPlatform),
              unsupported_platforms: unsupportedPlatforms,
            },
            followers,
            accumulation: accumulationResult.rows.map((row) => ({
              elapsed_hours: number(row.elapsed_hours),
              avg_engagement: Number(row.avg_engagement),
              observations: number(row.observations),
            })),
            unavailable_metrics: [...unavailable],
          };
        }),
      );
    },

    distributionAnalytics(
      env: ApiWorkerEnv,
      session: SessionClaims,
      distributionId: string,
      filters: SnapshotFilters,
    ): Effect.Effect<AnalyticsSnapshot[], CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<DistributionAnalyticsRow>(
            `SELECT
               snapshot.id, target.id AS distribution_id,
               target.post_id AS post_id,
               snapshot.views, snapshot.likes, snapshot.comments,
               snapshot.shares, snapshot.watch_time_sec, snapshot.reach,
               snapshot.impressions, snapshot.snapshot_at
             FROM (
               SELECT id, post_id
               FROM distributions
               WHERE id = $1
                 AND ${activeBrandProfilePredicate("brand_profile_id")}
             ) AS target
             LEFT JOIN LATERAL (
               SELECT
                 id, views, likes, comments, shares, watch_time_sec,
                 reach, impressions, snapshot_at
               FROM analytics_snapshots
               WHERE distribution_id = target.id
                 AND ($2::timestamptz IS NULL OR snapshot_at >= $2)
                 AND ($3::timestamptz IS NULL OR snapshot_at <= $3)
               ORDER BY snapshot_at ASC, id ASC
               LIMIT $4
             ) AS snapshot ON true
             ORDER BY snapshot.snapshot_at ASC NULLS LAST,
                      snapshot.id ASC NULLS LAST`,
            [distributionId, filters.start ?? null, filters.end ?? null, filters.limit],
          );
          if (result.rows.length === 0) {
            return yield* Effect.fail(
              new CoreApiError(404, "not_found", "The distribution was not found."),
            );
          }
          return result.rows.flatMap((row) =>
            row.id === null
              ? []
              : [
                  mapSnapshot({
                    comments: row.comments!,
                    distribution_id: row.distribution_id,
                    id: row.id,
                    impressions: row.impressions!,
                    likes: row.likes!,
                    post_id: row.post_id,
                    reach: row.reach!,
                    shares: row.shares!,
                    snapshot_at: row.snapshot_at!,
                    views: row.views!,
                    watch_time_sec: row.watch_time_sec!,
                  }),
                ],
          );
        }),
      );
    },
  };
}
