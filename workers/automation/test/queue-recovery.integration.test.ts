import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import type { ObjectStore } from "@meltiply/storage";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createAssetJobProcessor, rearmStuckAssetJobs } from "../src/assets";
import { withSystemTransactionEffect } from "../src/database";
import { enqueueDueDistributions } from "../src/distribution";
import { createPublishQueueResolverLive, createQueuePublisherLive } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { relayOutbox } from "../src/outbox";
import { armDistributionReconcile } from "../src/outbox-commands";
import { publishingQueueFor } from "../src/publish-queues";
import { runSystemTransaction } from "./system-transaction";

const organizationId = "9c000000-0000-4000-8000-000000000001";
const brandProfileId = "9c000000-0000-4000-8000-000000000002";
const postId = "9c000000-0000-4000-8000-000000000003";
const env = {
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "queue-recovery-test",
} satisfies AutomationEnv;

interface EventRow extends Record<string, unknown> {
  attempt_count: number;
  available_at: Date | null;
  id: string;
  lease_expires_at: Date | null;
  state: string;
}

async function insertEvent(input: {
  aggregateId: string;
  aggregateType: "asset" | "distribution";
  attemptCount?: number;
  dedupeKey: string;
  leaseExpiredHoursAgo?: number;
  state: "leased" | "published";
  topic: string;
  updatedHoursAgo?: number;
}): Promise<string> {
  const inserted = await runSystemTransaction(env, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state,
          attempt_count, lease_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7,
               CASE WHEN $8::integer IS NULL THEN NULL
                    ELSE now() - ($8 * INTERVAL '1 hour') END,
               now() - ($9 * INTERVAL '1 hour'))
       RETURNING id`,
      [
        organizationId,
        input.topic,
        input.aggregateType,
        input.aggregateId,
        input.dedupeKey,
        input.state,
        input.attemptCount ?? 1,
        input.leaseExpiredHoursAgo ?? null,
        input.updatedHoursAgo ?? 0,
      ],
    ),
  );
  return inserted.rows[0]!.id;
}

async function eventByKey(dedupeKey: string): Promise<EventRow> {
  const result = await runSystemTransaction(env, (client) =>
    client.query<EventRow>(
      `SELECT id, state, attempt_count, available_at, lease_expires_at
       FROM outbox_events WHERE org_id = $1 AND dedupe_key = $2`,
      [organizationId, dedupeKey],
    ),
  );
  return result.rows[0]!;
}

async function insertDistribution(id: string): Promise<void> {
  await runSystemTransaction(env, (client) =>
    client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform, status,
          reconciliation_attempt_count, next_attempt_at, updated_at)
       VALUES ($1, $2, $3, $4, 'youtube', 'needs_reconciliation', 0,
               now() - INTERVAL '1 minute', now() - INTERVAL '10 minutes')`,
      [id, organizationId, brandProfileId, postId],
    ),
  );
}

async function insertAsset(
  id: string,
  status: "deleting" | "processing",
  mimeType: string | null,
): Promise<void> {
  await runSystemTransaction(env, (client) =>
    client.query(
      `INSERT INTO assets (id, org_id, brand_profile_id, title, asset_type, status, mime_type,
                           updated_at)
       VALUES ($1, $2, $3, 'Recovery fixture', 'image', $4, $5, now() - INTERVAL '1 hour')`,
      [id, organizationId, brandProfileId, status, mimeType],
    ),
  );
}

describe("queue recovery with PostgreSQL", () => {
  beforeAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Queue recovery fixture', 'queue-recovery-fixture')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Queue recovery', '#1d4ed8')`,
        [brandProfileId, organizationId],
      );
      await client.query("INSERT INTO posts (id, org_id, brand_profile_id) VALUES ($1, $2, $3)", [
        postId,
        organizationId,
        brandProfileId,
      ]);
    });
  });

  afterAll(async () => {
    await runSystemTransaction(env, (client) =>
      client.query("DELETE FROM organizations WHERE id = $1", [organizationId]),
    );
  });

  it("dead-letters a lease that expired on the final delivery attempt", async () => {
    const dedupeKey = "queue-recovery:exhausted-lease";
    await insertEvent({
      aggregateId: "9c000000-0000-4000-8000-000000000010",
      aggregateType: "asset",
      attemptCount: 10,
      dedupeKey,
      leaseExpiredHoursAgo: 1,
      state: "leased",
      topic: "asset.processing.requested",
    });

    await Effect.runPromise(
      Effect.provide(
        relayOutbox(env, 100),
        Layer.mergeAll(
          createQueuePublisherLive(),
          createPublishQueueResolverLive((platform) => publishingQueueFor(env, platform)),
        ),
      ),
    );

    expect(await eventByKey(dedupeKey)).toMatchObject({
      available_at: null,
      lease_expires_at: null,
      state: "dead",
    });
  });

  it("gives a consumed reconcile key a new event identity for the next publish attempt", async () => {
    const distributionId = "9c000000-0000-4000-8000-000000000020";
    const dedupeKey = `distribution:${distributionId}:reconcile:1`;
    await insertDistribution(distributionId);
    const consumedId = await insertEvent({
      aggregateId: distributionId,
      aggregateType: "distribution",
      dedupeKey,
      state: "published",
      topic: "distribution.reconcile.requested",
    });
    const arm = () =>
      Effect.runPromise(
        withSystemTransactionEffect(env, (client) =>
          armDistributionReconcile(client, {
            completedAttempts: 0,
            distributionId,
            orgId: organizationId,
          }),
        ),
      );

    await arm();
    const rearmed = await eventByKey(dedupeKey);
    expect(rearmed.id).not.toBe(consumedId);
    expect(rearmed).toMatchObject({ attempt_count: 0, state: "pending" });

    await arm();
    expect((await eventByKey(dedupeKey)).id).toBe(rearmed.id);
  });

  it("revives a lost due-work trigger under a new event identity", async () => {
    const distributionId = "9c000000-0000-4000-8000-000000000030";
    const dedupeKey = `distribution:${distributionId}:reconcile:1`;
    await insertDistribution(distributionId);
    const lostId = await insertEvent({
      aggregateId: distributionId,
      aggregateType: "distribution",
      dedupeKey,
      state: "published",
      topic: "distribution.reconcile.requested",
      updatedHoursAgo: 48,
    });

    await Effect.runPromise(enqueueDueDistributions(env, 100));

    const revived = await eventByKey(dedupeKey);
    expect(revived.id).not.toBe(lostId);
    expect(revived.state).toBe("pending");
  });

  it("re-arms a stuck asset whose recovery event was already delivered", async () => {
    const assetId = "9c000000-0000-4000-8000-000000000040";
    const dedupeKey = `asset:${assetId}:lifecycle-recovery:deleting`;
    await insertAsset(assetId, "deleting", "image/png");
    const deliveredId = await insertEvent({
      aggregateId: assetId,
      aggregateType: "asset",
      dedupeKey,
      state: "published",
      topic: "asset.deletion.requested",
      updatedHoursAgo: 48,
    });

    await Effect.runPromise(rearmStuckAssetJobs(env));

    const rearmed = await eventByKey(dedupeKey);
    expect(rearmed.id).not.toBe(deliveredId);
    expect(rearmed.state).toBe("pending");
  });

  it("starts the orphan clock when a terminal failure bypasses media processing", async () => {
    const assetId = "9c000000-0000-4000-8000-000000000050";
    await insertAsset(assetId, "processing", null);

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(env, {} as ObjectStore).process({
          aggregate_id: assetId,
          event_id: "9c000000-0000-4000-8000-000000000051",
          organization_id: organizationId,
          payload: { asset_id: assetId },
          topic: "asset.processing.requested",
          type: "outbox.event",
          version: 1,
        }),
      ),
    ).resolves.toBe("processed");

    const asset = await runSystemTransaction(env, (client) =>
      client.query<{ failure_code: string; orphan_delete_after: Date | null; status: string }>(
        "SELECT status, failure_code, orphan_delete_after FROM assets WHERE id = $1",
        [assetId],
      ),
    );
    expect(asset.rows[0]).toMatchObject({
      failure_code: "declared_media_type_missing",
      status: "failed",
    });
    expect(asset.rows[0]?.orphan_delete_after).not.toBeNull();
  });
});
