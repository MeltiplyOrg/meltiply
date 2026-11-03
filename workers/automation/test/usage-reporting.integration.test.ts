import { createHyperdrivePool } from "@meltiply/database";
import { Effect } from "effect";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import {
  REPORTING_DISCLOSURE_VERSION,
  REPORTING_SCHEMA_VERSION,
  recordPublicationUsage,
  reportingConfiguration,
} from "@meltiply/reporting";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { processDistributionMessage } from "../src/distribution";
import { enqueueDailyUsageReport } from "../src/usage-reporting";
import { systemPoolFor, withSystemTransactionEffect } from "../src/database";
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
 * The suite owns a private schema, so every total it asserts is produced by its
 * own fixtures rather than inherited from another suite. Every counting rule is
 * driven through `processDistributionMessage`, so a regression in either
 * success transition fails here.
 */

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

/**
 * This suite runs in its own schema.
 *
 * Publication marks are a domain fact written for every confirmed publish
 * whether or not reporting is enabled, so the other automation suites — which
 * publish against the shared schema before this one runs — necessarily leave
 * marks and daily buckets behind. Measuring absolute totals here would count
 * their work, and clearing those tables would erase their state. A private
 * schema gives this suite an installation of its own instead.
 */
const schema = "usage_reporting_measurement";
const adminConnectionString =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const adminPool = createHyperdrivePool({ connectionString: adminConnectionString });
const baseSystemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
const isolatedDatabase = new URL(baseSystemConnectionString);
isolatedDatabase.searchParams.set("options", `-c search_path=${schema},public`);
const isolatedConnectionString = isolatedDatabase.href;

/** Tables the publish path and the daily producer read or write. */
const copiedTables = [
  "organizations",
  "brand_profiles",
  "platform_accounts",
  "posts",
  "post_attachments",
  "assets",
  "asset_objects",
  "asset_renditions",
  "distributions",
  "provider_operations",
  "provider_operation_media",
  "outbox_events",
  "analytics_snapshots",
  "usage_reconciliation_state",
  "reporting_preferences",
  "reporting_pending_reports",
  "reporting_delivery_receipts",
  "reporting_post_marks",
  "reporting_distribution_marks",
  "reporting_publication_daily",
  "reporting_attribution_responses",
  "rate_limit_budgets",
  "operator_actions",
  "idempotency_keys",
  "async_job_events",
];

const organizationId = "20000000-0000-4000-8000-000000000001";
// This suite's Brand Profile. `platform_accounts_brand_profile_platform_unique`
// allows one Channel per (Brand Profile, Platform), so the two Platforms below
// both hang off this single Profile — the model the measurement describes.
const profileId = "a0000000-0000-4000-8000-0000000000c1";
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
  DB_SYSTEM: { connectionString: isolatedConnectionString } as Hyperdrive,
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
    } satisfies ProviderAdapter);
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
  } satisfies ProviderAdapter);
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
    // A stored request without a supported disclosure decision is not consent:
    // policy reads it as `preference_unavailable` and measures nothing. The
    // real consent endpoint always records the current version, so the fixture
    // must too — the column has no default and would otherwise stay NULL.
    await client.query(
      `INSERT INTO reporting_preferences (
         id, schema_version, usage_requested, usage_disclosure_version,
         usage_decided_at, usage_interval_started_at, installation_reporting_id
       ) VALUES (TRUE, $5, $1, $4, now(), $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         usage_requested = EXCLUDED.usage_requested,
         usage_disclosure_version = EXCLUDED.usage_disclosure_version,
         usage_interval_started_at = EXCLUDED.usage_interval_started_at,
         installation_reporting_id = EXCLUDED.installation_reporting_id`,
      [
        options.requested ?? true,
        options.intervalStartedAt,
        installationReportingId,
        REPORTING_DISCLOSURE_VERSION,
        REPORTING_SCHEMA_VERSION,
      ],
    );
  });
}

/**
 * Creates this suite's Brand Profile, its two Channels, two text-only Posts, one
 * Distribution per Channel, in `queued` state.
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
    await client.query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
    await client.query(
      `INSERT INTO brand_profiles (id, org_id, name, color)
       VALUES ($1, $2, 'Usage Brand', '#1d4ed8')`,
      [profileId, organizationId],
    );
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
      // $1, $2 the Posts; $3, $4 the Workspace and this suite's Brand Profile.
      [postId, threadsPostId, organizationId, profileId],
    );
    await client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, attachment_ids)
       VALUES ($1, $3, $4, $5, $7, 'youtube', 'queued', ARRAY[]::uuid[]),
              ($2, $3, $4, $6, $8, 'threads', 'queued', ARRAY[]::uuid[])`,
      [
        // $1, $2 distributions; $3, $4 the Workspace and this suite's Profile;
        // $5, $6 the two Posts; $7, $8 the two Channels.
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
  const url = new URL(isolatedConnectionString);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/meltiply") {
    throw new Error("Usage measurement tests require the isolated local database.");
  }
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.query(`CREATE SCHEMA ${schema} AUTHORIZATION meltiply_system`);
  for (const table of copiedTables) {
    await adminPool.query(
      `CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
    await adminPool.query(`GRANT ALL ON ${schema}."${table}" TO meltiply_system`);
  }
  // The one row the publish path and the producer both resolve: an active
  // Workspace with an entitled plan. Membership and account rows are not read by
  // either, so they stay out of this fixture.
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `INSERT INTO organizations (id, name, slug, is_shared, plan, billing_status)
       VALUES ($1, 'Usage Workspace', 'usage-workspace', TRUE, 'creator', 'active')`,
      [organizationId],
    );
  });
});

beforeEach(async () => {
  await runSystemTransaction(env, async (client) => {
    // The schema belongs to this suite alone, so the measurement tables hold only
    // what the previous case produced.
    await client.query("DELETE FROM reporting_distribution_marks");
    await client.query("DELETE FROM reporting_post_marks");
    await client.query("DELETE FROM reporting_publication_daily");
    await client.query("DELETE FROM reporting_pending_reports");
    await client.query("DELETE FROM reporting_preferences");
  });
  await seedPublications();
});

afterAll(async () => {
  await systemPoolFor(env).end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
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

  it("counts a new Distribution when a sibling published before measurement existed", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    // An upgrade: this Post already has a published Distribution from a release
    // that predates the measurement, so there is no Post mark for it.
    await runSystemTransaction(env, async (client) => {
      await client.query(`UPDATE distributions SET post_id = $2 WHERE id = $1`, [
        threadsDistributionId,
        postId,
      ]);
      await client.query(
        `UPDATE distributions SET status = 'published', published_at = now() - INTERVAL '30 days'
         WHERE id = $1`,
        [youtubeDistributionId],
      );
    });

    // A second Channel of the same Post publishes after the Owner opted in.
    await publish("threads", "usage-upgrade-sibling", threadsDistributionId);

    // The historical sibling cannot be presented as a new Post, but it must not
    // suppress the Distribution that actually succeeded inside this interval.
    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ distributions: 1, platform: "threads" });
    const postMark = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ counted: boolean }>(
        "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
        [postId],
      );
      return result.rows[0];
    });
    expect(postMark).toEqual({ counted: false });
  });

  it("never mutates an established Post mark when another Channel succeeds", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    await publish("youtube", "usage-mark-first", youtubeDistributionId);
    await runSystemTransaction(env, (client) =>
      client.query(`UPDATE distributions SET post_id = $2 WHERE id = $1`, [
        threadsDistributionId,
        postId,
      ]),
    );
    await publish("threads", "usage-mark-second", threadsDistributionId);

    const postMark = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ counted: boolean }>(
        "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
        [postId],
      );
      return result.rows[0];
    });
    // The first success decided the Post once; the second Channel changes
    // neither that decision nor its own Distribution counter.
    expect(postMark).toEqual({ counted: true });
    const buckets = await dailyBuckets();
    expect(buckets.map((bucket) => [bucket.platform, bucket.distributions])).toEqual([
      ["threads", 1],
      ["youtube", 1],
    ]);
  });

  it("counts a confirmation in the day the measurement actually commits", async () => {
    // A transaction that began before midnight and commits after it must be
    // counted, in the day it truly committed — never dropped because the earlier
    // day was already measured.
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    const nextDay = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    // The measurement seam runs inside a real system transaction so the lock and
    // the savepoint behave as they do in the publication path.
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        recordPublicationUsage(
          client,
          { distributionId: youtubeDistributionId, platform: "youtube", postId },
          reportingConfiguration(env),
          { now: () => nextDay },
        ),
      ),
    );

    const buckets = await dailyBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      distributions: 1,
      platform: "youtube",
      report_date: nextDay.toISOString().slice(0, 10),
    });
    expect(buckets[0]!.report_date).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("includes an in-flight measurement instead of dropping it", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 60_000) });
    // Two Channel successes race the daily producer. The measurement and the
    // producer share one lock, so whichever order they run in, both successes
    // are counted exactly once and the frozen report never omits an increment it
    // could have waited for.
    await runSystemTransaction(env, (client) =>
      client.query(`UPDATE distributions SET post_id = $2 WHERE id = $1`, [
        threadsDistributionId,
        postId,
      ]),
    );

    const measurements = Promise.all([
      publish("youtube", "usage-race-youtube", youtubeDistributionId),
      publish("threads", "usage-race-threads", threadsDistributionId),
    ]);
    const producer = Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );
    await measurements;
    await producer;

    // A second pass (the next scheduled run) must not add a duplicate: both
    // successes were already counted exactly once.
    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );

    const buckets = await dailyBuckets();
    const totals = new Map(buckets.map((bucket) => [bucket.platform, bucket.distributions]));
    expect(totals.get("youtube")).toBe(1);
    expect(totals.get("threads")).toBe(1);
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
    } satisfies ProviderAdapter);

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
    } satisfies ProviderAdapter);

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
      (row) =>
        Object.keys(payloadSection(payloadSection(row.payload.publications).distributions)).length >
        0,
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
      processDistributionMessage(
        forcedOff,
        publishMessage("usage-forceoff", youtubeDistributionId),
        {
          decryptToken: async (stored) => stored,
          providerRegistry: publishRegistry("youtube"),
        },
      ),
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
    // The measurement is credited to the day it committed under the measurement
    // lock, so that is the day the producer must report.
    const measuredDay = new Date().toISOString().slice(0, 10);
    expect(await dailyBuckets()).toHaveLength(1);

    // Freeze "now" to the day after measurement so that day is closed.
    const dayAfter = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const result = await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => dayAfter,
        providerRegistry: registryWithAnalytics(["youtube", "threads"]),
      }),
    );

    expect(result.queued).toBeGreaterThanOrEqual(1);
    const reports = await queuedUsageReports();
    const report = reports.find((row) => row.logical_id.endsWith(`:${measuredDay}`));
    expect(report).toBeDefined();
    expect(report!.payload).toMatchObject({
      report_date: measuredDay,
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

  it("gauges connected Channels, excluding revoked and expired ones", async () => {
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

    // The private schema holds only this suite's Channels, so the baseline is
    // exactly the two seeded here and every move below is an exact count.
    const baseline = await runProducer();
    expect(baseline).toEqual({ threads: 1, youtube: 1 });
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

  it("omits a metric one mixed-cohort contributor could not establish", async () => {
    await seedConsent({ intervalStartedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000) });
    const secondDistributionId = "7e000000-0000-4000-8000-00000000000b";
    // Two published Threads Distributions form one Platform cohort. One carries a
    // decisive snapshot; the other carries the adapter's ambiguous all-zero shape,
    // which cannot be told apart from an absent insight.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
            status, published_at, attachment_ids)
         VALUES ($1, $2, $3, $4, $5, 'threads', 'published', now(), ARRAY[]::uuid[])`,
        [secondDistributionId, organizationId, profileId, postId, threadsChannelId],
      );
      await client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
         VALUES ($1, $2, 120, 7, 4, 1, now() - INTERVAL '3 hours'),
                ($3, $2, 0, 0, 0, 0, now() - INTERVAL '1 hour')`,
        [threadsDistributionId, organizationId, secondDistributionId],
      );
    });

    try {
      await Effect.runPromise(
        enqueueDailyUsageReport(env, {
          now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
          providerRegistry: registryWithAnalytics(["threads"]),
        }),
      );

      const [report] = await queuedUsageReports();
      const gauge = payloadSection(payloadSection(report!.payload.engagement).threads);
      // One contributor established views and the other could not, so any sum
      // would understate the Platform: the metric is omitted, not narrowed.
      expect(gauge.views).toBeUndefined();
      expect(gauge.distributions).toBe(2);
      const coverage = payloadSection(report!.payload.engagement_coverage);
      expect(coverage.unsupported_metrics).toEqual(expect.arrayContaining(["views"]));
      expect(coverage.missing).toBeGreaterThan(0);
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query("DELETE FROM analytics_snapshots WHERE distribution_id = $1", [
          secondDistributionId,
        ]);
        await client.query("DELETE FROM distributions WHERE id = $1", [secondDistributionId]);
      });
    }
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

    // A configured registry without a YouTube adapter: capabilities() reports
    // analytics false for YouTube only because some adapter exists, so this
    // exercises the genuinely unsupported Platform rather than the local fixture
    // fallback that keeps every Platform readable when nothing is configured.
    await Effect.runPromise(
      enqueueDailyUsageReport(env, {
        now: () => new Date(Date.now() + 24 * 60 * 60 * 1_000),
        providerRegistry: registryWithAnalytics(["threads"]),
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
