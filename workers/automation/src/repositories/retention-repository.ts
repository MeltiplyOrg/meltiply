import type { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import { claimObjectsForDeletion, settleDeletedObjects } from "../assets";
import { withSystemTransactionEffect } from "../database";
import type { AutomationEnv } from "../env";

export interface ClaimedRetentionObject {
  readonly brand_profile_id?: string;
  readonly id: string;
  readonly r2_key: string;
}

export interface RetentionRepository {
  readonly deleteExpiredIdempotencyKeys: (
    batchSize: number,
  ) => Effect.Effect<number, DatabaseError>;
  readonly deleteProcessedWebhookEvents: (
    batchSize: number,
  ) => Effect.Effect<number, DatabaseError>;
  readonly deleteTerminalOutboxEvents: (batchSize: number) => Effect.Effect<number, DatabaseError>;
  readonly deleteCompletedAsyncJobEvents: (
    batchSize: number,
  ) => Effect.Effect<number, DatabaseError>;
  readonly deleteOldUsageCorrections: (batchSize: number) => Effect.Effect<number, DatabaseError>;
  readonly deleteOldAnalyticsSnapshots: (batchSize: number) => Effect.Effect<number, DatabaseError>;
  readonly deleteStaleUsageBuckets: (batchSize: number) => Effect.Effect<number, DatabaseError>;
  readonly findDueBrandProfiles: (batchSize: number) => Effect.Effect<string[], DatabaseError>;
  readonly claimBrandProfileObjects: (
    brandProfileIds: string[],
  ) => Effect.Effect<ClaimedRetentionObject[], DatabaseError>;
  readonly settleDeletedObjects: (
    objects: ReadonlyArray<{ readonly id: string }>,
  ) => Effect.Effect<unknown, DatabaseError>;
  readonly deletePurgedBrandProfiles: (
    profileIds: string[],
  ) => Effect.Effect<number, DatabaseError>;
}

const liveProfileMedia = `
    EXISTS (
      SELECT 1 FROM assets AS asset
      WHERE asset.brand_profile_id = profile.id
        AND asset.status IN (
          'pending_upload', 'uploading', 'processing', 'deleting'
        )
    )
    OR EXISTS (
      SELECT 1 FROM asset_renditions AS rendition
      WHERE rendition.brand_profile_id = profile.id
        AND rendition.status = 'processing'
    )
    OR EXISTS (
      SELECT 1 FROM asset_upload_sessions AS session
      JOIN assets AS session_asset ON session_asset.id = session.asset_id
      WHERE session_asset.brand_profile_id = profile.id
        AND session.status IN ('created', 'uploading', 'completing')
        AND session.expires_at > now()
    )
    OR EXISTS (
      SELECT 1 FROM provider_operation_media AS media
      JOIN provider_operations AS operation ON operation.id = media.operation_id
      WHERE media.brand_profile_id = profile.id
        AND (
          operation.status IN ('started', 'needs_reconciliation')
          OR (
            operation.media_hold_until IS NOT NULL
            AND operation.media_hold_until > now()
          )
        )
    )`;

function deleteBatch(
  env: AutomationEnv,
  query: string,
  values: unknown[],
): Effect.Effect<number, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(client.query(query, values), (result) => result.rowCount ?? result.rows.length),
  );
}

export function createPostgresRetentionRepository(env: AutomationEnv): RetentionRepository {
  return {
    deleteExpiredIdempotencyKeys: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT org_id, operation, idempotency_key
           FROM idempotency_keys AS entry
           WHERE expires_at < now() - $2::interval
             AND NOT EXISTS (
               SELECT 1
               FROM billing_operations AS billing
               WHERE billing.idempotency_id = entry.id
             )
           ORDER BY expires_at, org_id, operation, idempotency_key
           LIMIT $1
         )
         DELETE FROM idempotency_keys AS entry
         USING candidates
         WHERE entry.org_id = candidates.org_id
           AND entry.operation = candidates.operation
           AND entry.idempotency_key = candidates.idempotency_key
         RETURNING entry.org_id`,
        [batchSize, "30 days"],
      ),

    deleteProcessedWebhookEvents: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT id
           FROM webhook_events
           WHERE outcome IN ('processed', 'ignored', 'failed')
             AND processed_at < now() - $2::interval
           ORDER BY processed_at, id
           LIMIT $1
         )
         DELETE FROM webhook_events AS event
         USING candidates
         WHERE event.id = candidates.id
         RETURNING event.id`,
        [batchSize, "90 days"],
      ),

    deleteTerminalOutboxEvents: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT id
           FROM outbox_events
           WHERE state IN ('published', 'dead')
             AND updated_at < now() - $2::interval
           ORDER BY updated_at, id
           LIMIT $1
         )
         DELETE FROM outbox_events AS event
         USING candidates
         WHERE event.id = candidates.id
         RETURNING event.id`,
        [batchSize, "90 days"],
      ),

    deleteCompletedAsyncJobEvents: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT event_key
           FROM async_job_events
           WHERE outcome IN ('succeeded', 'skipped')
             AND processed_at < now() - $2::interval
           ORDER BY processed_at, event_key
           LIMIT $1
         )
         DELETE FROM async_job_events AS event
         USING candidates
         WHERE event.event_key = candidates.event_key
         RETURNING event.event_key`,
        [batchSize, "30 days"],
      ),

    deleteOldUsageCorrections: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT id
           FROM usage_corrections
           WHERE created_at < now() - $2::interval
           ORDER BY created_at, id
           LIMIT $1
         )
         DELETE FROM usage_corrections AS correction
         USING candidates
         WHERE correction.id = candidates.id
         RETURNING correction.id`,
        [batchSize, "13 months"],
      ),

    deleteOldAnalyticsSnapshots: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT snapshot.id
           FROM analytics_snapshots AS snapshot
           WHERE snapshot.snapshot_at < now() - $2::interval
             AND EXISTS (
               SELECT 1
                 FROM analytics_snapshots AS newer
                WHERE newer.distribution_id = snapshot.distribution_id
                  AND newer.snapshot_at > snapshot.snapshot_at
             )
           ORDER BY snapshot.snapshot_at, snapshot.id
           LIMIT $1
         )
         DELETE FROM analytics_snapshots AS snapshot
         USING candidates
         WHERE snapshot.id = candidates.id
         RETURNING snapshot.id`,
        [batchSize, "90 days"],
      ),

    deleteStaleUsageBuckets: (batchSize) =>
      deleteBatch(
        env,
        `WITH candidates AS (
           SELECT bucket.interval_started_at, bucket.report_date, bucket.platform
           FROM reporting_publication_daily AS bucket
           WHERE bucket.report_date < (now() AT TIME ZONE 'UTC')::date - $2::integer
           ORDER BY bucket.report_date, bucket.interval_started_at, bucket.platform
           LIMIT $1
         )
         DELETE FROM reporting_publication_daily AS bucket
         USING candidates
         WHERE bucket.interval_started_at = candidates.interval_started_at
           AND bucket.report_date = candidates.report_date
           AND bucket.platform = candidates.platform
         RETURNING bucket.platform`,
        [batchSize, 30],
      ),

    findDueBrandProfiles: (batchSize) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.map(
          client.query<{ id: string }>(
            `SELECT profile.id
             FROM brand_profiles AS profile
             WHERE profile.purge_at IS NOT NULL
               AND profile.purge_at <= now()
               AND NOT (${liveProfileMedia})
             ORDER BY profile.purge_at, profile.id
             LIMIT $1
             FOR UPDATE`,
            [batchSize],
          ),
          (result) => result.rows.map((row) => row.id),
        ),
      ),

    claimBrandProfileObjects: (brandProfileIds) =>
      claimObjectsForDeletion(env, { brandProfileIds }),

    settleDeletedObjects: (objects) => settleDeletedObjects(env, [...objects]),

    deletePurgedBrandProfiles: (profileIds) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.map(
          client.query<{ id: string }>(
            `DELETE FROM brand_profiles AS profile
             WHERE profile.id = ANY($1::uuid[])
               AND profile.purge_at IS NOT NULL
               AND profile.purge_at <= now()
               AND NOT (${liveProfileMedia})
               AND NOT EXISTS (
                 SELECT 1 FROM asset_objects AS object
                 WHERE object.brand_profile_id = profile.id
                   AND object.status <> 'deleted'
               )
             RETURNING profile.id`,
            [profileIds],
          ),
          (result) => result.rowCount ?? result.rows.length,
        ),
      ),
  };
}

export class FakeRetentionStore {
  readonly counts = new Map<string, number>();
  readonly failures = new Map<string, DatabaseError>();
  dueBrandProfileIds: string[] = [];
  claimedObjects: ClaimedRetentionObject[] = [];
  readonly settledObjectIds: string[] = [];
  readonly deletedProfileBatches: string[][] = [];
  readonly invokedSteps: string[] = [];
}

export function createFakeRetentionRepository(store: FakeRetentionStore): RetentionRepository {
  const step = (name: string) => {
    store.invokedSteps.push(name);
    const failure = store.failures.get(name);
    if (failure) return Effect.fail(failure);
    return Effect.succeed(store.counts.get(name) ?? 0);
  };

  return {
    deleteExpiredIdempotencyKeys: () => step("idempotency_keys"),
    deleteProcessedWebhookEvents: () => step("webhook_events"),
    deleteTerminalOutboxEvents: () => step("outbox_events"),
    deleteCompletedAsyncJobEvents: () => step("async_job_events"),
    deleteOldUsageCorrections: () => step("usage_corrections"),
    deleteOldAnalyticsSnapshots: () => step("analytics_snapshots"),
    deleteStaleUsageBuckets: () => step("reporting_publication_daily"),
    findDueBrandProfiles: () => {
      store.invokedSteps.push("brand_profiles");
      const failure = store.failures.get("brand_profiles");
      if (failure) return Effect.fail(failure);
      return Effect.succeed([...store.dueBrandProfileIds]);
    },
    claimBrandProfileObjects: () => Effect.succeed([...store.claimedObjects]),
    settleDeletedObjects: (objects) =>
      Effect.sync(() => {
        for (const item of objects) store.settledObjectIds.push(item.id);
      }),
    deletePurgedBrandProfiles: (profileIds) =>
      Effect.sync(() => {
        store.deletedProfileBatches.push([...profileIds]);
        return profileIds.length;
      }),
  };
}
