import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { systemPoolFor } from "../src/database";
import type { AutomationEnv } from "../src/env";
import { runRetention } from "../src/retention";
import { runSystemTransaction } from "./system-transaction";
import { fakeR2Bucket } from "./test-doubles";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const organizationId = "20000000-0000-4000-8000-000000000001";

const env = {
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "retention-test",
} satisfies AutomationEnv;

const seededAlphaProfileId = "a0000000-0000-4000-8000-000000000001";

const seededAlphaPostId = "96000000-0000-4000-8000-0000000000a1";
const unscheduledPostId = "96000000-0000-4000-8000-0000000000a2";

const outboxIds = [
  "93000000-0000-4000-8000-000000000041",
  "93000000-0000-4000-8000-000000000042",
  "93000000-0000-4000-8000-000000000043",
];
const usageCorrectionIds = [
  "94000000-0000-4000-8000-000000000041",
  "94000000-0000-4000-8000-000000000042",
  "94000000-0000-4000-8000-000000000043",
];
const webhookEventIds = [
  "retention-integration-old-1",
  "retention-integration-old-2",
  "retention-integration-fresh",
  "retention-integration-processing",
];

const asyncEventKeys = [
  "retention-integration-async-old-1",
  "retention-integration-async-old-2",
  "retention-integration-async-fresh",
];
const distributionId = "96000000-0000-4000-8000-000000000001";
const unscheduledDistributionId = "96000000-0000-4000-8000-000000000002";
const unscheduledSnapshotId = "97000000-0000-4000-8000-000000000003";
const analyticsSnapshotIds = [
  "97000000-0000-4000-8000-000000000001",
  "97000000-0000-4000-8000-000000000002",
];

const idempotencyKeys = [
  "retention-integration-old-1",
  "retention-integration-old-2",
  "retention-integration-fresh",
];

const dueProfileId = "98000000-0000-4000-8000-000000000001";
const dueAssetId = "98000000-0000-4000-8000-000000000002";
const dueAccountId = "98000000-0000-4000-8000-000000000003";
const dueDistributionId = "98000000-0000-4000-8000-000000000004";
const duePostId = "98000000-0000-4000-8000-000000000005";
const retainedProfileId = "98000000-0000-4000-8000-000000000011";
const retainedAssetId = "98000000-0000-4000-8000-000000000012";
const retainedAccountId = "98000000-0000-4000-8000-000000000013";
const retainedDistributionId = "98000000-0000-4000-8000-000000000014";
const retainedPostId = "98000000-0000-4000-8000-000000000015";
const purgeProfileIds = [dueProfileId, retainedProfileId];
const dueObjectIds = [
  "98000000-0000-4000-8000-000000000006",
  "98000000-0000-4000-8000-000000000007",
];
const retainedObjectId = "98000000-0000-4000-8000-000000000016";
const dueR2Keys = [
  "org/20000000-0000-4000-8000-000000000001/assets/98000000-0000-4000-8000-000000000002/due.png",
  "org/20000000-0000-4000-8000-000000000002/assets/98000000-0000-4000-8000-000000000002/due-thumb.png",
];
const retainedR2Key =
  "org/20000000-0000-4000-8000-000000000001/assets/98000000-0000-4000-8000-000000000012/retained.png";

const protectedOrganizationId = "98000000-0000-4000-8000-000000000029";
const protectedChargedBytes = 12_288;
const protectedProfileId = "98000000-0000-4000-8000-000000000021";
const protectedPostId = "98000000-0000-4000-8000-000000000022";
const processingAssetId = "98000000-0000-4000-8000-000000000023";
const heldAssetId = "98000000-0000-4000-8000-000000000024";
const reclaimableAssetId = "98000000-0000-4000-8000-000000000025";
const reclaimableAccountId = "98000000-0000-4000-8000-000000000026";
const reclaimableDistributionId = "98000000-0000-4000-8000-000000000027";
const reclaimableOperationId = "98000000-0000-4000-8000-000000000028";
const processingObjectId = "98000000-0000-4000-8000-000000000031";
const heldObjectId = "98000000-0000-4000-8000-000000000032";
const reclaimableObjectIds = [
  "98000000-0000-4000-8000-000000000033",
  "98000000-0000-4000-8000-000000000034",
  "98000000-0000-4000-8000-000000000035",
];
const reclaimableRenditionId = "98000000-0000-4000-8000-000000000036";
const processingR2Key =
  "org/98000000-0000-4000-8000-000000000029/assets/98000000-0000-4000-8000-000000000023/processing.png";
const heldR2Key =
  "org/98000000-0000-4000-8000-000000000029/assets/98000000-0000-4000-8000-000000000024/held.png";
const reclaimableR2Keys = [
  "org/98000000-0000-4000-8000-000000000029/assets/98000000-0000-4000-8000-000000000025/reclaimable.png",
  "org/98000000-0000-4000-8000-000000000029/assets/98000000-0000-4000-8000-000000000025/reclaimable-thumb.png",
  "org/98000000-0000-4000-8000-000000000029/assets/98000000-0000-4000-8000-000000000025/reclaimable-webp.png",
];
const retainedProfileIds = [...purgeProfileIds, protectedProfileId];

type ProtectedPurgeState = {
  profiles: string;
  posts: string;
  assets: string;
  liveObjects: string;
  deletedObjects: string;
  storageBytes: string;
};

async function readProtectedPurgeState(): Promise<ProtectedPurgeState> {
  return runSystemTransaction(env, async (client) => {
    const state = await client.query<ProtectedPurgeState>(
      `SELECT
         (SELECT count(*)::text FROM brand_profiles WHERE id = $1) AS profiles,
         (SELECT count(*)::text FROM posts WHERE brand_profile_id = $1) AS posts,
         (SELECT count(*)::text FROM assets WHERE brand_profile_id = $1) AS assets,
         (SELECT count(*)::text FROM asset_objects
            WHERE brand_profile_id = $1 AND status <> 'deleted') AS "liveObjects",
         (SELECT count(*)::text FROM asset_objects
            WHERE brand_profile_id = $1 AND status = 'deleted') AS "deletedObjects",
         (SELECT COALESCE(SUM(storage_bytes), 0)::text FROM usage_records
            WHERE org_id = $2) AS "storageBytes"`,
      [protectedProfileId, protectedOrganizationId],
    );
    const [row] = state.rows;
    if (!row) {
      throw new Error("protected purge fixture state is missing");
    }
    return row;
  });
}

describeIntegration("retention cleanup with PostgreSQL", () => {
  beforeAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [protectedOrganizationId]);
      await client.query(
        `DELETE FROM idempotency_keys
         WHERE org_id = $1 AND operation = 'retention.integration'
           AND idempotency_key = ANY($2::text[])`,
        [organizationId, idempotencyKeys],
      );
      await client.query("DELETE FROM analytics_snapshots WHERE id = ANY($1::uuid[])", [
        [...analyticsSnapshotIds, unscheduledSnapshotId],
      ]);
      await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
        [distributionId, unscheduledDistributionId],
      ]);
      await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [
        [seededAlphaPostId, unscheduledPostId],
      ]);
      await client.query("DELETE FROM webhook_events WHERE event_id = ANY($1::text[])", [
        webhookEventIds,
      ]);
      await client.query("DELETE FROM outbox_events WHERE id = ANY($1::uuid[])", [outboxIds]);
      await client.query("DELETE FROM async_job_events WHERE event_key = ANY($1::text[])", [
        asyncEventKeys,
      ]);
      await client.query("DELETE FROM usage_corrections WHERE id = ANY($1::uuid[])", [
        usageCorrectionIds,
      ]);

      await client.query(
        `INSERT INTO idempotency_keys
           (org_id, operation, idempotency_key, request_hash, created_at, expires_at)
         VALUES
           ($1, 'retention.integration', $2, 'retention-hash', now() - INTERVAL '120 days', now() - INTERVAL '31 days'),
           ($1, 'retention.integration', $3, 'retention-hash', now() - INTERVAL '120 days', now() - INTERVAL '31 days'),
           ($1, 'retention.integration', $4, 'retention-hash', now(), now() + INTERVAL '1 day')`,
        [organizationId, ...idempotencyKeys],
      );
      await client.query(
        `INSERT INTO webhook_events
           (id, provider, event_id, event_type, payload_hash, outcome, received_at, processed_at)
         VALUES
           (gen_random_uuid(), 'retention', $1, 'retention.test', 'hash', 'processed', now() - INTERVAL '120 days', now() - INTERVAL '91 days'),
           (gen_random_uuid(), 'retention', $2, 'retention.test', 'hash', 'failed', now() - INTERVAL '120 days', now() - INTERVAL '91 days'),
           (gen_random_uuid(), 'retention', $3, 'retention.test', 'hash', 'ignored', now(), now()),
           (gen_random_uuid(), 'retention', $4, 'retention.test', 'hash', 'processing', now() - INTERVAL '120 days', NULL)`,
        webhookEventIds,
      );
      await client.query(
        `INSERT INTO outbox_events
           (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload,
            state, updated_at)
         VALUES
           ($1, $4, 'telemetry.retention', 'retention', $1, 'retention-old-1', '{}'::jsonb, 'published', now() - INTERVAL '120 days'),
           ($2, $4, 'telemetry.retention', 'retention', $2, 'retention-old-2', '{}'::jsonb, 'published', now() - INTERVAL '120 days'),
           ($3, $4, 'telemetry.retention', 'retention', $3, 'retention-fresh', '{}'::jsonb, 'published', now())`,
        [...outboxIds, organizationId],
      );
      await client.query(
        `INSERT INTO async_job_events
           (event_key, job_type, outcome, processed_at, aggregate_type)
         VALUES
           ($1, 'retention.test', 'succeeded', now() - INTERVAL '60 days', 'system'),
           ($2, 'retention.test', 'skipped', now() - INTERVAL '60 days', 'system'),
           ($3, 'retention.test', 'succeeded', now(), 'system')`,
        asyncEventKeys,
      );
      await client.query(
        `INSERT INTO usage_corrections
           (id, org_id, period, reason, prior_usage, reconciled_usage, evidence, created_at)
         VALUES
           ($1, $4, to_char(current_date - INTERVAL '14 months', 'YYYY-MM'),
            'scheduled_authoritative_reconciliation', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            now() - INTERVAL '14 months'),
           ($2, $4, to_char(current_date - INTERVAL '14 months', 'YYYY-MM'),
            'scheduled_authoritative_reconciliation', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            now() - INTERVAL '14 months'),
           ($3, $4, to_char(current_date, 'YYYY-MM'),
            'scheduled_authoritative_reconciliation', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            now())`,
        [...usageCorrectionIds, organizationId],
      );
      await client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
         VALUES
           ($1, $3, $4, 'Retention analytics fixture', 'Published caption', 'active'),
           ($2, $3, $4, 'Retention unscheduled fixture', 'Unscheduled caption', 'active')`,
        [seededAlphaPostId, unscheduledPostId, organizationId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform, status)
         VALUES
           ($1, $3, $4, $5, 'youtube', 'published'),
           ($2, $3, $4, $6, 'youtube', 'published')`,
        [
          distributionId,
          unscheduledDistributionId,
          organizationId,
          seededAlphaProfileId,
          seededAlphaPostId,
          unscheduledPostId,
        ],
      );
      await client.query(
        `INSERT INTO analytics_snapshots
           (id, distribution_id, org_id, views, snapshot_at)
         VALUES ($1, $2, $3, 42, now() - INTERVAL '400 days')`,
        [unscheduledSnapshotId, unscheduledDistributionId, organizationId],
      );
      await client.query(
        `INSERT INTO analytics_snapshots
           (id, distribution_id, org_id, views, snapshot_at)
         VALUES
           ($1, $4, $3, 10, now() - INTERVAL '10000 days'),
           ($2, $4, $3, 20, now())`,
        [...analyticsSnapshotIds, organizationId, distributionId],
      );
    });
  });

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `DELETE FROM idempotency_keys
         WHERE org_id = $1 AND operation = 'retention.integration'`,
        [organizationId],
      );
      await client.query("DELETE FROM analytics_snapshots WHERE id = ANY($1::uuid[])", [
        [...analyticsSnapshotIds, unscheduledSnapshotId],
      ]);
      await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
        [distributionId, unscheduledDistributionId],
      ]);
      await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [
        [seededAlphaPostId, unscheduledPostId],
      ]);
      await client.query("DELETE FROM webhook_events WHERE event_id = ANY($1::text[])", [
        webhookEventIds,
      ]);
      await client.query("DELETE FROM outbox_events WHERE id = ANY($1::uuid[])", [outboxIds]);
      await client.query("DELETE FROM async_job_events WHERE event_key = ANY($1::text[])", [
        asyncEventKeys,
      ]);
      await client.query("DELETE FROM usage_corrections WHERE id = ANY($1::uuid[])", [
        usageCorrectionIds,
      ]);
      await client.query("DELETE FROM brand_profiles WHERE id = ANY($1::uuid[])", [
        retainedProfileIds,
      ]);
      await client.query("DELETE FROM organizations WHERE id = $1", [protectedOrganizationId]);
    });
    await systemPoolFor(env).end();
  });

  it("deletes bounded old rows while retaining fresh and processing rows", async () => {
    await expect(Effect.runPromise(runRetention(env, { batchSize: 1 }))).resolves.toEqual({
      deleted: 6,
      errors: 0,
    });

    await runSystemTransaction(env, async (client) => {
      const counts = await client.query<{
        idempotency: string;
        webhooks: string;
        outbox: string;
        async_jobs: string;
        corrections: string;
        analytics: string;
      }>(
        `SELECT
          (SELECT count(*)::text FROM idempotency_keys
             WHERE org_id = $1 AND operation = 'retention.integration') AS idempotency,
          (SELECT count(*)::text FROM webhook_events
             WHERE event_id = ANY($2::text[])) AS webhooks,
          (SELECT count(*)::text FROM outbox_events
             WHERE id = ANY($3::uuid[])) AS outbox,
          (SELECT count(*)::text FROM async_job_events
             WHERE event_key = ANY($4::text[])) AS async_jobs,
          (SELECT count(*)::text FROM usage_corrections
             WHERE id = ANY($5::uuid[])) AS corrections,
          (SELECT count(*)::text FROM analytics_snapshots
             WHERE id = ANY($6::uuid[])) AS analytics`,
        [
          organizationId,
          webhookEventIds,
          outboxIds,
          asyncEventKeys,
          usageCorrectionIds,
          analyticsSnapshotIds,
        ],
      );
      expect(counts.rows[0]).toEqual({
        idempotency: "2",
        webhooks: "3",
        outbox: "2",
        async_jobs: "2",
        corrections: "2",
        analytics: "1",
      });
      const snapshots = await client.query<{ id: string }>(
        "SELECT id FROM analytics_snapshots WHERE id = ANY($1::uuid[]) ORDER BY id",
        [analyticsSnapshotIds],
      );
      expect(snapshots.rows).toEqual([{ id: analyticsSnapshotIds[1] }]);
      const survivor = await client.query<{ views: string }>(
        "SELECT views::text AS views FROM analytics_snapshots WHERE id = $1",
        [unscheduledSnapshotId],
      );
      expect(survivor.rows[0]?.views).toBe("42");
    });

    const remainingCleanup = await Effect.runPromise(runRetention(env, { batchSize: 100 }));
    expect(remainingCleanup.errors).toBe(0);
    await runSystemTransaction(env, async (client) => {
      const retained = await client.query<{ count: string }>(
        `SELECT count(*)::text
         FROM webhook_events
         WHERE event_id = ANY($1::text[])`,
        [webhookEventIds],
      );
      expect(retained.rows[0]?.count).toBe("2");
      const processing = await client.query<{ outcome: string }>(
        "SELECT outcome FROM webhook_events WHERE event_id = $1",
        ["retention-integration-processing"],
      );
      expect(processing.rows[0]?.outcome).toBe("processing");
    });
  });

  it("purges only due brand profiles and deletes their stored objects first", async () => {
    const deletedKeys: string[] = [];
    const envWithAssets: AutomationEnv = {
      ...env,
      ASSETS: fakeR2Bucket({
        delete: vi.fn(async (key: string | string[]) => {
          deletedKeys.push(...(Array.isArray(key) ? key : [key]));
        }),
      }),
    };

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color, deleted_at, purge_at)
         VALUES
           ($1, $3, 'Retention Purge Due', '#1d4ed8',
            now() - INTERVAL '8 days', now() - INTERVAL '1 day'),
           ($2, $3, 'Retention Purge Later', '#15803d',
            now(), now() + INTERVAL '7 days')`,
        [dueProfileId, retainedProfileId, organizationId],
      );
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, title, asset_type, file_size, mime_type,
            status, finalized_at)
         VALUES
           ($1, $3, $4, 'due asset', 'image', 4096, 'image/png', 'ready',
            now() - INTERVAL '30 days'),
           ($2, $3, $5, 'retained asset', 'image', 4096, 'image/png', 'ready',
            now() - INTERVAL '30 days')`,
        [dueAssetId, retainedAssetId, organizationId, dueProfileId, retainedProfileId],
      );
      await client.query(
        `INSERT INTO asset_objects
           (id, org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, status)
         VALUES
           ($1, $4, $5, $6, 'original', $7, 4096, 'image/png', 'ready'),
           ($2, $4, $5, $6, 'thumbnail', $8, 0, 'image/png', 'ready'),
           ($3, $4, $9, $10, 'original', $11, 4096, 'image/png', 'ready')`,
        [
          dueObjectIds[0],
          dueObjectIds[1],
          retainedObjectId,
          organizationId,
          dueAssetId,
          dueProfileId,
          dueR2Keys[0],
          dueR2Keys[1],
          retainedAssetId,
          retainedProfileId,
          retainedR2Key,
        ],
      );
      await client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
         VALUES
           ($1, $3, $4, 'Retention purge due', 'Due profile caption', 'active'),
           ($2, $3, $5, 'Retention purge later', 'Later profile caption', 'active')`,
        [duePostId, retainedPostId, organizationId, dueProfileId, retainedProfileId],
      );
      await client.query(
        `INSERT INTO post_attachments
           (post_id, asset_id, org_id, brand_profile_id, position)
         VALUES ($1, $4, $3, $5, 0), ($2, $6, $3, $7, 0)`,
        [
          duePostId,
          retainedPostId,
          organizationId,
          dueAssetId,
          dueProfileId,
          retainedAssetId,
          retainedProfileId,
        ],
      );
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES
           ($1, $3, $4, 'youtube', 'retention-purge-due-yt', 'tok'),
           ($2, $3, $5, 'youtube', 'retention-purge-later-yt', 'tok')`,
        [dueAccountId, retainedAccountId, organizationId, dueProfileId, retainedProfileId],
      );
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id, platform)
         VALUES
           ($1, $3, $4, $5, $6, 'youtube'),
           ($2, $3, $7, $8, $9, 'youtube')`,
        [
          dueDistributionId,
          retainedDistributionId,
          organizationId,
          dueProfileId,
          duePostId,
          dueAccountId,
          retainedProfileId,
          retainedPostId,
          retainedAccountId,
        ],
      );
    });

    const result = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(result.errors).toBe(0);
    expect(deletedKeys.sort()).toEqual([...dueR2Keys].sort());

    await runSystemTransaction(env, async (client) => {
      const remaining = await client.query<{
        profiles: string;
        posts: string;
        assets: string;
        objects: string;
        accounts: string;
        distributions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM brand_profiles
              WHERE id = ANY($1::uuid[])) AS profiles,
           (SELECT count(*)::text FROM posts
              WHERE brand_profile_id = ANY($1::uuid[])) AS posts,
           (SELECT count(*)::text FROM assets
              WHERE brand_profile_id = ANY($1::uuid[])) AS assets,
           (SELECT count(*)::text FROM asset_objects
              WHERE brand_profile_id = ANY($1::uuid[])) AS objects,
           (SELECT count(*)::text FROM platform_accounts
              WHERE brand_profile_id = ANY($1::uuid[])) AS accounts,
           (SELECT count(*)::text FROM distributions
              WHERE brand_profile_id = ANY($1::uuid[])) AS distributions`,
        [purgeProfileIds],
      );
      expect(remaining.rows[0]).toEqual({
        profiles: "1",
        posts: "1",
        assets: "1",
        objects: "1",
        accounts: "1",
        distributions: "1",
      });
      const survivor = await client.query<{ id: string }>(
        "SELECT id FROM brand_profiles WHERE id = ANY($1::uuid[])",
        [purgeProfileIds],
      );
      expect(survivor.rows).toEqual([{ id: retainedProfileId }]);
    });

    const second = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(second.errors).toBe(0);
    expect(deletedKeys.sort()).toEqual([...dueR2Keys].sort());
  });

  it("defers a due profile until active work ends, then purges objects", async () => {
    const deletedKeys: string[] = [];
    let failingKey: string | null = null;
    const envWithAssets: AutomationEnv = {
      ...env,
      ASSETS: fakeR2Bucket({
        delete: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          if (failingKey !== null && keys.includes(failingKey)) {
            throw new Error("storage delete acknowledgement was lost");
          }
          deletedKeys.push(...keys);
        }),
      }),
    };

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Retention Purge Protected', 'retention-purge-protected')`,
        [protectedOrganizationId],
      );
      await client.query(
        `INSERT INTO usage_records
           (org_id, period, uploads, distributions, api_calls, storage_bytes)
         VALUES ($1, to_char(now(), 'YYYY-MM'), 3, 1, 0, $2)`,
        [protectedOrganizationId, protectedChargedBytes],
      );
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color, deleted_at, purge_at)
         VALUES ($1, $2, 'Retention Purge Protected', '#6d28d9',
                 now() - INTERVAL '8 days', now() - INTERVAL '1 day')`,
        [protectedProfileId, protectedOrganizationId],
      );
      await client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
         VALUES ($1, $2, $3, 'Retention purge protected', 'Protected caption', 'active')`,
        [protectedPostId, protectedOrganizationId, protectedProfileId],
      );
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, title, asset_type, file_size, mime_type,
            status, finalized_at, orphaned_at, orphan_delete_after)
         VALUES
           ($3, $1, $2, 'processing asset', 'image', 2048, 'image/png', 'processing',
            now() - INTERVAL '1 day', NULL, NULL),
           ($4, $1, $2, 'provider held asset', 'image', 2048, 'image/png', 'ready',
            now() - INTERVAL '30 days', now() - INTERVAL '30 days',
            now() - INTERVAL '23 days'),
           ($5, $1, $2, 'reclaimable asset', 'image', 8192, 'image/png', 'ready',
            now() - INTERVAL '30 days', now() - INTERVAL '30 days',
            now() - INTERVAL '23 days')`,
        [
          protectedOrganizationId,
          protectedProfileId,
          processingAssetId,
          heldAssetId,
          reclaimableAssetId,
        ],
      );
      await client.query(
        `INSERT INTO asset_objects
           (id, org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
            content_type, status)
         VALUES
           ($4, $1, $3, $2, 'original', NULL, $5, 2048, 'image/png', 'ready'),
           ($7, $1, $6, $2, 'original', NULL, $8, 2048, 'image/png', 'ready'),
           ($9, $1, $10, $2, 'original', NULL, $11, 4096, 'image/png', 'ready'),
           ($12, $1, $10, $2, 'thumbnail', NULL, $13, 0, 'image/png', 'ready'),
           ($14, $1, $10, $2, 'rendition', 'image_webp_1080_long_edge', $15, 4096,
            'image/webp', 'ready')`,
        [
          protectedOrganizationId,
          protectedProfileId,
          processingAssetId,
          processingObjectId,
          processingR2Key,
          heldAssetId,
          heldObjectId,
          heldR2Key,
          reclaimableObjectIds[0],
          reclaimableAssetId,
          reclaimableR2Keys[0],
          reclaimableObjectIds[1],
          reclaimableR2Keys[1],
          reclaimableObjectIds[2],
          reclaimableR2Keys[2],
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (id, org_id, asset_id, brand_profile_id, profile, object_id, status)
         VALUES ($1, $2, $3, $4, 'image_webp_1080_long_edge', $5, 'ready')`,
        [
          reclaimableRenditionId,
          protectedOrganizationId,
          reclaimableAssetId,
          protectedProfileId,
          reclaimableObjectIds[2],
        ],
      );
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES ($1, $2, $3, 'youtube', 'retention-purge-protected-yt', 'tok')`,
        [reclaimableAccountId, protectedOrganizationId, protectedProfileId],
      );
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
            status)
         VALUES ($1, $2, $3, $4, $5, 'youtube', 'awaiting_provider')`,
        [
          reclaimableDistributionId,
          protectedOrganizationId,
          protectedProfileId,
          protectedPostId,
          reclaimableAccountId,
        ],
      );
      await client.query(
        `INSERT INTO provider_operations
           (id, org_id, distribution_id, operation, idempotency_key, status,
            publication_snapshot, media_hold_until, media_asset_ids)
         VALUES ($1, $2, $3, 'publish', 'retention-purge-protected-attempt',
                 'started', $4::jsonb, now() + INTERVAL '1 hour',
                 ARRAY[$5::uuid])`,
        [
          reclaimableOperationId,
          protectedOrganizationId,
          reclaimableDistributionId,
          JSON.stringify({
            default_text: "Protected caption",
            attachment_ids: [heldAssetId],
          }),
          heldAssetId,
        ],
      );
      await client.query(
        `INSERT INTO provider_operation_media
           (operation_id, org_id, distribution_id, asset_id, brand_profile_id,
            object_id, object_key, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
        [
          reclaimableOperationId,
          protectedOrganizationId,
          reclaimableDistributionId,
          heldAssetId,
          protectedProfileId,
          heldObjectId,
          heldR2Key,
        ],
      );
    });

    const deferred = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(deferred.errors).toBe(0);
    expect(deletedKeys).toEqual([]);
    expect(await readProtectedPurgeState()).toEqual({
      profiles: "1",
      posts: "1",
      assets: "3",
      liveObjects: "5",
      deletedObjects: "0",
      storageBytes: protectedChargedBytes.toString(),
    });

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded',
             media_hold_until = now() - INTERVAL '1 minute',
             completed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [reclaimableOperationId],
      );
      await client.query(
        `UPDATE assets
         SET status = 'ready',
             finalized_at = now() - INTERVAL '30 days',
             orphaned_at = now() - INTERVAL '30 days',
             orphan_delete_after = now() - INTERVAL '23 days',
             updated_at = now()
         WHERE id = $1`,
        [processingAssetId],
      );
    });

    failingKey = heldR2Key;
    const interrupted = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(interrupted.errors).toBe(1);
    expect(deletedKeys.sort()).toEqual([processingR2Key, ...reclaimableR2Keys].sort());
    expect(await readProtectedPurgeState()).toEqual({
      profiles: "1",
      posts: "1",
      assets: "3",
      liveObjects: "1",
      deletedObjects: "4",
      storageBytes: "2048",
    });

    failingKey = null;
    const completed = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(completed.errors).toBe(0);
    expect(deletedKeys.sort()).toEqual([processingR2Key, heldR2Key, ...reclaimableR2Keys].sort());
    expect(await readProtectedPurgeState()).toEqual({
      profiles: "0",
      posts: "0",
      assets: "0",
      liveObjects: "0",
      deletedObjects: "0",
      storageBytes: "0",
    });

    const duplicate = await Effect.runPromise(runRetention(envWithAssets, { batchSize: 100 }));
    expect(duplicate.errors).toBe(0);
    expect(deletedKeys.sort()).toEqual([processingR2Key, heldR2Key, ...reclaimableR2Keys].sort());
    expect((await readProtectedPurgeState()).storageBytes).toBe("0");
  });
});
