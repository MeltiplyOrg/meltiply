import { Effect } from "effect";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import { cachedProviderRegistryFromEnvironment, type ProviderRegistry } from "@meltiply/providers";
import {
  categoryEffective,
  createReportingServiceLive,
  isPlatform,
  loadPreferences,
  policySnapshot,
  reportingConfiguration,
  ReportingService,
  USAGE_ENGAGEMENT_METRICS,
  type ReportingTransactionRunner,
  type UsageEngagement,
  type UsageEngagementCoverage,
  type UsageEngagementMetric,
  type UsageReportInput,
} from "@meltiply/reporting";

import { withSystemTransactionEffect, type EffectTransactionClient } from "./database";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

/**
 * Producer for the opt-in daily usage summary.
 *
 * One bounded scheduled pass reports **closed UTC days** only: yesterday and, at
 * most, the previous six, so a missed invocation catches up without an unbounded
 * backfill and without reporting a day that is still accumulating. Every report
 * carries the frozen logical identity of (consent interval, UTC day), so a
 * duplicate invocation or a partial delivery retry reuses one measurement instead
 * of minting another.
 *
 * Two facts are deliberately *current-state gauges* rather than historical
 * series, because that is all the installation can honestly state:
 *
 * - Connected Channels are occupancy right now, from the canonical connection
 *   state the Channel list uses.
 * - Engagement is the latest eligible stored Provider snapshot per Distribution,
 *   so a lifetime view count repeated tomorrow is the same views, not new views.
 *
 * Nothing here calls a Provider. The stored snapshots are read through the
 * existing per-Distribution index, metric support is derived from the adapter
 * roster, and publication counters come from the durable marks written inside the
 * publication transactions — so queued work, retries and Ambiguous outcomes are
 * already excluded before this unit runs.
 */

/** Closed UTC days one invocation may report. */
export const usageReportLookbackDays = 7;

/** Distributions whose stored snapshots one invocation reads for the gauges. */
export const usageEngagementCohortLimit = 2_000;

/** What one invocation produced, surfaced in the scheduled unit's log line. */
export interface UsageReportResult {
  /** Closed days this invocation enqueued a report for. */
  readonly considered: number;
  /** Days whose report identity was newly written; a duplicate run reports zero. */
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

/** Per-metric contribution counts for one Platform's cohort. */
interface MetricCoverage {
  /** Snapshots that could not establish this metric. */
  missing: number;
  /** Snapshots that contributed this metric. */
  total: number;
}

/** One Platform's gauge as accumulated across the cohort. */
interface EngagementAccumulator {
  asOf: number | null;
  coverage: Record<UsageEngagementMetric, MetricCoverage>;
  measured: number;
  totals: Record<UsageEngagementMetric, number>;
}

/** Creates one empty accumulator for a Platform. */
function emptyAccumulator(): EngagementAccumulator {
  const coverage = {} as Record<UsageEngagementMetric, MetricCoverage>;
  const totals = {} as Record<UsageEngagementMetric, number>;
  for (const metric of USAGE_ENGAGEMENT_METRICS) {
    coverage[metric] = { missing: 0, total: 0 };
    totals[metric] = 0;
  }
  return { asOf: null, coverage, measured: 0, totals };
}

/**
 * Builds one Platform's gauge from the accumulated cohort.
 *
 * A metric is emitted only when **every** contributing snapshot established it.
 * One snapshot that could not — no stored value, or a Provider that reports an
 * absent insight as zero — makes the sum unknown rather than understated, so the
 * metric is omitted and named as missing coverage. The distinction between an
 * observed zero and an absent one is the adapter's declaration, never a Platform
 * list here: this function only consumes per-metric coverage counts.
 *
 * @param accumulator - Accumulated cohort totals and coverage.
 * @param analyticsSupported - Whether this Platform's adapter reports analytics at all.
 * @returns The gauge plus the metrics it could not establish.
 */
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
/**
 * Enqueues the closed-day usage summaries for this invocation.
 *
 * The pass only freezes and queues measurements, so a PostHog outage cannot
 * change its outcome; policy is still evaluated by the reporting module before a
 * row is written, and an ineffective category queues nothing at all. It fails only
 * on a database error, which the scheduled boundary classifies like every sibling
 * unit.
 *
 * @param env - Automation Worker bindings for this invocation.
 * @param dependencies - Clock and Provider-registry overrides for tests.
 * @returns Effect resolving to the considered/queued counts.
 */
export function enqueueDailyUsageReport(
  env: AutomationEnv,
  dependencies: {
    readonly now?: () => Date;
    readonly providerRegistry?: ProviderRegistry;
  } = {},
): Effect.Effect<UsageReportResult, AutomationJobError> {
  const now = dependencies.now?.() ?? new Date();
  const configuration = reportingConfiguration(env);
  const transaction: ReportingTransactionRunner = (operation) =>
    withSystemTransactionEffect(env, (client: EffectTransactionClient) => operation(client));
  const service = createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    // Enqueue never transmits; the delivery unit owns the transport.
    transport: null,
  });
  const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
  const analyticsSupported = new Set<Platform>(
    registry
      .capabilities()
      .filter((capability) => capability.analytics)
      .map((capability) => capability.platform),
  );
  // Per-Platform ambiguity comes from each adapter, never from a roster here: an
  // adapter that normalizes a missing insight to zero declares which metrics that
  // affects, and the accumulator treats those zeros as unknown.
  const ambiguousMetrics = new Map<Platform, readonly UsageEngagementMetric[]>(
    PLATFORM_IDS.map((platform) => [platform, registry.ambiguousZeroMetrics(platform)]),
  );
  const dayMilliseconds = 24 * 60 * 60 * 1_000;
  // Every closed day ends at a UTC midnight, so `offset` counts days back from
  // today's start.
  const closedDays = Array.from({ length: usageReportLookbackDays }, (_, index) => {
    const dayEnd =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      index * dayMilliseconds;
    return { dayEnd, reportDate: new Date(dayEnd - dayMilliseconds).toISOString().slice(0, 10) };
  });
  return Effect.gen(function* () {
    const snapshot = yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const preferences = yield* loadPreferences(client, false);
        const policy = policySnapshot(preferences, configuration);
        if (!categoryEffective(policy, "usage")) return null;
        const intervalStartedAt = new Date(policy.categories.usage.intervalStartedAt ?? NaN);
        if (Number.isNaN(intervalStartedAt.getTime())) return null;
        // Only closed days that ended after this consent interval began can hold
        // activity it covers; an earlier day belongs to a declined or previous
        // interval and is never replayed.
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
        // Distinct Posts per day: the mark table is keyed by Post, so this is a
        // cross-Platform total rather than a sum of per-Platform Post counts. A
        // Post whose first success fell outside an effective interval is stored
        // but never counted.
        //
        // The window is expressed on the raw timestamp, not on the UTC-date
        // expression: `first_confirmed_at >= $1` with a consent interval that
        // began long ago would walk every mark since then, and an expression in
        // the predicate cannot use the partial index. `days` is contiguous and
        // ordered newest first, so its last entry is the oldest day and the first
        // is the newest; both bounds are real instants.
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
        // One extra row is read purely as evidence that the bound was reached, so
        // the payload can say `truncated` instead of implying the cohort is all.
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
        // The days this pass measured become final before the transaction ends:
        // a publication transaction that began before midnight and commits later
        // then sees the fence and refuses to change an already-measured day,
        // instead of retroactively editing a report that may already be sent.
        const finalized = days.map((day) => day.reportDate);
        yield* client.query(
          `INSERT INTO reporting_publication_daily_finalized (report_date)
           SELECT unnest($1::date[])
           ON CONFLICT (report_date) DO NOTHING`,
          [finalized],
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
      // A published Distribution with no snapshot yet is coverage-missing, not a
      // measured zero.
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
        // A stored zero from an adapter that normalizes a missing insight to zero
        // cannot be told apart from "the Provider did not return this metric", so
        // it is counted as missing rather than added. Anything else that is not a
        // usable count is missing too; only a real observation contributes.
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
    // Snapshots that could not establish at least one metric, so coverage states
    // a metric gap instead of implying every gauge is complete.
    let incompleteMetrics = 0;
    for (const platform of PLATFORM_IDS) {
      const accumulator = accumulators.get(platform);
      // A Platform whose whole cohort answered without a snapshot contributes no
      // gauge at all: the coverage's `missing` count already names it, and a
      // `{distributions: 0}` gauge would read as a measured empty Platform.
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
            // Everything the cohort did not cover — no snapshot yet, outside the
            // bound, or a metric its Provider could not establish — is named
            // instead of assumed empty.
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
    // The newest closed day always reports, so the installation keeps a daily
    // gauge. Older days report only when they carry confirmed publications, which
    // is what a bounded catch-up needs without manufacturing empty history.
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
          // The enqueue transaction re-reads policy; naming the interval these
          // counters were computed under makes a withdrawal plus re-enable in
          // between queue nothing instead of tagging declined activity.
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
