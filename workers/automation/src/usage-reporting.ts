import { Effect } from "effect";
import { isPlatform, PLATFORM_IDS, type Platform } from "@meltiply/domain";
import { cachedProviderRegistryFromEnvironment, type ProviderRegistry } from "@meltiply/providers";
import {
  categoryEffective,
  loadPreferences,
  lockReportingMeasurement,
  policySnapshot,
  ReportingService,
  USAGE_ENGAGEMENT_METRICS,
  type UsageEngagement,
  type UsageEngagementCoverage,
  type UsageEngagementMetric,
  type UsageReportInput,
} from "@meltiply/reporting";

import { withSystemTransactionEffect } from "./database";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { automationReportingLayer } from "./reporting";

const usageReportLookbackDays = 7;

const usageEngagementCohortLimit = 2_000;

export interface UsageReportResult {
  readonly considered: number;
  readonly queued: number;
}

interface PublicationDayRow extends Record<string, unknown> {
  distributions: number;
  platform: string;
  report_date: string;
}

interface PostDayRow extends Record<string, unknown> {
  posts: number;
  report_date: string;
}

interface ChannelRow extends Record<string, unknown> {
  channels: number;
  platform: string;
}

interface EngagementRow extends Record<string, unknown> {
  comments: number | string | null;
  likes: number | string | null;
  platform: string;
  shares: number | string | null;
  snapshot_at: Date | string | null;
  views: number | string | null;
}

interface MetricCoverage {
  missing: number;
  total: number;
}

interface EngagementAccumulator {
  asOf: number | null;
  coverage: Record<UsageEngagementMetric, MetricCoverage>;
  measured: number;
  totals: Record<UsageEngagementMetric, number>;
}

function emptyAccumulator(): EngagementAccumulator {
  const coverage = {} as Record<UsageEngagementMetric, MetricCoverage>;
  const totals = {} as Record<UsageEngagementMetric, number>;
  for (const metric of USAGE_ENGAGEMENT_METRICS) {
    coverage[metric] = { missing: 0, total: 0 };
    totals[metric] = 0;
  }
  return { asOf: null, coverage, measured: 0, totals };
}

function gaugeFor(
  accumulator: EngagementAccumulator,
  analyticsSupported: boolean,
): { gauge: UsageEngagement; missing: number; unsupported: UsageEngagementMetric[] } {
  const unsupported: UsageEngagementMetric[] = [];
  const established: Partial<Record<UsageEngagementMetric, number>> = {};
  let missing = 0;
  for (const metric of USAGE_ENGAGEMENT_METRICS) {
    const coverage = accumulator.coverage[metric];
    if (analyticsSupported && coverage.total > 0 && coverage.missing === 0) {
      established[metric] = accumulator.totals[metric];
      continue;
    }
    unsupported.push(metric);
    missing = Math.max(missing, coverage.missing);
  }
  return {
    gauge: {
      asOf: accumulator.asOf === null ? null : new Date(accumulator.asOf).toISOString(),
      comments: established.comments ?? null,
      distributions: accumulator.measured,
      reactions: established.reactions ?? null,
      shares: established.shares ?? null,
      views: established.views ?? null,
    },
    missing,
    unsupported,
  };
}
export function enqueueDailyUsageReport(
  env: AutomationEnv,
  dependencies: {
    readonly now?: () => Date;
    readonly providerRegistry?: ProviderRegistry;
  } = {},
): Effect.Effect<UsageReportResult, AutomationJobError> {
  const now = dependencies.now?.() ?? new Date();
  const { configuration, layer: service } = automationReportingLayer(env);
  const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
  const analyticsSupported = new Set<Platform>(
    registry
      .capabilities()
      .filter((capability) => capability.analytics)
      .map((capability) => capability.platform),
  );
  const ambiguousMetrics = new Map<Platform, readonly UsageEngagementMetric[]>(
    PLATFORM_IDS.map((platform) => [platform, registry.ambiguousZeroMetrics(platform)]),
  );
  const dayMilliseconds = 24 * 60 * 60 * 1_000;
  const closedDays = Array.from({ length: usageReportLookbackDays }, (_, index) => {
    const dayEnd =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - index * dayMilliseconds;
    return { dayEnd, reportDate: new Date(dayEnd - dayMilliseconds).toISOString().slice(0, 10) };
  });
  return Effect.gen(function* () {
    const snapshot = yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* lockReportingMeasurement(client);
        const preferences = yield* loadPreferences(client, false);
        const policy = policySnapshot(preferences, configuration);
        if (!categoryEffective(policy, "usage")) return null;
        const intervalStartedAt = new Date(policy.categories.usage.intervalStartedAt ?? NaN);
        if (Number.isNaN(intervalStartedAt.getTime())) return null;
        const days = closedDays.filter((day) => day.dayEnd > intervalStartedAt.getTime());
        if (days.length === 0) return null;
        const reportDates = days.map((day) => day.reportDate);
        const publications = yield* client.query<PublicationDayRow>(
          `SELECT report_date::text AS report_date, platform, distributions
           FROM reporting_publication_daily
           WHERE interval_started_at = $1
             AND report_date = ANY($2::date[])`,
          [intervalStartedAt, reportDates],
        );
        const windowStart = new Date(
          Math.min(...days.map((day) => day.dayEnd)) - 24 * 60 * 60 * 1_000,
        );
        const windowEnd = new Date(Math.max(...days.map((day) => day.dayEnd)));
        const posts = yield* client.query<PostDayRow>(
          `SELECT (first_confirmed_at AT TIME ZONE 'UTC')::date::text AS report_date,
                  COUNT(*)::int AS posts
           FROM reporting_post_marks
           WHERE counted
             AND first_confirmed_at >= GREATEST($1::timestamptz, $2::timestamptz)
             AND first_confirmed_at < $3::timestamptz
           GROUP BY 1`,
          [intervalStartedAt, windowStart, windowEnd],
        );
        const channels = yield* client.query<ChannelRow>(
          `SELECT account.platform, COUNT(*)::int AS channels
           FROM platform_accounts AS account
           JOIN brand_profiles AS profile
             ON profile.id = account.brand_profile_id
            AND profile.deleted_at IS NULL
           WHERE account.revoked_at IS NULL
             AND account.connection_status IN ('connected', 'expiring')
             AND (account.token_expires_at IS NULL OR account.token_expires_at > now())
           GROUP BY account.platform`,
        );
        const engagement = yield* client.query<EngagementRow>(
          `SELECT cohort.platform, cohort.snapshot_at, cohort.views, cohort.likes,
                  cohort.comments, cohort.shares
           FROM (
             SELECT distribution.platform, latest.snapshot_at, latest.views,
                    latest.likes, latest.comments, latest.shares
             FROM (
               SELECT distribution.id, distribution.platform
               FROM distributions AS distribution
               JOIN brand_profiles AS profile
                 ON profile.id = distribution.brand_profile_id
                AND profile.deleted_at IS NULL
               WHERE distribution.status = 'published'
               ORDER BY distribution.published_at DESC NULLS LAST, distribution.id DESC
               LIMIT $1
             ) AS distribution
             LEFT JOIN LATERAL (
               SELECT snapshot.snapshot_at, snapshot.views, snapshot.likes,
                      snapshot.comments, snapshot.shares
               FROM analytics_snapshots AS snapshot
               WHERE snapshot.distribution_id = distribution.id
               ORDER BY snapshot.snapshot_at DESC, snapshot.id DESC
               LIMIT 1
             ) AS latest ON true
           ) AS cohort`,
          [usageEngagementCohortLimit + 1],
        );
        return { channels, days, engagement, intervalStartedAt, posts, publications };
      }),
    );
    if (snapshot === null) return { considered: 0, queued: 0 } satisfies UsageReportResult;
    const truncated = snapshot.engagement.rows.length > usageEngagementCohortLimit;
    const cohort = truncated
      ? snapshot.engagement.rows.slice(0, usageEngagementCohortLimit)
      : snapshot.engagement.rows;
    const accumulators = new Map<Platform, EngagementAccumulator>();
    let measured = 0;
    for (const row of cohort) {
      if (!isPlatform(row.platform)) continue;
      const accumulator = accumulators.get(row.platform) ?? emptyAccumulator();
      accumulators.set(row.platform, accumulator);
      if (row.snapshot_at === null) continue;
      const capturedAt = new Date(row.snapshot_at);
      if (Number.isNaN(capturedAt.getTime())) continue;
      accumulator.measured += 1;
      measured += 1;
      const epoch = capturedAt.getTime();
      accumulator.asOf = accumulator.asOf === null ? epoch : Math.max(accumulator.asOf, epoch);
      const counters: Array<[UsageEngagementMetric, unknown]> = [
        ["views", row.views],
        ["reactions", row.likes],
        ["comments", row.comments],
        ["shares", row.shares],
      ];
      const ambiguous = new Set(ambiguousMetrics.get(row.platform) ?? []);
      for (const [metric, value] of counters) {
        const count = Number(value);
        const coverage = accumulator.coverage[metric];
        const established =
          Number.isFinite(count) && count >= 0 && !(count === 0 && ambiguous.has(metric));
        if (!established) {
          coverage.missing += 1;
          continue;
        }
        coverage.total += 1;
        accumulator.totals[metric] += count;
      }
    }
    const engagement: Partial<Record<Platform, UsageEngagement>> = {};
    const unsupportedMetrics = new Set<UsageEngagementMetric>();
    let incompleteMetrics = 0;
    for (const platform of PLATFORM_IDS) {
      const accumulator = accumulators.get(platform);
      if (!accumulator || accumulator.measured === 0) continue;
      const gauge = gaugeFor(accumulator, analyticsSupported.has(platform));
      engagement[platform] = gauge.gauge;
      for (const metric of gauge.unsupported) unsupportedMetrics.add(metric);
      incompleteMetrics = Math.max(incompleteMetrics, gauge.missing);
    }
    const channels: Partial<Record<Platform, number>> = {};
    for (const row of snapshot.channels.rows) {
      if (!isPlatform(row.platform)) continue;
      const count = Number(row.channels);
      if (Number.isFinite(count) && count > 0) channels[row.platform] = count;
    }
    const engagementCoverage: UsageEngagementCoverage | null =
      cohort.length === 0
        ? null
        : {
            measured,
            missing: cohort.length - measured + incompleteMetrics,
            truncated,
            unsupportedMetrics: [...unsupportedMetrics],
          };
    const engagementAsOf = Object.values(engagement).reduce<string | null>(
      (latest, gauge) =>
        gauge?.asOf && (latest === null || gauge.asOf > latest) ? gauge.asOf : latest,
      null,
    );
    const publicationsByDay = new Map<string, PublicationDayRow[]>();
    for (const row of snapshot.publications.rows) {
      if (!isPlatform(row.platform)) continue;
      const day = String(row.report_date);
      publicationsByDay.set(day, [...(publicationsByDay.get(day) ?? []), row]);
    }
    const postsByDay = new Map(
      snapshot.posts.rows.map((row) => [String(row.report_date), Number(row.posts) || 0]),
    );
    const newestClosedDay = snapshot.days[0]?.reportDate;
    const reportingDays = snapshot.days.filter(
      (day) =>
        day.reportDate === newestClosedDay ||
        publicationsByDay.has(day.reportDate) ||
        postsByDay.has(day.reportDate),
    );
    const outcomes = yield* Effect.forEach(
      reportingDays,
      (day) => {
        const distributions: Partial<Record<Platform, number>> = {};
        for (const row of publicationsByDay.get(day.reportDate) ?? []) {
          const count = Number(row.distributions);
          if (isPlatform(row.platform) && Number.isFinite(count) && count > 0) {
            distributions[row.platform] = count;
          }
        }
        const input: UsageReportInput = {
          channels,
          engagement,
          engagementAsOf,
          engagementCoverage,
          expectedIntervalStartedAt: snapshot.intervalStartedAt.toISOString(),
          publications: { distributions, posts: postsByDay.get(day.reportDate) ?? 0 },
          reportDate: day.reportDate,
        };
        return Effect.flatMap(ReportingService, (reporting) =>
          reporting.enqueueUsageReport(input),
        ).pipe(Effect.provide(service));
      },
      { concurrency: 1 },
    );
    return {
      considered: reportingDays.length,
      queued: outcomes.filter((outcome) => outcome === "queued").length,
    } satisfies UsageReportResult;
  }).pipe(Effect.catch((cause) => Effect.fail(classifyJobError(cause))));
}
