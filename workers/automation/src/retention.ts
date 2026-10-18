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

/**
 * Error emitted when an R2 operation leaves a due Brand Profile's inventory
 * claimed but not durably removed. The profile row is then never finalized, so
 * the next sweep re-claims the same objects and retries; it stays retryable at
 * the scheduled-job boundary while retaining a narrow cleanup error channel.
 */
class RetentionStorageError extends Data.TaggedError("RetentionStorageError")<{
  cause: unknown;
  message: string;
}> {}

type RetentionCleanup = (
  env: AutomationEnv,
  batchSize: number,
) => Effect.Effect<number, DatabaseError | RetentionStorageError>;

/**
 * Executes a parameterized batch deletion query within a system transaction.
 *
 * @param env - Automation worker environment.
 * @param query - SQL DELETE query containing a RETURNING clause.
 * @param values - Query parameters including batch limit and interval strings.
 * @returns Number of rows deleted in this batch.
 */
function deleteBatch(
  env: AutomationEnv,
  query: string,
  values: unknown[],
): Effect.Effect<number, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(client.query(query, values), (result) => result.rowCount ?? result.rows.length),
  );
}

/**
 * Deletes expired idempotency keys older than 30 days that are not referenced by billing operations.
 * Preserves active billing operation audit trails indefinitely.
 */
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

/**
 * Purges processed, ignored, or failed webhook events older than 90 days.
 */
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

/**
 * Deletes published or dead outbox events older than 90 days.
 * Preserves pending or leased events awaiting delivery.
 */
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

/**
 * Deletes successful or skipped async job events older than 30 days from `async_job_events`.
 */
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

/**
 * Purges historical usage corrections older than 13 months, keeping one full billing year plus grace.
 */
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

/**
 * Trim the analytics history while keeping each Distribution's most recent
 * snapshot indefinitely. Analytics sync stops arming past
 * `analyticsTerminalAgeSeconds`, so without this exemption an old Distribution
 * would eventually read as having no analytics at all rather than as having its
 * last collected figures.
 */
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

interface DueBrandProfileRow extends Record<string, unknown> {
  id: string;
}

/**
 * Boolean SQL fragment naming the live media work that forbids reclaiming a
 * Brand Profile in the current sweep. A soft-deleted profile's bytes stay
 * protected while any of its Assets is still being uploaded, processed or
 * promoted, while a rendition promotion is uncommitted, while an upload
 * session still holds live session state, or while a publication attempt is
 * running, awaiting reconciliation after an ambiguous outcome, or still inside
 * the retrieval window its signed media URLs are valid for.
 *
 * Deferral is durable, never in-memory: the profile simply stays due and the
 * next daily sweep re-evaluates it, so no hold can leak and no deferred
 * profile is dropped before its media requirements end. A permanently failed
 * or unretained ready Asset is deliberately absent — its objects are ordinary
 * reclaimable inventory, and blocking on it would strand the purge forever.
 *
 * Both the candidate select and the final cascading DELETE interpolate this
 * exact fragment, so a profile that became ineligible between claiming and
 * finalizing is still refused rather than dropped.
 */
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

/**
 * Permanently purges soft-deleted Brand Profiles whose seven-day retention
 * deadline (`purge_at`) has passed, satisfying the durable lifecycle contract
 * that a deleted brand cannot remain indefinitely.
 *
 * Storage is reclaimed through the Asset lifecycle's per-object inventory
 * protocol instead of a parallel delete path: one transaction claims the
 * profile's `asset_objects` rows for deletion, the object deletes run outside any
 * database transaction, and each object is durably recorded as 'deleted' with
 * its charged bytes released exactly once. Only a profile whose inventory is
 * fully gone — the gate and the cascading DELETE are the same statement — may
 * lose its row, so a crash or a failed bucket call leaves a resumable
 * 'deleting' inventory rather than a profile whose bytes were never removed.
 *
 * The candidate select locks each row `FOR UPDATE`, preserving the
 * serialization with restore: a restore that commits first clears `purge_at`
 * and the profile is no longer a candidate, while a restore arriving after the
 * deadline is refused by the API. Every later statement re-checks `purge_at`
 * and live media eligibility, so nothing claimed earlier can be finalized once
 * the profile became ineligible again. Profiles without stored objects skip
 * the bucket entirely, so unusable object storage only fails cleanup when
 * bytes are actually owed; any failed object delete still settles the
 * successes and then fails the cleanup retryably.
 */
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
      for (const object of claimed) {
        // Deleting an already-removed key is a bucket no-op and the durable
        // completion below is a guarded status transition, so a re-claimed
        // object from an interrupted sweep is safe to retry here.
        const removed = yield* Effect.match(
          Effect.tryPromise({
            catch: (cause) =>
              new RetentionStorageError({
                cause,
                message: `unable to delete brand profile object ${object.r2_key}`,
              }),
            try: () => store.delete(object.r2_key),
          }),
          {
            onFailure: (error) => {
              failure ??= error;
              return false;
            },
            onSuccess: () => true,
          },
        );
        if (removed) reclaimedObjectIds.push(object.id);
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
  purgeDueBrandProfiles,
];

/**
 * Runs daily bounded retention cleanup across idempotency keys, webhooks, outbox, async jobs, corrections, snapshots, and due Brand Profile purges.
 * Executes each cleanup independently so errors in one table do not block retention across others:
 * every cleanup is adapted through a classified tryPromise whose success adds its
 * deleted count and whose failure is counted into `errors` instead of failing the
 * program. An out-of-range batchSize still signals caller misuse, surfaced inside
 * the Effect as a classified failure (RangeError → RetryableJobError with
 * `cause` "RangeError").
 *
 * @param env - Automation worker environment.
 * @param options - Configuration containing optional batchSize (default 1,000, max 5,000).
 * @returns Effect producing a RetentionResult with total deleted rows and count of failed cleanup operations; fails with a classified AutomationJobError for an invalid batchSize.
 */
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
      // Per-cleanup failures are counted, not thrown: one failing table must not
      // block retention across the others, matching the previous try/catch loop.
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
