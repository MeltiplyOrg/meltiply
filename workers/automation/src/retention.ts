import { Data, Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import { createObjectStoreFromEnv, type ConfiguredObjectStore } from "@meltiply/storage";

import { claimObjectsForDeletion, settleDeletedObjects } from "./assets";
import { withSystemTransactionEffect } from "./database";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

export interface RetentionResult {
  deleted: number;
  errors: number;
}

export interface RetentionOptions {
  batchSize?: number;
}

const defaultBatchSize = 1_000;
const maximumBatchSize = 5_000;

class RetentionStorageError extends Data.TaggedError("RetentionStorageError")<{
  cause: unknown;
  message: string;
}> {}

type RetentionCleanup = (
  env: AutomationEnv,
  batchSize: number,
) => Effect.Effect<number, DatabaseError | RetentionStorageError>;

function deleteBatch(
  env: AutomationEnv,
  query: string,
  values: unknown[],
): Effect.Effect<number, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(client.query(query, values), (result) => result.rowCount ?? result.rows.length),
  );
}

const deleteExpiredIdempotencyKeys: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteProcessedWebhookEvents: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteTerminalOutboxEvents: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteCompletedAsyncJobEvents: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteOldUsageCorrections: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteOldAnalyticsSnapshots: RetentionCleanup = (env, batchSize) =>
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
  );

const deleteStaleUsageBuckets: RetentionCleanup = (env, batchSize) =>
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
  );

interface DueBrandProfileRow extends Record<string, unknown> {
  id: string;
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

const purgeDueBrandProfiles: RetentionCleanup = (env, batchSize) =>
  Effect.gen(function* () {
    const due = yield* withSystemTransactionEffect(env, (client) =>
      client.query<DueBrandProfileRow>(
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
    );
    const profileIds = due.rows.map((row) => row.id);
    if (profileIds.length === 0) {
      return 0;
    }

    const claimed = yield* claimObjectsForDeletion(env, {
      brandProfileIds: profileIds,
    });
    const reclaimedObjectIds: string[] = [];
    let failure: RetentionStorageError | undefined;
    if (claimed.length > 0) {
      let store: ConfiguredObjectStore;
      try {
        store = createObjectStoreFromEnv(env);
      } catch (cause) {
        return yield* Effect.fail(
          new RetentionStorageError({
            cause,
            message: "object storage is unavailable for brand profile purge",
          }),
        );
      }
      const outcomes = yield* Effect.forEach(
        claimed,
        (object) =>
          Effect.match(
            Effect.tryPromise({
              catch: (cause) =>
                new RetentionStorageError({
                  cause,
                  message: `unable to delete brand profile object ${object.r2_key}`,
                }),
              try: () => store.delete(object.r2_key),
            }),
            {
              onFailure: (error) => ({ error, id: null as string | null }),
              onSuccess: () => ({
                error: undefined as RetentionStorageError | undefined,
                id: object.id,
              }),
            },
          ),
        { concurrency: 8 },
      );
      for (const outcome of outcomes) {
        if (outcome.id !== null) reclaimedObjectIds.push(outcome.id);
        else failure ??= outcome.error;
      }
    }

    if (reclaimedObjectIds.length > 0) {
      yield* settleDeletedObjects(
        env,
        reclaimedObjectIds.map((id) => ({ id })),
      );
    }
    if (failure) {
      return yield* Effect.fail(failure);
    }

    return yield* withSystemTransactionEffect(env, (client) =>
      Effect.map(
        client.query<DueBrandProfileRow>(
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
    );
  });

const cleanups: readonly RetentionCleanup[] = [
  deleteExpiredIdempotencyKeys,
  deleteProcessedWebhookEvents,
  deleteTerminalOutboxEvents,
  deleteCompletedAsyncJobEvents,
  deleteOldUsageCorrections,
  deleteOldAnalyticsSnapshots,
  deleteStaleUsageBuckets,
  purgeDueBrandProfiles,
];

export function runRetention(
  env: AutomationEnv,
  options: RetentionOptions = {},
): Effect.Effect<RetentionResult, AutomationJobError> {
  const batchSize = options.batchSize ?? defaultBatchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize) {
    return Effect.fail(
      classifyJobError(
        new RangeError("retention batch size must be an integer between 1 and 5000"),
      ),
    );
  }

  return Effect.gen(function* () {
    let deleted = 0;
    let errors = 0;
    for (const cleanup of cleanups) {
      const outcome = yield* Effect.match(
        cleanup(env, batchSize).pipe(Effect.mapError(classifyJobError)),
        {
          onFailure: () => ({ deleted: 0, errors: 1 }),
          onSuccess: (count) => ({ deleted: count, errors: 0 }),
        },
      );
      deleted += outcome.deleted;
      errors += outcome.errors;
    }
    return { deleted, errors };
  });
}
