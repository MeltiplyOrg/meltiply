import { Effect } from "effect";
import { isPlatform, PLATFORM_IDS, type Platform } from "@meltiply/domain";
import { cachedProviderRegistryFromEnvironment, type ProviderRegistry } from "@meltiply/providers";
import {
  categoryEffective,
  createReportingServiceLive,
  policySnapshot,
  reportingConfiguration,
  ReportingService,
  type PreferencesRow,
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

/**
 * Platforms whose adapters normalize an absent insight to `0`.
 *
 * Instagram and Threads write `metrics.get(name) ?? 0`, so a stored zero there
 * cannot be told apart from "the Provider did not return that metric". YouTube,
 * TikTok and Facebook reject an analytics record whose counters are missing, so
 * their zeros are observations. This roster is the only place that distinction is
 * stated; a metric whose every contributing snapshot is an ambiguous zero is
 * omitted and named in the coverage rather than reported as an observed zero.
 */
const ambiguousZeroPlatforms: Readonly<Partial<Record<Platform, true>>> = {
  instagram: true,
  threads: true,
};

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

/** One Platform's gauge as accumulated across the cohort. */
interface EngagementAccumulator {
  asOf: number | null;
  comments: number;
  commentsZeros: number;
  measured: number;
  reactions: number;
  reactionsZeros: number;
  shares: number;
  sharesZeros: number;
  views: number;
  viewsZeros: number;
}

/**
 * Builds one Platform's gauge from the accumulated cohort.
 *
 * A metric is reported only when this Platform could establish it for the
 * contributing Distributions. An unestablished metric is `null` here and named in
 * the coverage, so the payload omits it instead of asserting a zero the Provider
 * never observed.
 */
function gaugeFor(
  accumulator: EngagementAccumulator,
  platform: Platform,
  analyticsSupported: boolean,
): { gauge: UsageEngagement; unsupported: UsageEngagementMetric[] } {
  const ambiguousZeros = ambiguousZeroPlatforms[platform] === true;
  // With ambiguous zeros a metric is established once at least one snapshot
  // contributed a non-zero value; every-zero means "not observed", not "zero".
  const established = (zeros: number): boolean =>
    analyticsSupported && (!ambiguousZeros || zeros < accumulator.measured);
  const unsupported: UsageEngagementMetric[] = [];
  const metrics = {
    comments: established(accumulator.commentsZeros) ? accumulator.comments : null,
    reactions: established(accumulator.reactionsZeros) ? accumulator.reactions : null,
    shares: established(accumulator.sharesZeros) ? accumulator.shares : null,
    views: established(accumulator.viewsZeros) ? accumulator.views : null,
  };
  for (const metric of ["views", "reactions", "comments", "shares"] as const) {
    if (metrics[metric] === null) unsupported.push(metric);
  }
  return {
    gauge: {
      ...metrics,
      asOf: accumulator.asOf === null ? null : new Date(accumulator.asOf).toISOString(),
      distributions: accumulator.measured,
    },
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
        const preferences = yield* Effect.map(
          client.query<PreferencesRow>(
            `SELECT diagnostics_decided_at, diagnostics_interval_started_at, diagnostics_requested,
                    installation_reporting_id, schema_version, usage_decided_at,
                    usage_interval_started_at, usage_requested
             FROM reporting_preferences
             WHERE id`,
          ),
          (result) => result.rows[0] ?? null,
        );
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
        const posts = yield* client.query<PostDayRow>(
          `SELECT (first_confirmed_at AT TIME ZONE 'UTC')::date::text AS report_date,
                  COUNT(*)::int AS posts
           FROM reporting_post_marks
           WHERE counted
             AND first_confirmed_at >= $1
             AND (first_confirmed_at AT TIME ZONE 'UTC')::date = ANY($2::date[])
           GROUP BY 1`,
          [intervalStartedAt, reportDates],
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
      const accumulator = accumulators.get(row.platform) ?? {
        asOf: null,
        comments: 0,
        commentsZeros: 0,
        measured: 0,
        reactions: 0,
        reactionsZeros: 0,
        shares: 0,
        sharesZeros: 0,
        views: 0,
        viewsZeros: 0,
      };
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
      const counters: Array<["views" | "reactions" | "comments" | "shares", unknown]> = [
        ["views", row.views],
        ["reactions", row.likes],
        ["comments", row.comments],
        ["shares", row.shares],
      ];
      for (const [metric, value] of counters) {
        const count = Number(value);
        if (!Number.isFinite(count) || count < 0) continue;
        accumulator[metric] += count;
        if (count === 0) accumulator[`${metric}Zeros`] += 1;
      }
    }
    const engagement: Partial<Record<Platform, UsageEngagement>> = {};
    const unsupportedMetrics = new Set<UsageEngagementMetric>();
    for (const platform of PLATFORM_IDS) {
      const accumulator = accumulators.get(platform);
      // A Platform whose whole cohort answered without a snapshot contributes no
      // gauge at all: the coverage's `missing` count already names it, and a
      // `{distributions: 0}` gauge would read as a measured empty Platform.
      if (!accumulator || accumulator.measured === 0) continue;
      const gauge = gaugeFor(accumulator, platform, analyticsSupported.has(platform));
      engagement[platform] = gauge.gauge;
      for (const metric of gauge.unsupported) unsupportedMetrics.add(metric);
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
            // bound, or both — is named instead of assumed empty.
            missing: cohort.length - measured,
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
