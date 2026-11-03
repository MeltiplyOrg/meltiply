import { Effect } from "effect";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { processDistributionMessage } from "../src/distribution";
import { enqueueDailyUsageReport } from "../src/usage-reporting";
import { systemPoolFor } from "../src/database";
import { runSystemTransaction } from "./system-transaction";

/**
 * Acceptance coverage for the opt-in daily usage summary.
 *
 * These cases run the real publication entry point and the real scheduled
 * producer against PostgreSQL. They assert the measurements a maintainer
 * dashboard would receive — not merely that an event exists — and they assert
 * the absence of transmission where consent, interval, or confirmation rules say
 * nothing may be counted.
 *
 * The channels gauge and the engagement gauges are covered by the seeded
 * fixtures; every counting rule below is driven through
 * `processDistributionMessage`, so a regression in either success transition
 * fails here.
 */

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const organizationId = "20000000-0000-4000-8000-000000000001";
const profileId = "a0000000-0000-4000-8000-000000000001";
const youtubeChannelId = "5e000000-0000-4000-8000-000000000001";
const threadsChannelId = "5e000000-0000-4000-8000-000000000002";
const installationReportingId = "6f1d3a6c-4b1e-4e2b-9a67-2f5c1d9b8a01";

const postId = "7a000000-0000-4000-8000-000000000001";
const threadsPostId = "7a000000-0000-4000-8000-000000000002";
const youtubeDistributionId = "7e000000-0000-4000-8000-000000000001";
const threadsDistributionId = "7e000000-0000-4000-8000-000000000002";
const distributionIds = [youtubeDistributionId, threadsDistributionId];
const postIds = [postId, threadsPostId];

/** A text-only Post needs no Asset, so these fixtures never touch media. */
const env: AutomationEnv = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  DEPLOYMENT_CATEGORY: "selfhosted",
  ENVIRONMENT: "test",
  // A valid destination makes the usage category effective; these suites only
  // enqueue, so nothing is ever sent from here.
  REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
  REPORTING_POSTHOG_PROJECT_TOKEN: "phc_usageIntegrationToken",
  VERSION: "1.0.0-target.0",
};

/** A registry whose Platforms declare analytics support, without any Provider I/O. */
function registryWithAnalytics(platforms: Array<"threads" | "youtube">): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const platform of platforms) {
    registry.register(platform, {
      capability: {
        accepted_mime_types: [],
        analytics: true,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: 1,
        max_media_count: 1,
        max_video_duration_sec: null,
        min_media_count: 0,
        multi_asset_types: [],
        notes: [],
        platform,
        publish: false,
        reply: false,
      },
      // Reporting must never read analytics from a Provider. A call here fails
      // the suite outright, which is stronger than asserting a spy count.
      listAnalytics: async () => {
        throw new Error("reporting must not call listAnalytics");
      },
      transferModes: [],
    } as unknown as ProviderAdapter);
  }
  return registry;
}

/** The publish adapter used to drive the real success transition. */
function publishRegistry(platform: "threads" | "youtube") {
  const registry = new ProviderRegistry();
  registry.register(platform, {
    capability: {
      accepted_mime_types: [],
      analytics: true,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: 1,
      max_media_count: 1,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: [],
      platform,
      publish: true,
      reply: false,
    },
    listAnalytics: async () => {
      throw new Error("reporting must not call listAnalytics");
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish: async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: `provider-${platform}-post`,
    }),
    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: [],
  } as unknown as ProviderAdapter);
  return registry;
}

/** One publish trigger for a Distribution. */
function publishMessage(eventId: string, distributionId: string): OutboxMessage {
  return {
    aggregate_id: distributionId,
    event_id: eventId,
    organization_id: organizationId,
    payload: { distribution_id: distributionId, version: 1 },
    topic: "distribution.publish.requested",
    type: "outbox.event",
    version: 1,
  };
}

/** One reconciliation trigger for a Distribution. */
function reconcileMessage(eventId: string, distributionId: string): OutboxMessage {
  return { ...publishMessage(eventId, distributionId), topic: "distribution.reconcile.requested" };
}

/**
 * Seeds one Owner consent row.
 *
 * @param options - Whether usage is requested, and the instant its interval began.
 */
async function seedConsent(options: {
  intervalStartedAt: Date | string | null;
  requested?: boolean;
}): Promise<void> {
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `INSERT INTO reporting_preferences (
         id, schema_version, usage_requested, usage_decided_at,
         usage_interval_started_at, installation_reporting_id
       ) VALUES (TRUE, 1, $1, now(), $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         usage_requested = EXCLUDED.usage_requested,
         usage_interval_started_at = EXCLUDED.usage_interval_started_at,
         installation_reporting_id = EXCLUDED.installation_reporting_id`,
      [options.requested ?? true, options.intervalStartedAt, installationReportingId],
    );
  });
}

/**
 * Creates the two dedicated Channels plus two text-only Posts, one Distribution
 * per Channel, in `queued` state.
 *
 * Text-only Posts need no Asset, so these fixtures never touch media. The two
 * Channels use distinct Platforms because
 * `distributions_post_platform_account_unique` allows one Distribution per
 * (Post, Channel), which is what lets the multichannel case repoint both rows at
 * one Post.
 */
async function seedPublications(): Promise<void> {
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])", [
      distributionIds,
    ]);
    await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [distributionIds]);
    await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
    await client.query("DELETE FROM platform_accounts WHERE id = ANY($1::uuid[])", [
      [youtubeChannelId, threadsChannelId],
    ]);
    await client.query(
      `INSERT INTO platform_accounts
         (id, org_id, brand_profile_id, platform, platform_user_id, display_name,
          access_token, scopes, connection_status)
       VALUES ($1, $3, $4, 'youtube', 'local-usage-integration-youtube',
               'Usage YouTube', 'local-only-not-a-provider-credential',
               ARRAY['youtube.upload'], 'connected'),
              ($2, $3, $4, 'threads', 'local-usage-integration-threads',
               'Usage Threads', 'local-only-not-a-provider-credential',
               ARRAY['threads_basic'], 'connected')`,
      [youtubeChannelId, threadsChannelId, organizationId, profileId],
    );
    await client.query(
      `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
       VALUES ($1, $3, $4, 'Usage one', 'Caption one', 'active'),
              ($2, $3, $4, 'Usage two', 'Caption two', 'active')`,
      [postId, threadsPostId, organizationId, profileId],
    );
    await client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, attachment_ids)
       VALUES ($1, $5, $6, $7, $9, 'youtube', 'queued', ARRAY[]::uuid[]),
              ($2, $5, $6, $8, $10, 'threads', 'queued', ARRAY[]::uuid[])`,
      [
        youtubeDistributionId,
        threadsDistributionId,
        organizationId,
        profileId,
        postId,
        threadsPostId,
        youtubeChannelId,
        threadsChannelId,
      ],
    );
  });
}

/** Reads the daily buckets exactly as stored. */
async function dailyBuckets() {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<{
      distributions: number;
      interval_started_at: Date;
      platform: string;
      report_date: string;
    }>(
      `SELECT interval_started_at, report_date::text AS report_date, platform, distributions
       FROM reporting_publication_daily
       ORDER BY report_date, platform`,
    );
    return result.rows;
  });
}

/** Reads the durable dedup marks. */
async function marks() {
  return runSystemTransaction(env, async (client) => {
    const posts = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reporting_post_marks",
    );
    const distributions = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reporting_distribution_marks",
    );
    return {
      distributions: Number(distributions.rows[0]?.count ?? "0"),
      posts: Number(posts.rows[0]?.count ?? "0"),
    };
  });
}

/** Publishes one Distribution through the production entry point. */
async function publish(
  platform: "threads" | "youtube",
  eventId: string,
  distributionId: string,
): Promise<"processed" | "skipped"> {
  return Effect.runPromise(
    processDistributionMessage(env, publishMessage(eventId, distributionId), {
      decryptToken: async (stored) => stored,
      providerRegistry: publishRegistry(platform),
    }),
  );
}

/** Reads the queued usage payloads the producer wrote. */
async function queuedUsageReports() {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<{
      logical_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT logical_id, payload FROM reporting_pending_reports
       WHERE category = 'usage' AND state = 'pending'
       ORDER BY logical_id`,
    );
    return result.rows;
  });
}

/**
 * Reads one nested object from a persisted payload column.
 *
 * JSONB is boundary data: the shape is validated by the reporting module's
 * allowlist before it is stored, so this narrows to a plain record for assertions
 * instead of asserting each nested member type.
 */
function payloadSection(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a per-Platform counter map from a payload section. */
function platformCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [platform, count] of Object.entries(payloadSection(value))) {
    if (typeof count === "number") counts[platform] = count;
  }
  return counts;
}

beforeAll(async () => {
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `UPDATE organizations
       SET plan = 'creator', billing_status = 'active', updated_at = now()
       WHERE id = $1`,
      [organizationId],
    );
  });
});

beforeEach(async () => {
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM reporting_pending_reports");
    await client.query("DELETE FROM reporting_preferences");
    await client.query("DELETE FROM reporting_publication_daily");
    await client.query("DELETE FROM reporting_distribution_marks");
    await client.query("DELETE FROM reporting_post_marks");
  });
  await seedPublications();
});

afterAll(async () => {
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])", [
      distributionIds,
    ]);
    await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [distributionIds]);
    await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
    await client.query("DELETE FROM reporting_pending_reports");
    await client.query("DELETE FROM reporting_preferences");
    await client.query("DELETE FROM reporting_publication_daily");
    await client.query("DELETE FROM reporting_distribution_marks");
    await client.query("DELETE FROM reporting_post_marks");
  });
  await systemPoolFor(env).end();
});

describe("usage publication measurement with PostgreSQL", () => {
  it("counts one Post and two Distributions when one Post publishes to two Channels", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET post_id = $2
         WHERE id = ANY($1::uuid[])`,
        [distributionIds, postId],
      ),
    );

    await publish("youtube", "usage-multichannel-youtube", youtubeDistributionId);
    await publish("threads", "usage-multichannel-threads", threadsDistributionId);

    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(2);
    expect(buckets.map((bucket) => [bucket.platform, bucket.distributions])).toEqual([
      ["threads", 1],
      ["youtube", 1],
    ]);
    // One Post mark, two Distribution marks: the Post was counted once even
    // though two success transitions observed it.
    expect(await marks()).toEqual({ distributions: 2, posts: 1 });
  });

  it("counts nothing for an attempt that stayed queued or failed", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    const failureRegistry = new ProviderRegistry();
    failureRegistry.register("youtube", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: 1,
        max_media_count: 1,
        max_video_duration_sec: null,
        min_media_count: 0,
        multi_asset_types: [],
        notes: [],
        platform: "youtube",
        publish: true,
        reply: false,
      },
      lookupPublication: async () => ({ state: "not_found" }),
      publish: async () => ({
        failure: {
          classification: "transient" as const,
          code: "provider_unavailable",
          message: "The provider is unavailable.",
          retryable: true,
        },
        outcome: "confirmed_failure" as const,
      }),
      retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
      transferModes: [],
    } as unknown as ProviderAdapter);

    await Effect.runPromise(
      processDistributionMessage(env, publishMessage("usage-failure", youtubeDistributionId), {
        decryptToken: async (stored) => stored,
        providerRegistry: failureRegistry,
      }),
    );

    expect(await dailyBuckets()).toEqual([]);
    // A failed attempt is not an observed success, so it leaves no mark either.
    expect(await marks()).toEqual({ distributions: 0, posts: 0 });
  });

  it("counts an ambiguous outcome only once reconciliation confirms it", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    const ambiguousRegistry = new ProviderRegistry();
    ambiguousRegistry.register("youtube", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: 1,
        max_media_count: 1,
        max_video_duration_sec: null,
        min_media_count: 0,
        multi_asset_types: [],
        notes: [],
        platform: "youtube",
        publish: true,
        reply: false,
      },
      lookupPublication: async () => ({
        state: "published" as const,
        result: {
          outcome: "confirmed_success" as const,
          providerOperationId: "provider-operation-1",
          providerPostId: "provider-post-late",
        },
      }),
      publish: async () => ({
        failure: {
          classification: "ambiguous" as const,
          code: "provider_outcome_ambiguous",
          message: "The provider outcome is uncertain.",
          retryable: false,
        },
        outcome: "unknown" as const,
      }),
      retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
      transferModes: [],
    } as unknown as ProviderAdapter);

    await Effect.runPromise(
      processDistributionMessage(env, publishMessage("usage-ambiguous", youtubeDistributionId), {
        decryptToken: async (stored) => stored,
        providerRegistry: ambiguousRegistry,
      }),
    );
    // The publish attempt left the row ambiguous: no counting yet.
    expect(await dailyBuckets()).toEqual([]);

    await Effect.runPromise(
      processDistributionMessage(env, reconcileMessage("usage-reconcile", youtubeDistributionId), {
        decryptToken: async (stored) => stored,
        providerRegistry: ambiguousRegistry,
      }),
    );

    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ distributions: 1, platform: "youtube" });

    // A second reconciliation of the same published row must not increment again.
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET status = 'needs_reconciliation'
         WHERE id = $1`,
        [youtubeDistributionId],
      ),
    );
    await Effect.runPromise(
      processDistributionMessage(
        env,
        reconcileMessage("usage-reconcile-again", youtubeDistributionId),
        { decryptToken: async (stored) => stored, providerRegistry: ambiguousRegistry },
      ),
    );
    expect((await dailyBuckets())[0]).toMatchObject({ distributions: 1 });
    expect(await marks()).toEqual({ distributions: 1, posts: 1 });
  });

  it("keeps the measured counters after the Post is deleted", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    await publish("youtube", "usage-deletion", youtubeDistributionId);
    expect((await dailyBuckets())[0]).toMatchObject({ distributions: 1 });

    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM provider_operations WHERE distribution_id = $1", [
        youtubeDistributionId,
      ]);
      await client.query("DELETE FROM distributions WHERE post_id = $1", [postId]);
      await client.query("DELETE FROM posts WHERE id = $1", [postId]);
    });

    // The aggregate is a local measurement, not a projection of live content.
    expect((await dailyBuckets())[0]).toMatchObject({ distributions: 1 });
    expect(await marks()).toEqual({ distributions: 1, posts: 1 });
  });

  it("does not count a publication that succeeded before consent", async () => {
    // The Post's first success happens while reporting is off.
    await publish("youtube", "usage-preconsent-first", youtubeDistributionId);
    expect(await dailyBuckets()).toEqual([]);
    expect(await marks()).toEqual({ distributions: 1, posts: 1 });

    // Consent arrives afterwards; a second Distribution of the same Post
    // succeeds inside the new interval.
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    await runSystemTransaction(env, (client) =>
      client.query(`UPDATE distributions SET post_id = $2 WHERE id = $1`, [
        threadsDistributionId,
        postId,
      ]),
    );
    await publish("threads", "usage-preconsent-second", threadsDistributionId);

    // The second success counts as a Distribution, but the Post's first success
    // was outside every interval, so it must not be presented as a new Post.
    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ distributions: 1, platform: "threads" });
    expect(await marks()).toEqual({ distributions: 2, posts: 1 });
    const counted = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ counted: boolean }>(
        "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
        [postId],
      );
      return result.rows[0]?.counted;
    });
    expect(counted).toBe(false);

    // A later report for that day must therefore show no Post.
    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["threads", "youtube"]),
      }),
    );
    const reports = await queuedUsageReports();
    const threadReport = reports.find(
      (row) => Object.keys(payloadSection(payloadSection(row.payload.publications).distributions)).length > 0,
    );
    const posts = payloadSection(threadReport!.payload.publications).posts;
    expect(posts).toBe(0);
  });

  it("does not count confirmations outside the enabled interval", async () => {
    // An interval that starts in the future cannot cover a success happening now.
    await seedConsent({ intervalStartedAt: new Date(Date.now() + 60 * 60 * 1_000) });
    await publish("youtube", "usage-future-interval", youtubeDistributionId);

    expect(await dailyBuckets()).toEqual([]);
    // The domain mark is still written: the observation happened.
    expect(await marks()).toEqual({ distributions: 1, posts: 1 });
  });

  it("counts again in a new interval after a withdrawal and re-enable", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 120_000) });
    await publish("youtube", "usage-interval-one", youtubeDistributionId);
    const firstInterval = (await dailyBuckets())[0]!.interval_started_at;

    // Withdrawal, then a fresh consent interval beginning a moment later. The
    // second Distribution belongs to a different Post, so its Post mark is new.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE reporting_preferences
         SET usage_requested = FALSE, usage_interval_started_at = NULL`,
      );
      await client.query(`UPDATE distributions SET post_id = $2 WHERE id = $1`, [
        threadsDistributionId,
        threadsPostId,
      ]);
    });
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 1_000) });
    await publish("threads", "usage-interval-two", threadsDistributionId);

    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(2);
    // The re-enabled interval carries its own row rather than extending the
    // withdrawn one, so declined activity is never replayed into it.
    expect(new Set(buckets.map((bucket) => bucket.interval_started_at.getTime())).size).toBe(2);
    expect(buckets.find((bucket) => bucket.platform === "threads")).toMatchObject({
      distributions: 1,
    });
    const reenabled = buckets.find((bucket) => bucket.platform === "threads")!;
    expect(reenabled.interval_started_at.getTime()).toBeGreaterThan(firstInterval.getTime());
  });

  it("does not count when the operator forces reporting off", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    const forcedOff: AutomationEnv = { ...env, REPORTING_FORCED_OFF: "true" };

    await Effect.runPromise(
      processDistributionMessage(forcedOff, publishMessage("usage-forceoff", youtubeDistributionId), {
        decryptToken: async (stored) => stored,
        providerRegistry: publishRegistry("youtube"),
      }),
    );

    // Operator policy outranks the saved choice, so no aggregate advanced.
    expect(await dailyBuckets()).toEqual([]);
    // The publication itself still succeeded.
    const status = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ status: string }>(
        "SELECT status FROM distributions WHERE id = $1",
        [youtubeDistributionId],
      );
      return result.rows[0]?.status;
    });
    expect(status).toBe("published");
  });
});

describe("daily usage producer with PostgreSQL", () => {
  it("queues one frozen report for a closed UTC day", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-producer", youtubeDistributionId);
    const publishedAt = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ published_at: Date }>(
        "SELECT published_at FROM distributions WHERE id = $1",
        [youtubeDistributionId],
      );
      return result.rows[0]!.published_at;
    });

    // Freeze "now" to the day after publication so that day is closed.
    const dayAfter = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1_000);
    const result = await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => dayAfter,
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );

    expect(result.queued).toBeGreaterThanOrEqual(1);
    const reports = await queuedUsageReports();
    const publishedDay = publishedAt.toISOString().slice(0, 10);
    const report = reports.find((row) => row.logical_id.endsWith(`:${publishedDay}`));
    expect(report).toBeDefined();
    expect(report!.payload).toMatchObject({
      report_date: publishedDay,
      publications: { distributions: { youtube: 1 }, posts: 1 },
    });
  });

  it("reuses one report identity when a scheduled run repeats", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-duplicate", youtubeDistributionId);
    const now = () => new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const dependencies = {
      now,
      providerRegistry: registryWithAnalytics(["youtube"]),
    };

    await Effect.runPromise(enqueueDailyUsageReport(env, dependencies));
    const first = await queuedUsageReports();
    await Effect.runPromise(enqueueDailyUsageReport(env, dependencies));
    const second = await queuedUsageReports();

    expect(second).toEqual(first);
  });

  it("never reports an open UTC day", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-open-day", youtubeDistributionId);
    // "Now" is still the publication day, so that day has not closed.
    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(),
        providerRegistry: registryWithAnalytics(["youtube"]),
      }),
    );
    const today = new Date().toISOString().slice(0, 10);
    const reports = await queuedUsageReports();
    expect(reports.some((row) => row.payload.report_date === today)).toBe(false);
  });

  it("queues nothing when usage reporting is not effective", async () => {
    await seedConsent({ requested: false, intervalStartedAt: null });
    await publish("youtube", "usage-not-opted-in", youtubeDistributionId);
    const result = await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube"]),
      }),
    );
    expect(result).toEqual({ considered: 0, queued: 0 });
    expect(await queuedUsageReports()).toEqual([]);
  });

  it("gauges connected Channels from the canonical state, excluding revoked and expired", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    const runProducer = async () => {
      await Effect.runPromise(
        enqueueDailyUsageReport(env, {
          now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
          providerRegistry: registryWithAnalytics(["youtube", "threads"]),
        }),
      );
      const [report] = await queuedUsageReports();
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM reporting_pending_reports"),
      );
      return platformCounts(report!.payload.channels);
    };

    // The seeded database owns several Channels per Platform, so this asserts
    // deltas against the canonical state rather than absolute totals.
    const baseline = await runProducer();
    expect(baseline.youtube).toBeGreaterThanOrEqual(1);

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE platform_accounts
         SET connection_status = 'revoked', revoked_at = now()
         WHERE id = $1`,
        [youtubeChannelId],
      );
    });
    const revoked = await runProducer();
    // A revoked Channel vacates occupancy immediately.
    expect(revoked.youtube ?? 0).toBe((baseline.youtube ?? 0) - 1);

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE platform_accounts
         SET connection_status = 'expired', revoked_at = NULL,
             token_expires_at = now() - INTERVAL '1 minute'
         WHERE id = $1`,
        [youtubeChannelId],
      );
    });
    const expired = await runProducer();
    // An expired authorization is not a usable connection either.
    expect(expired.youtube ?? 0).toBe(revoked.youtube ?? 0);

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE platform_accounts
         SET connection_status = 'expiring', token_expires_at = NULL
         WHERE id = $1`,
        [youtubeChannelId],
      );
    });
    const expiring = await runProducer();
    // `expiring` still authorizes publishing, so it is occupancy again.
    expect(expiring.youtube ?? 0).toBe((revoked.youtube ?? 0) + 1);
  });

  it("reports only the latest stored snapshot and never substitutes reach for views", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-analytics", youtubeDistributionId);
    await runSystemTransaction(env, async (client) => {
      // Two cumulative snapshots; only the newer one may contribute.
      await client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, reach,
            impressions, snapshot_at)
         VALUES ($1, $2, 100, 5, 2, 1, 900, 950, now() - INTERVAL '2 hours'),
                ($1, $2, 160, 9, 3, 2, 900, 950, now() - INTERVAL '1 hour')`,
        [youtubeDistributionId, organizationId],
      );
    });

    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube"]),
      }),
    );

    const [report] = await queuedUsageReports();
    const engagement = payloadSection(report!.payload.engagement);
    expect(engagement.youtube).toMatchObject({
      comments: 3,
      distributions: 1,
      reactions: 9,
      shares: 2,
      views: 160,
    });
    // Reach and impressions are never relabelled as views.
    expect(payloadSection(engagement.youtube).views).not.toBe(900);
    expect(payloadSection(report!.payload.engagement_coverage).measured).toBe(1);
  });

  it("keeps a downward correction instead of accumulating it", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-correction", youtubeDistributionId);
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
         VALUES ($1, $2, 500, 40, 10, 5, now() - INTERVAL '2 hours'),
                ($1, $2, 480, 39, 10, 5, now() - INTERVAL '1 hour')`,
        [youtubeDistributionId, organizationId],
      );
    });

    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube"]),
      }),
    );

    const [report] = await queuedUsageReports();
    const gauge = payloadSection(payloadSection(report!.payload.engagement).youtube);
    expect(gauge.views).toBe(480);
    expect(gauge.reactions).toBe(39);
  });

  it("omits an unmeasured metric and names it in the coverage", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("threads", "usage-unsupported", threadsDistributionId);
    await runSystemTransaction(env, async (client) => {
      // Threads' adapter normalizes an absent insight to 0, so an all-zero
      // snapshot cannot establish any counter.
      await client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
         VALUES ($1, $2, 0, 0, 0, 0, now() - INTERVAL '1 hour')`,
        [threadsDistributionId, organizationId],
      );
    });

    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );

    const [report] = await queuedUsageReports();
    const gauge = payloadSection(payloadSection(report!.payload.engagement).threads);
    expect(gauge.views).toBeUndefined();
    expect(gauge.reactions).toBeUndefined();
    expect(gauge.distributions).toBe(1);
    const coverage = payloadSection(report!.payload.engagement_coverage);
    expect(coverage.unsupported_metrics).toEqual(
      expect.arrayContaining(["views", "reactions", "comments", "shares"]),
    );
  });

  it("reports a Platform with no analytics capability as unsupported, not zero", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-no-capability", youtubeDistributionId);
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
         VALUES ($1, $2, 10, 1, 1, 1, now() - INTERVAL '1 hour')`,
        [youtubeDistributionId, organizationId],
      );
    });

    // A registry with no YouTube adapter: the Platform cannot establish any
    // metric, so the gauge omits them instead of trusting stored columns.
    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: new ProviderRegistry(),
      }),
    );

    const [report] = await queuedUsageReports();
    const gauge = payloadSection(payloadSection(report!.payload.engagement).youtube);
    expect(gauge.views).toBeUndefined();
    expect(gauge.distributions).toBe(1);
  });

  it("reports a Distribution with no snapshot as coverage-missing", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    await publish("youtube", "usage-missing-snapshot", youtubeDistributionId);
    await publish("threads", "usage-missing-snapshot-threads", threadsDistributionId);

    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );

    const [report] = await queuedUsageReports();
    const coverage = payloadSection(report!.payload.engagement_coverage);
    expect(coverage.measured).toBe(0);
    expect(coverage.missing).toBeGreaterThanOrEqual(2);
  });
});
