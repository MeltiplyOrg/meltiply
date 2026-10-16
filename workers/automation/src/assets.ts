// Asset lifecycle consumer and storage maintenance for the Automation Worker.
//
// Storage is addressed exclusively through the `asset_objects` inventory
// (`assets.r2_key`/`r2_thumbnail` no longer exist): every byte an Asset owns —
// staged upload, promoted original, thumbnail, and optimization outputs — has
// its own durable row carrying the key, the charged bytes or the in-flight
// reservation, and a lifecycle status. That inventory is what makes deletion
// crash-safe: a claim is a status transition, the bucket deletes run outside
// any database transaction, and each removal is durably recorded so a repeated
// or resumed event releases accounting exactly once.
import { Effect } from "effect";
import {
  assetLeaseSeconds,
  claimJobLease,
  finishJobLease,
  jobLeaseOutcome,
  JobInProgressError,
} from "./job-lease";
import { assetOrphanGraceSeconds, type DatabaseError } from "@meltiply/domain";
import { R2ObjectStore, type ObjectStore } from "@meltiply/storage";
import { errorDiagnostic, log } from "@meltiply/observability";

import { safeErrorMessage } from "./errors";
import { withSystemTransactionEffect, type EffectTransactionClient } from "./database";
import { classifyJobError, TerminalJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { claimDueOutboxWork } from "./due-work";
import { type OutboxMessage } from "./messages";
import { reconcileDueUsage } from "./usage";
import { processAssetMedia, releaseStaleProcessingStaging } from "./asset-processing";

/**
 * One inventoried object an Asset owns, as claimed for reclamation. `bytes` is
 * the verified physical size charged once the write settled; `reserved_bytes`
 * is the capacity held while an in-flight write or optimization output has not
 * been verified yet. A row can carry both while an attempt is interrupted
 * between recording its output and promoting it; its charge is then
 * `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))`, the same
 * authoritative rule the reservation, the workspace total, and the settlement
 * all use, so exactly that charge is released when the row is reclaimed before
 * its write settled.
 */
export interface ClaimedAssetObject extends Record<string, unknown> {
  asset_id: string;
  bytes: number | string | null;
  id: string;
  kind: string;
  org_id: string;
  r2_key: string;
  reserved_bytes: number | string | null;
  status: string;
}

/**
 * Counts the outcome of one bounded maintenance sweep, so an Operator can see
 * which reclamation work ran without inspecting the media tables directly.
 */
export interface AssetMaintenanceResult {
  /** Per-item failures absorbed while continuing a sweep. */
  cleanup_errors: number;
  /** Abandoned multipart and single-PUT upload sessions expired or aborted. */
  expired_sessions: number;
  /** Assets armed for reclamation by the seven-day orphan sweep. */
  orphan_assets_claimed: number;
  /** Lifecycle events emitted to recover jobs stuck past their lease. */
  reconciliation_events: number;
  /** Abandoned in-flight writes reclaimed, reservation released. */
  stale_writing_objects_deleted: number;
  /** Terminal upload sessions whose staged bytes were handed to the sweep. */
  terminal_sessions_reclaimed: number;
  /** Organizations whose authoritative storage usage was recomputed. */
  usage_rows: number;
}

/**
 * Asset job processor contract: both entry points are Effect programs failing
 * with a classified AutomationJobError. Leaf adapters (system transactions,
 * ObjectStore calls) stay Promise-based inside and are converted with
 * Effect.tryPromise at each call site; classification happens once at the
 * program boundary so permanent-failure discrimination still sees raw Errors.
 */
export interface AssetJobProcessor {
  process(message: OutboxMessage): Effect.Effect<"processed" | "skipped", AutomationJobError>;
  runMaintenance(): Effect.Effect<AssetMaintenanceResult, AutomationJobError>;
}

/** How long an abandoned multipart upload may sit before its parts are aborted. */
const multipartAbandonGraceSeconds = 3600;
/**
 * How long an in-flight object write whose bytes already settled (a staged
 * upload, or a processing output whose size was recorded before the crash)
 * may stay before the maintenance sweep reclaims it. Comfortably longer than
 * the 600s processing lease, so a live worker is never mistaken for an
 * abandoned write.
 */
const staleWritingGraceSeconds = 1800;
/**
 * How long a processing or deleting Asset may sit untouched before the sweep
 * re-arms its lifecycle event. Above the 600s processing lease, so recovery
 * only fires for genuinely lost work.
 */
const stuckAssetGraceSeconds = 900;
/**
 * Days an abandoned upload's Asset ages out before the orphan sweep may claim
 * it, the same grace the API arms when it fails an upload itself. An Asset a
 * saved draft still references never starts it.
 */
const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);
/** Bounded page size for every maintenance sweep and reclaim pass. */
const maintenanceBound = 50;

/**
 * The Asset facts this consumer decides on: identity, ownership, and the
 * lifecycle status that selects the processing or deletion path. Declared
 * media details and every object address are read by the media-processing
 * module from `assets` and `asset_objects` respectively, so they are not
 * duplicated here.
 */
interface AssetJobRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  status: string;
}

interface AbandonedMultipartUploadRow extends Record<string, unknown> {
  asset_id: string;
  id: string;
  multipart_upload_id: string;
  object_key: string;
}

/**
 * Builds the LogContext every lifecycle evidence record is emitted with.
 * Asset work runs outside the job-scope boundary (`process` is invoked from a
 * queue consumer and `runMaintenance` from a cron trigger), so correlation
 * identifiers are carried explicitly instead of read from an ambient scope.
 *
 * @param env - Automation worker environment bindings.
 * @param eventKey - Lease event key identifying the durable event.
 * @param requestId - Optional upstream request id for cross-surface tracing.
 * @returns Minimal LogContext tagged with the automation service and version.
 */
function logContext(
  env: AutomationEnv,
  eventKey: string,
  requestId?: string | null,
): {
  environment: string;
  job_id: string;
  request_id?: string;
  service: string;
  trace_id: string;
  version: string;
} {
  return {
    environment: env.ENVIRONMENT,
    job_id: eventKey,
    ...(requestId ? { request_id: requestId } : {}),
    service: "automation",
    trace_id: eventKey,
    version: env.VERSION,
  };
}

/**
 * Emits one structured lifecycle evidence record for an Asset transition.
 * Operator story #50 requires durable processing/deletion state to identify
 * failed lifecycle work without a new media dashboard, so every reclaim,
 * settlement, and permanent failure is recorded with the Asset identity, the
 * object counts involved, and the released byte total.
 *
 * @param env - Automation worker environment bindings.
 * @param level - Severity; `warn` for absorbed cleanup failures, `info` for completed work, `error` for permanent failures.
 * @param eventKey - Lease event key or maintenance marker identifying the work.
 * @param fields - Structured evidence fields (`event`, `outcome`, plus Asset/object detail).
 * @param cause - Optional failure cause whose diagnostic is attached.
 */
function emitLifecycleEvidence(
  env: AutomationEnv,
  level: "error" | "info" | "warn",
  eventKey: string,
  fields: Record<string, unknown> & {
    event: string;
    outcome: number | string;
  },
  cause?: unknown,
): void {
  log(level, logContext(env, eventKey), {
    ...fields,
    ...(cause === undefined ? {} : errorDiagnostic(cause)),
    job: "asset_lifecycle",
    retry_class: level === "error" ? "none" : "queue_backoff",
  });
}

interface AssetEventDescriptor {
  aggregateId: string;
  eventKey: string;
  jobType: string;
  organizationId: string;
  requestId?: string;
  topic: string;
}

/**
 * Extracts and maps outbox message attributes into a standardized asset event descriptor.
 *
 * @param message - Incoming outbox message from the queue.
 * @returns Structured descriptor used for lease coordination and tracking.
 */
function descriptor(message: OutboxMessage): AssetEventDescriptor {
  return {
    aggregateId: message.aggregate_id,
    eventKey: `outbox:${message.event_id}`,
    jobType: message.topic,
    organizationId: message.organization_id,
    ...(message.request_id ? { requestId: message.request_id } : {}),
    topic: message.topic,
  };
}

/**
 * Claims a distributed job lease for an asset outbox event.
 *
 * Enforces single-consumer execution by acquiring a topic-appropriate lease in
 * `async_job_events`: a processing lease outlives the native processor's own
 * job ceiling so a redelivery arriving mid-compute loses the claim instead of
 * writing a second rendition, while deletion keeps the shorter reclaim lease.
 * A lost claim against a live lease fails with JobInProgressError on the typed
 * channel so the process() catch handler can skip clobbering the competing
 * worker's record.
 *
 * @param client - Effect transaction client inside the caller's transaction.
 * @param event - Asset event descriptor containing lease keys and identifiers.
 * @returns Effect resolving to true if the lease was claimed, false if already completed;
 *   fails with JobInProgressError when another worker holds an active lease.
 */
function beginEvent(
  client: EffectTransactionClient,
  event: AssetEventDescriptor,
): Effect.Effect<boolean, DatabaseError | JobInProgressError> {
  return Effect.gen(function* () {
    const claimed = yield* claimJobLease(client, {
      aggregateId: event.aggregateId,
      aggregateType: event.topic.startsWith("asset.") ? "asset" : "system",
      eventKey: event.eventKey,
      jobType: event.jobType,
      leaseSeconds: assetLeaseSeconds(event.topic),
      orgId: event.organizationId,
    });
    if (claimed) return true;
    const outcome = yield* jobLeaseOutcome(client, event.eventKey);
    if (outcome === "processing") {
      return yield* Effect.fail(new JobInProgressError());
    }
    return false;
  });
}

/**
 * Concludes an asset event lease with a terminal outcome of succeeded or skipped.
 *
 * @param client - Effect transaction client inside the caller's transaction.
 * @param eventKey - Formatted lease event key string.
 * @param outcome - Terminal state outcome ('skipped' or 'succeeded').
 * @param aggregateId - Optional asset ID associated with the event.
 * @returns Effect resolving when the lease row is finalized.
 */
function finishEvent(
  client: EffectTransactionClient,
  eventKey: string,
  outcome: "skipped" | "succeeded",
  aggregateId?: string,
): Effect.Effect<void, DatabaseError> {
  return finishJobLease(client, eventKey, outcome, { aggregateId });
}

/**
 * Records a job failure on the lease in an independent system transaction.
 *
 * @param env - Automation worker environment bindings.
 * @param eventKey - Formatted lease event key string.
 * @param cause - Error cause triggering the failure.
 * @returns Effect resolving when the failure is recorded.
 */
function failEvent(
  env: AutomationEnv,
  eventKey: string,
  cause: unknown,
): Effect.Effect<void, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    finishJobLease(client, eventKey, "failed", {
      error: safeErrorMessage(cause, "unknown asset job error"),
    }),
  );
}

/**
 * Loads an asset record by ID and organization ID for verification and processing.
 *
 * Object addresses are deliberately absent: the row carries only lifecycle and
 * declared-media facts, and every key and byte count is read from
 * `asset_objects`.
 *
 * @param client - Effect transaction client inside the caller's transaction.
 * @param event - Asset event descriptor.
 * @returns Effect resolving to the asset database record row, or undefined if not found.
 */
function assetRow(
  client: EffectTransactionClient,
  event: AssetEventDescriptor,
): Effect.Effect<AssetJobRow | undefined, DatabaseError> {
  return client
    .query<AssetJobRow>(
      `SELECT id, org_id, status
       FROM assets
       WHERE id = $1 AND org_id = $2`,
      [event.aggregateId, event.organizationId],
    )
    .pipe(Effect.map((result) => result.rows[0]));
}

/**
 * Records a terminal media failure on the Asset and concludes the lease.
 *
 * The media-processing module already wrote `assets.status='failed'` with the
 * creator-actionable failure code and released the run's output reservation
 * before it failed, so both updates here are `status`-scoped no-ops on that
 * path. They remain because they are the single place the durable failure
 * evidence is guaranteed: whichever component raised the terminal error, the
 * Asset ends durably failed with its reason rather than stuck in
 * `'processing'`, and the lease is concluded so redelivery cannot re-run a job
 * whose input can never succeed.
 *
 * @param env - Automation worker environment bindings.
 * @param eventKey - Formatted lease event key string.
 * @param row - Asset record row being updated.
 * @param cause - Terminal failure carrying the stable code and creator-facing message.
 * @returns Effect resolving when the failure state and lease are recorded.
 */
function markPermanentFailure(
  env: AutomationEnv,
  eventKey: string,
  row: AssetJobRow,
  cause: TerminalJobError,
): Effect.Effect<void, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE asset_renditions
         SET status = 'failed',
             failure_code = $2,
             failure_message = $3,
             failure_at = now(),
             updated_at = now()
         WHERE asset_id = $1
           AND status = 'processing'`,
        [row.id, cause.code, safeErrorMessage(cause)],
      );
      yield* client.query(
        `UPDATE assets
         SET status = 'failed',
             failure_code = $2,
             failure_message = $3,
             failure_retryable = false,
             failure_at = now(),
             updated_at = now()
         WHERE id = $1 AND status = 'processing'`,
        [row.id, cause.code, safeErrorMessage(cause)],
      );
      yield* finishEvent(client, eventKey, "succeeded", row.id);
    }),
  );
}

/**
 * Normalizes an unknown thrown or failed value to Error for the internal failure channel.
 *
 * Leaf adapters (withSystemTransactionEffect, ObjectStore) may surface non-Error
 * values; normalizing keeps the channel typed as Error so the process()
 * handler can discriminate PermanentAssetError/JobInProgressError via
 * instanceof, and classifyJobError preserves the original error name at the
 * boundary.
 *
 * @param cause - Value thrown or failed by a leaf adapter.
 * @returns The cause unchanged when already an Error, else a wrapped Error.
 */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Deletes one bucket object, tolerating an already-absent key.
 *
 * R2 DELETE is idempotent, so a resumed sweep re-running a removal that
 * actually succeeded before the crash is a no-op rather than a failure; only a
 * real transport or authorization fault is reported.
 *
 * @param storage - ObjectStore performing the removal.
 * @param key - Exact object key to remove.
 * @returns Effect resolving when the key is absent from the bucket.
 */
function deleteObject(storage: ObjectStore, key: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    catch: asError,
    try: () => storage.delete(key),
  });
}

/**
 * Counts the objects of a scope that still occupy storage.
 *
 * A deletion may only report the Asset reclaimed once every inventoried object
 * is durably `'deleted'`; anything else means bytes or an unverified
 * reservation are still owed and the Asset must stay in `'deleting'` so the
 * sweep re-arms it.
 *
 * @param env - Automation worker environment bindings.
 * @param assetIds - Asset ids whose live objects are counted.
 * @returns Effect resolving to the number of objects not yet recorded as deleted.
 */
function remainingLiveObjectCount(
  env: AutomationEnv,
  assetIds: readonly string[],
): Effect.Effect<number, DatabaseError> {
  if (assetIds.length === 0) return Effect.succeed(0);
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<{ remaining: number }>(
        `SELECT COUNT(*)::integer AS remaining
         FROM asset_objects
         WHERE asset_id = ANY($1::uuid[])
           AND status <> 'deleted'`,
        [assetIds],
      )
      .pipe(Effect.map((result) => result.rows[0]?.remaining ?? 0)),
  );
}

/**
 * Claims an inventoried object's rows for deletion, optionally scoped to whole
 * Brand Profiles. This is the shared reclamation protocol for the two callers
 * that must remove bytes: the orphan/delete consumer and the due Brand Profile
 * purge.
 *
 * Scope is expressed by `assetIds` and/or `brandProfileIds` (OR-ed when both
 * are supplied) and never filters on `assets.status`, so a profile purge also
 * reclaims the objects of failed and deleted Assets. `'deleting'` is part of
 * the claimed set on purpose: a reclaim is multi-sweep, so an interrupted pass
 * leaves rows in that state and the next pass must re-claim them to retry the
 * external delete and settle it.
 *
 * The claim refuses any object whose write window is still open, via the
 * explicit nullable `asset_objects.write_hold_until`: a claimed object must
 * have no hold, or a hold already in the past. A presigned browser upload PUT
 * and the native processor's create-only rendition PUT stay valid after
 * minting, and neither consults the inventory first — the processor's
 * `If-None-Match: *` precondition passes precisely because the key is absent.
 * Removing such an object now would let real bytes land in the bucket after its
 * charge was released, escaping Entitlements with nothing accounting for it.
 *
 * The hold is set by whoever mints a capability, so the deadline lives with the
 * grant that creates the risk rather than being recomputed by each sweeper. A
 * held object keeps its status, its bytes, and its reservation, and a later
 * sweep claims it once the hold lapses. Because the gate is a dedicated
 * nullable column rather than a future `updated_at`, it is unambiguous: a row
 * carries a real write deadline or it does not.
 *
 * @param env - Automation worker environment bindings.
 * @param options - `assetIds` scopes whole Assets; `brandProfileIds` scopes every Asset of the given Brand Profiles.
 * @returns Effect resolving to the claimed inventory rows; empty scopes resolve to an empty list.
 */
export function claimObjectsForDeletion(
  env: AutomationEnv,
  options: {
    assetIds?: readonly string[];
    brandProfileIds?: readonly string[];
  },
): Effect.Effect<ClaimedAssetObject[], DatabaseError> {
  const assetIds = options.assetIds ?? [];
  const brandProfileIds = options.brandProfileIds ?? [];
  if (assetIds.length === 0 && brandProfileIds.length === 0) {
    return Effect.succeed([]);
  }
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<ClaimedAssetObject>(
        `UPDATE asset_objects AS object
         SET status = 'deleting', updated_at = now()
         WHERE object.status IN (
                 'ready', 'superseded', 'writing', 'deleting'
               )
           AND (
             object.write_hold_until IS NULL
             OR object.write_hold_until <= now()
           )
           AND (
             object.asset_id = ANY($1::uuid[])
             OR object.asset_id IN (
               SELECT asset.id
               FROM assets AS asset
               WHERE asset.brand_profile_id = ANY($2::uuid[])
             )
           )
         RETURNING object.id, object.asset_id, object.org_id, object.kind,
                   object.r2_key, object.bytes, object.reserved_bytes,
                   object.status`,
        [assetIds, brandProfileIds],
      )
      .pipe(Effect.map((result) => result.rows)),
  );
}

/**
 * Durably records removed objects and releases their storage charge once.
 *
 * The guarded `'deleting'` → `'deleted'` transition is the single release
 * point: only the rows that actually transitioned decrement
 * `usage_records.storage_bytes`, so a duplicate event, a resumed sweep, or a
 * crash between the bucket delete and this call can never subtract the same
 * bytes twice. The charge per object is the one authoritative inventory rule,
 * `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))`, identical to
 * what the API charges and what `reserveOutputs` reserves against, so this
 * releases exactly the charge that was being held — never a different number
 * derived from a second formula. A `'writing'` row reclaimed before its write
 * settled therefore releases the reservation it was holding instead of
 * vanishing, and a row that recorded measured bytes while still holding its
 * reservation releases the larger of the two. `assets.status` is never touched
 * here; the asset-level transition is the deletion consumer's job.
 *
 * @param env - Automation worker environment bindings.
 * @param rows - Objects whose removal completed, identified by inventory id.
 * @returns Effect resolving to the number of objects settled and the bytes released by this call.
 */
export function settleDeletedObjects(
  env: AutomationEnv,
  rows: readonly { id: string }[],
): Effect.Effect<{ deleted_objects: number; released_bytes: number }, DatabaseError> {
  if (rows.length === 0) {
    return Effect.succeed({ deleted_objects: 0, released_bytes: 0 });
  }
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<{ deleted_objects: number; released_bytes: number }>(
        `WITH settled AS (
           UPDATE asset_objects AS object
           SET status = 'deleted',
               deleted_at = now(),
               updated_at = now()
           WHERE object.id = ANY($1::uuid[])
             AND object.status = 'deleting'
           RETURNING object.org_id,
                     GREATEST(COALESCE(object.bytes, 0),
                              COALESCE(object.reserved_bytes, 0))::bigint
                       AS charged_bytes
         ), released AS (
           UPDATE usage_records AS usage
           SET storage_bytes = GREATEST(
                 usage.storage_bytes - release.charged_bytes, 0
               ),
               updated_at = now()
           FROM (
             SELECT settled.org_id,
                    SUM(settled.charged_bytes)::bigint AS charged_bytes
             FROM settled
             GROUP BY settled.org_id
           ) AS release
           WHERE usage.org_id = release.org_id
             AND usage.period = to_char(now(), 'YYYY-MM')
           RETURNING release.charged_bytes
         )
         SELECT (SELECT COUNT(*)::integer FROM settled) AS deleted_objects,
                (SELECT COALESCE(SUM(charged_bytes), 0)::bigint FROM settled)
                  AS released_bytes`,
        [rows.map((row) => row.id)],
      )
      .pipe(Effect.map((result) => result.rows[0] ?? { deleted_objects: 0, released_bytes: 0 })),
  );
}

/**
 * Creates an asset background job processor for media processing and storage maintenance.
 *
 * Construction stays synchronous so callers can capture the missing-binding throw in a
 * tryPromise around the factory; the returned methods are Effect programs (see
 * AssetJobProcessor) that the queue/scheduled boundaries run via runJobProgram.
 *
 * @param env - Automation worker environment containing Cloudflare bindings.
 * @param objectStore - Optional injected ObjectStore implementation (defaults to R2ObjectStore on env.ASSETS).
 * @returns Configured AssetJobProcessor instance with Effect-returning `process` and `runMaintenance` methods.
 * @throws {Error} Synchronously when neither objectStore nor env.ASSETS is available.
 */
export function createAssetJobProcessor(
  env: AutomationEnv,
  objectStore?: ObjectStore,
): AssetJobProcessor {
  const storage =
    objectStore ??
    (env.ASSETS
      ? new R2ObjectStore(env.ASSETS)
      : (() => {
          throw new Error("asset R2 binding is unavailable");
        })());

  /**
   * Reclaims one Asset's inventoried bytes and finalizes its lifecycle row.
   *
   * Every object the Asset owns — staged upload, promoted original, thumbnail,
   * and each optimization output — is claimed into `'deleting'` in one
   * transaction, removed from the bucket outside any database transaction, and
   * then durably settled, which is what releases the storage charge exactly
   * once. The Asset row flips to `'deleted'` only once its inventory is fully
   * gone, so an interrupted reclaim leaves a resumable `'deleting'` Asset
   * instead of a row claiming bytes that were never removed.
   *
   * No retained Post attachment can be destroyed here: the delete-claim guard
   * refuses the `'deleting'` transition while a Post references the Asset, and
   * the attach guard refuses new references to media already claimed. A failed
   * bucket delete still settles the successes and then fails retryably, so the
   * remaining objects are re-claimed on redelivery.
   *
   * Deletion also respects write capabilities this Worker has already issued.
   * A presigned browser upload PUT and the native processor's create-only
   * rendition PUT stay valid after minting and neither consult the inventory
   * before writing — the processor's `If-None-Match: *` precondition passes
   * precisely because the key is gone. `claimObjectsForDeletion` therefore
   * refuses any object still inside its `write_hold_until` window, so a held
   * object is neither removed nor settled: it keeps its bytes and its
   * reservation, the Asset stays `'deleting'`, and a later sweep finishes the
   * job once the hold lapses. No byte can therefore land in the bucket with
   * nothing accounting for it.
   *
   * @param event - Asset event descriptor carrying the lease identity.
   * @param row - Asset row in 'deleting' status.
   * @returns Effect resolving to 'processed' when every object is durably removed, or 'skipped' if not in deleting state.
   */
  function processDeletion(
    event: AssetEventDescriptor,
    row: AssetJobRow,
  ): Effect.Effect<"processed" | "skipped", Error> {
    return Effect.gen(function* () {
      if (row.status !== "deleting") {
        yield* withSystemTransactionEffect(env, (client) =>
          finishEvent(client, event.eventKey, "skipped", row.id),
        ).pipe(Effect.mapError(asError));
        return "skipped" as const;
      }
      const claimed = yield* claimObjectsForDeletion(env, {
        assetIds: [row.id],
      }).pipe(Effect.mapError(asError));
      const reclaimed: Array<{ id: string }> = [];
      let failure: Error | undefined;
      for (const object of claimed) {
        const removed = yield* Effect.match(deleteObject(storage, object.r2_key), {
          onFailure: (cause) => {
            failure ??= cause;
            return false;
          },
          onSuccess: () => true,
        });
        if (removed) reclaimed.push({ id: object.id });
      }
      const settled = yield* settleDeletedObjects(env, reclaimed).pipe(Effect.mapError(asError));
      const remaining = yield* remainingLiveObjectCount(env, [row.id]).pipe(
        Effect.mapError(asError),
      );
      const completed = yield* withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          if (remaining > 0) return false;
          yield* client.query(
            `UPDATE asset_renditions
             SET status = 'deleted', updated_at = now()
             WHERE asset_id = $1 AND status <> 'deleted'`,
            [row.id],
          );
          const deleted = yield* client.query(
            `UPDATE assets
             SET status = 'deleted',
                 orphaned_at = NULL,
                 orphan_delete_after = NULL,
                 deleted_at = now(),
                 updated_at = now()
             WHERE id = $1 AND status = 'deleting'
             RETURNING id`,
            [row.id],
          );
          yield* finishEvent(
            client,
            event.eventKey,
            deleted.rowCount === 1 ? "succeeded" : "skipped",
            row.id,
          );
          return deleted.rowCount === 1;
        }),
      ).pipe(Effect.mapError(asError));
      emitLifecycleEvidence(
        env,
        failure ? "warn" : "info",
        event.eventKey,
        {
          asset_id: row.id,
          claimed_objects: claimed.length,
          deleted_objects: settled.deleted_objects,
          event: "asset_deletion_processed",
          outcome: completed && !failure ? "reclaimed" : "incomplete",
          released_bytes: settled.released_bytes,
          remaining_objects: remaining,
        },
        failure,
      );
      if (failure) return yield* Effect.fail(failure);
      return completed ? ("processed" as const) : ("skipped" as const);
    });
  }

  /**
   * Processes a finalized upload by promoting its staged bytes and running real
   * native media processing.
   *
   * The staged object is promoted into the protected original namespace under
   * its verified ETag, the native Container processor produces and verifies a
   * Provider-compatible rendition, and only then are the inventory rows and the
   * Asset committed atomically. Nothing is published from unverified bytes and
   * no failure silently falls back to the raw upload.
   *
   * The lease is concluded only after that durable result exists, so a
   * committed run ends as `succeeded` and an Asset that was no longer
   * processing as `skipped` — the outcome the run itself reported. No failure
   * reaches the conclusion: a terminal media failure is already concluded by
   * the permanent-failure path, and every other failure is recorded by the
   * `process` handler so the Queue redelivers it. Without this the event would
   * sit in `processing` forever and its redeliveries would keep re-running a
   * job that already committed.
   *
   * @param event - Asset event descriptor.
   * @param row - Asset row in processing status.
   * @returns Effect resolving to 'processed' when media processing committed, or 'skipped' if already transitioned.
   */
  function processMedia(
    event: AssetEventDescriptor,
    row: AssetJobRow,
  ): Effect.Effect<"processed" | "skipped", Error> {
    return Effect.gen(function* () {
      if (row.status !== "processing") {
        yield* withSystemTransactionEffect(env, (client) =>
          finishEvent(client, event.eventKey, "skipped", row.id),
        ).pipe(Effect.mapError(asError));
        return "skipped" as const;
      }
      const outcome = yield* processAssetMedia(env, storage, row.id, row.org_id).pipe(
        Effect.mapError(asError),
      );
      yield* withSystemTransactionEffect(env, (client) =>
        finishEvent(
          client,
          event.eventKey,
          outcome === "processed" ? "succeeded" : "skipped",
          row.id,
        ),
      ).pipe(Effect.mapError(asError));
      return outcome;
    });
  }

  /**
   * Aborts abandoned multipart uploads, recording each reclaimed staging object.
   *
   * The bucket abort runs outside the request transaction and the durable
   * `asset_objects` row is what makes the removal replayable, so an aborted
   * pass leaves the staged bytes claimed for deletion rather than untracked.
   * The handoff of the session's reserved bytes, the reclaim claim, and the
   * closed writer hold are one `asset_objects` UPDATE because two
   * data-modifying CTEs can never target the same inventory row, and the
   * reservation is only released once those bytes are accounted for.
   *
   * The same statement fails the Asset that session still owned. Its upload is
   * terminal and its reservation is settled, so an Asset left in
   * `'pending_upload'` would wait for an upload that can never finish. Only
   * unfinished upload states are touched — a processing, ready, or
   * reclaiming Asset keeps whatever the native run concluded — and a retained
   * draft keeps its attachment and its actionable reason with no reclaim clock.
   *
   * @returns Effect resolving to the number of sessions aborted and the objects claimed for reclamation.
   */
  function abortAbandonedMultipartUploads(): Effect.Effect<
    { errors: number; sessions: number },
    Error
  > {
    return Effect.gen(function* () {
      const abandoned = yield* withSystemTransactionEffect(env, (client) =>
        client
          .query<AbandonedMultipartUploadRow>(
            `SELECT id, asset_id, object_key, multipart_upload_id
               FROM asset_upload_sessions
               WHERE strategy = 'multipart'
                 AND multipart_upload_id IS NOT NULL
                 AND status IN ('created', 'uploading')
                 AND expires_at <= now() - ($1 * INTERVAL '1 second')
               ORDER BY expires_at, id
               LIMIT $2`,
            [multipartAbandonGraceSeconds, maintenanceBound],
          )
          .pipe(Effect.map((result) => result.rows)),
      ).pipe(Effect.mapError(asError));

      let errors = 0;
      let sessions = 0;
      for (const row of abandoned) {
        const aborted = yield* Effect.match(
          Effect.tryPromise({
            catch: asError,
            try: () =>
              storage.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort(),
          }),
          {
            onFailure: () => {
              errors += 1;
              return false;
            },
            onSuccess: () => true,
          },
        );
        if (!aborted) continue;
        const cleared = yield* Effect.match(
          withSystemTransactionEffect(env, (client) =>
            client.query<{ failed: number; sessions: number; staged: number }>(
              `WITH expired AS (
                 UPDATE asset_upload_sessions
                 SET status = 'aborted', aborted_at = now(), updated_at = now()
                 WHERE id = $1 AND status IN ('created', 'uploading')
                 RETURNING id, asset_id, object_key
               ), staged AS (
                 -- The reservation's bytes are transferred onto the staged row
                 -- rather than simply released: the staged object may still
                 -- physically exist, so dropping the charge here would
                 -- understate live storage and let a concurrent upload pass
                 -- the limit check. The staged row is then reclaimed through
                 -- the normal deleting→deleted settlement, which releases the
                 -- charge exactly once. The handoff, the claim, and the closed
                 -- hold are one UPDATE because sibling data-modifying CTEs
                 -- cannot both write the same inventory row, and only this
                 -- session's own staging object takes the charge.
                 UPDATE asset_objects AS object
                 SET reserved_bytes = CASE
                       WHEN object.r2_key = expired.object_key
                            AND object.bytes IS NULL
                       THEN COALESCE(object.reserved_bytes, reservation.bytes)
                       ELSE object.reserved_bytes
                     END,
                     status = 'deleting',
                     -- The external abort above was confirmed, so the
                     -- uploadId is dead and no part grant can write again:
                     -- the writer hold closes now rather than waiting out a
                     -- deadline the dead writers could never reach.
                     write_hold_until = now(),
                     updated_at = now()
                 FROM expired
                 LEFT JOIN asset_quota_reservations AS reservation
                   ON reservation.session_id = expired.id
                  AND reservation.state = 'reserved'
                 WHERE object.asset_id = expired.asset_id
                   AND object.kind = 'staging'
                   AND object.status = 'writing'
                 RETURNING object.id, object.r2_key
               ), released AS (
                 -- Released only once the bytes are durably accounted for:
                 -- the staged row above took them over, or the session's
                 -- staging object is already gone, in which case nothing was
                 -- ever written and nothing can be reclaimed.
                 UPDATE asset_quota_reservations AS reservation
                 SET state = 'released', released_at = now()
                 FROM expired
                 WHERE reservation.session_id = expired.id
                   AND reservation.state = 'reserved'
                   AND (
                     EXISTS (
                       SELECT 1 FROM staged
                       WHERE staged.r2_key = expired.object_key
                     )
                     OR NOT EXISTS (
                       SELECT 1
                         FROM asset_objects AS object
                        WHERE object.asset_id = expired.asset_id
                          AND object.kind = 'staging'
                          AND object.r2_key = expired.object_key
                          AND object.status <> 'deleted'
                     )
                   )
                 RETURNING reservation.session_id
               ), failed AS (
                 -- The session is terminal and its reservation is settled, so an
                 -- Asset still waiting on it would never leave
                 -- 'pending_upload' on its own: the upload it describes is gone.
                 -- A retained draft keeps its attachment and its reason, so
                 -- only an unretained Asset starts the reclaim clock.
                 UPDATE assets AS asset
                 SET status = 'failed',
                     failure_code = 'upload_aborted',
                     failure_message = 'The upload was cancelled.',
                     failure_retryable = true,
                     failure_at = now(),
                     orphaned_at = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                       ) THEN NULL
                       ELSE now()
                     END,
                     orphan_delete_after = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                       ) THEN NULL
                       ELSE now() + make_interval(days => $2)
                     END,
                     updated_at = now()
                 FROM expired
                 WHERE asset.id = expired.asset_id
                   AND asset.status IN ('pending_upload', 'uploading')
                 RETURNING asset.id
               )
               SELECT (SELECT COUNT(*)::integer FROM expired) AS sessions,
                      (SELECT COUNT(*)::integer FROM staged) AS staged,
                      (SELECT COUNT(*)::integer FROM failed) AS failed`,
              [row.id, orphanGraceDays],
            ),
          ).pipe(Effect.mapError(asError)),
          {
            onFailure: () => {
              errors += 1;
              return undefined;
            },
            onSuccess: (result) => result,
          },
        );
        if (cleared) sessions += cleared.rows[0]?.sessions ?? 0;
      }
      return { errors, sessions };
    });
  }

  /**
   * Expires abandoned single-PUT upload sessions whose upload window elapsed without completion.
   *
   * Unlike multipart uploads which track in-flight parts in the bucket and require
   * an explicit bucket abort, single-PUT uploads write directly to the staging key
   * under a presigned URL. When the session expires before completion and the creator
   * vanishes, client disappearance cannot be the only cleanup trigger.
   *
   * This pass expires abandoned single-PUT sessions autonomously during maintenance
   * without waiting for another tenant API call. In a single atomic statement:
   * 1. The session is marked 'expired'.
   * 2. The session's quota reservation is transferred onto the staging object in
   *    'asset_objects' with status 'deleting', preserving the signed write_hold_until
   *    protection so live writers cannot recreate bytes after release.
   * 3. The reservation is released once durably accounted for.
   * 4. The pending Asset is marked 'failed' with 'upload_session_expired' and arms
   *    the orphan retention clock if unattached.
   *
   * Sessions stuck in 'completing' are included once their `updated_at` also
   * predates the stale-write grace: 'completing' is a committed checkpoint a
   * crashed request can strand (session row terminal-ish but never finished),
   * and its upload is just as unreclaimable as one that never started. The
   * extra grace keeps a live completion whose session expired mid-request —
   * its presigned PUT is already dead — from being swept while still running.
   * Multipart sessions in 'completing' stay excluded: they still require a
   * bucket abort `abortAbandonedMultipartUploads` owns.
   *
   * Physical object removal and usage decrement happen outside the transaction in
   * the subsequent release pass once the writer hold lapses.
   *
   * @returns Effect resolving to the number of single-PUT sessions expired and absorbed errors.
   */
  function expireAbandonedSingleUploadSessions(): Effect.Effect<
    { errors: number; sessions: number },
    Error
  > {
    return Effect.gen(function* () {
      const expired = yield* Effect.match(
        withSystemTransactionEffect(env, (client) =>
          client.query<{ sessions: number }>(
            `WITH due AS (
               SELECT session.id, session.asset_id, session.object_key,
                      session.expires_at
               FROM asset_upload_sessions AS session
               WHERE (session.strategy = 'single' OR session.multipart_upload_id IS NULL)
                 AND session.expires_at <= now()
                 AND (
                   session.status IN ('created', 'uploading')
                   -- A session stranded in 'completing' — a request that died
                   -- between the checkpoint commit and the final write — is
                   -- swept only after the stale-write grace also elapsed, so a
                   -- live completion that straddled expiry is never expired
                   -- mid-run (row locks would have excluded it anyway).
                   OR (
                     session.status = 'completing'
                     AND session.updated_at <= now() - ($3 * INTERVAL '1 second')
                   )
                 )
               ORDER BY session.expires_at, session.id
               LIMIT $1
               FOR UPDATE OF session SKIP LOCKED
             ), expired AS (
               UPDATE asset_upload_sessions AS session
               SET status = 'expired', updated_at = now()
               FROM due
               WHERE session.id = due.id
               RETURNING session.id, session.asset_id, session.object_key,
                         session.expires_at
             ), staged AS (
               -- The reservation's bytes are transferred onto the staged row rather
               -- than simply released: the staged object may still physically exist,
               -- so dropping the charge here would understate live storage. The staged
               -- row is then reclaimed through the normal deleting->deleted settlement,
               -- releasing the charge exactly once.
               UPDATE asset_objects AS object
               SET reserved_bytes = CASE
                     WHEN object.r2_key = expired.object_key
                          AND object.bytes IS NULL
                     THEN COALESCE(object.reserved_bytes, reservation.bytes)
                     ELSE object.reserved_bytes
                   END,
                   status = 'deleting',
                   -- Preserves any active writer hold: if a presigned grant was minted
                   -- with a deadline, write_hold_until outlives the session expiry.
                   -- If hold has elapsed, GREATEST clamps it to now().
                   write_hold_until = GREATEST(
                     COALESCE(object.write_hold_until, expired.expires_at),
                     now()
                   ),
                   updated_at = now()
               FROM expired
               LEFT JOIN asset_quota_reservations AS reservation
                 ON reservation.session_id = expired.id
                AND reservation.state = 'reserved'
               WHERE object.asset_id = expired.asset_id
                 AND object.kind = 'staging'
                 AND object.status IN ('writing', 'ready')
               RETURNING object.id, object.asset_id, object.r2_key
             ), released AS (
               -- A reservation is released only once its bytes are durably
               -- accounted for: the session's own staged row took the charge,
               -- or no live row for its key exists to hold it. Scoping the
               -- staged check to the session's key — not just its asset —
               -- keeps an unrelated staging row that happened to be claimed
               -- in the same statement from falsely satisfying the release.
               UPDATE asset_quota_reservations AS reservation
               SET state = 'released', released_at = now()
               FROM expired
               WHERE reservation.session_id = expired.id
                 AND reservation.state = 'reserved'
                 AND (
                   EXISTS (
                     SELECT 1 FROM staged
                     WHERE staged.r2_key = expired.object_key
                   )
                   OR NOT EXISTS (
                     SELECT 1
                     FROM asset_objects AS object
                     WHERE object.asset_id = expired.asset_id
                       AND object.kind = 'staging'
                       AND object.r2_key = expired.object_key
                       AND object.status <> 'deleted'
                   )
                 )
               RETURNING reservation.session_id
             ), failed AS (
               UPDATE assets AS asset
               SET status = 'failed',
                   failure_code = 'upload_session_expired',
                   failure_message = 'The upload session expired before completion.',
                   failure_retryable = true,
                   failure_at = now(),
                   orphaned_at = CASE
                     WHEN EXISTS (
                       SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                     ) THEN NULL
                     ELSE now()
                   END,
                   orphan_delete_after = CASE
                     WHEN EXISTS (
                       SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                     ) THEN NULL
                     ELSE now() + make_interval(days => $2)
                   END,
                   updated_at = now()
               FROM expired
               WHERE asset.id = expired.asset_id
                 AND asset.status IN ('pending_upload', 'uploading')
               RETURNING asset.id
             )
             SELECT (SELECT COUNT(*)::integer FROM expired) AS sessions`,
            [maintenanceBound, orphanGraceDays, staleWritingGraceSeconds],
          ),
        ).pipe(Effect.mapError(asError)),
        {
          onFailure: () => undefined,
          onSuccess: (result) => result,
        },
      );
      return {
        errors: expired ? 0 : 1,
        sessions: expired?.rows[0]?.sessions ?? 0,
      };
    });
  }

  /**
   * Reclaims staged bytes of upload sessions that reached a terminal state.
   *
   * `abortUploadSession` and session expiry already hand their staging object
   * to the sweep, but a client that simply disappeared, or a completion that
   * failed after the session row was already terminal, can leave a `writing`
   * object holding a reservation with nothing left to complete it. This pass
   * closes that hole without touching a session that is still live.
   *
   * As in the abort pass, the reservation handoff, the reclaim claim, and the
   * writer hold are one `asset_objects` UPDATE, and the reservation is only
   * released once its bytes are accounted for — so the handoff can never be
   * lost between two statements that both target the same inventory row.
   *
   * The same statement fails an Asset that is still waiting on one of these
   * terminal sessions, with the reason the session's own end implies: an
   * abort reads as a cancellation and anything else as an expiry, exactly as
   * the API would have recorded it. Finished states are never overwritten, so
   * a processing, ready, or reclaiming Asset keeps what its native run decided.
   *
   * @returns Effect resolving to the number of terminal sessions reclaimed and per-item failures absorbed.
   */
  function reclaimTerminalSessionStaging(): Effect.Effect<
    { errors: number; sessions: number },
    Error
  > {
    return Effect.gen(function* () {
      const reclaimed = yield* Effect.match(
        withSystemTransactionEffect(env, (client) =>
          client.query<{ failed: number; sessions: number }>(
            `WITH terminal AS (
               SELECT session.id, session.asset_id, session.expires_at,
                      session.object_key, session.status
               FROM asset_upload_sessions AS session
               WHERE session.status IN ('completed', 'aborted', 'expired')
                 AND session.expires_at <= now()
                 AND EXISTS (
                   SELECT 1
                   FROM asset_objects AS object
                   WHERE object.asset_id = session.asset_id
                     AND object.kind = 'staging'
                     AND object.status = 'writing'
                 )
               ORDER BY session.expires_at, session.id
               LIMIT $1
               FOR UPDATE OF session SKIP LOCKED
             ), staged AS (
               -- The session's reservation is transferred onto its own staged
               -- row instead of being dropped here: the staged object may
               -- still physically exist, so releasing the charge would
               -- understate live storage. The deleting→deleted settlement
               -- releases it exactly once, after the external delete
               -- completes. Handoff, claim, and hold are one UPDATE because
               -- sibling data-modifying CTEs cannot both write one row.
               UPDATE asset_objects AS object
               SET reserved_bytes = CASE
                     WHEN object.r2_key = terminal.object_key
                          AND object.bytes IS NULL
                     THEN COALESCE(object.reserved_bytes, reservation.bytes)
                     ELSE object.reserved_bytes
                   END,
                   status = 'deleting',
                   -- The row's own recorded grant deadline is the writer
                   -- bound: minted URLs never outlive it, and sessions
                   -- reached here are already past expiry so their backfilled
                   -- holds have lapsed too. A missing deadline falls back to
                   -- the terminal session's expiry for rows older than
                   -- per-grant recording.
                   write_hold_until = GREATEST(
                     COALESCE(object.write_hold_until, terminal.expires_at),
                     now()
                   ),
                   updated_at = now()
               FROM terminal
               LEFT JOIN asset_quota_reservations AS reservation
                 ON reservation.session_id = terminal.id
                AND reservation.state = 'reserved'
               WHERE object.asset_id = terminal.asset_id
                 AND object.kind = 'staging'
                 AND object.status = 'writing'
               RETURNING object.id, object.asset_id, object.r2_key
             ), released AS (
               -- A reservation whose bytes no inventory row accounts for
               -- would hold capacity forever, so it is released only when the
               -- staged row above took the charge or the session has no
               -- staging object left to hold them.
               UPDATE asset_quota_reservations AS reservation
               SET state = 'released', released_at = now()
               FROM terminal
               WHERE reservation.session_id = terminal.id
                 AND reservation.state = 'reserved'
                 AND (
                   EXISTS (
                     SELECT 1 FROM staged
                     WHERE staged.r2_key = terminal.object_key
                   )
                   OR NOT EXISTS (
                     SELECT 1
                       FROM asset_objects AS object
                      WHERE object.asset_id = terminal.asset_id
                        AND object.kind = 'staging'
                        AND object.r2_key = terminal.object_key
                        AND object.status <> 'deleted'
                   )
                 )
               RETURNING reservation.session_id
               ), failed AS (
                 -- A terminal session whose staged row is still 'writing'
                 -- leaves its Asset waiting on an upload that can never
                 -- finish, so the durable reason the session's end implies is
                 -- recorded here too. Only unfinished upload states are
                 -- touched, and only an unretained Asset starts the clock.
                 UPDATE assets AS asset
                 SET status = 'failed',
                     failure_code = CASE
                       WHEN terminal.status = 'aborted' THEN 'upload_aborted'
                       ELSE 'upload_session_expired'
                     END,
                     failure_message = CASE
                       WHEN terminal.status = 'aborted'
                         THEN 'The upload was cancelled.'
                       ELSE 'The upload session expired before completion.'
                     END,
                     failure_retryable = true,
                     failure_at = now(),
                     orphaned_at = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                       ) THEN NULL
                       ELSE now()
                     END,
                     orphan_delete_after = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = asset.id
                       ) THEN NULL
                       ELSE now() + make_interval(days => $2)
                     END,
                     updated_at = now()
                 FROM terminal
                 WHERE asset.id = terminal.asset_id
                   AND asset.status IN ('pending_upload', 'uploading')
                 RETURNING asset.id
               )
               SELECT (SELECT COUNT(DISTINCT staged.asset_id)::integer
                       FROM staged) AS sessions`,
            [maintenanceBound, orphanGraceDays],
          ),
        ).pipe(Effect.mapError(asError)),
        {
          onFailure: () => {
            return undefined;
          },
          onSuccess: (result) => result,
        },
      );
      return {
        errors: reclaimed ? 0 : 1,
        sessions: reclaimed?.rows[0]?.sessions ?? 0,
      };
    });
  }

  /**
   * Reclaims abandoned in-flight writes whose bytes were already charged.
   *
   * A staged upload whose creator vanished can hold verified-but-never-promoted
   * bytes, and a processing run that died after recording its output size left
   * a charged object nothing will ever commit. The grace period exceeds the
   * 600s processing lease, and the pass skips any Asset still processing, any
   * rendition row still live, and any upload session that has not expired, so
   * only genuinely abandoned writes are reclaimed.
   *
   * Eligibility is resolved by a bounded candidate page locked with
   * `FOR UPDATE SKIP LOCKED` before anything is claimed, because PostgreSQL
   * cannot order or limit an `UPDATE`: the page is what makes the sweep bounded
   * and the row locks are what keep two concurrent sweeps from reclaiming the
   * same write twice.
   *
   * Only rows whose bytes settled into `usage_records` are reclaimed here,
   * because that charge has to be released. A reservation that never settled
   * was never added to the period's charge, so it is released by deleting the
   * row in `releaseStaleProcessingStaging` instead — settling it through
   * the shared settlement would subtract bytes that were never counted.
   *
   * @returns Effect resolving to the number of objects reclaimed and per-item failures absorbed.
   */
  function reclaimStaleWritingObjects(): Effect.Effect<{ deleted: number; errors: number }, Error> {
    return Effect.gen(function* () {
      const claimed = yield* withSystemTransactionEffect(env, (client) =>
        client
          .query<ClaimedAssetObject>(
            `WITH candidates AS (
               SELECT object.id
               FROM asset_objects AS object
               WHERE object.status = 'writing'
                 AND object.bytes IS NOT NULL
                 AND object.updated_at <= now() - ($1 * INTERVAL '1 second')
                 AND (
                   object.write_hold_until IS NULL
                   OR object.write_hold_until <= now()
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM asset_renditions AS rendition
                   WHERE rendition.object_id = object.id
                     AND rendition.status = 'processing'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM assets AS asset
                   WHERE asset.id = object.asset_id
                     AND asset.status = 'processing'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM asset_upload_sessions AS session
                   WHERE session.asset_id = object.asset_id
                     AND session.status IN ('created', 'uploading', 'completing')
                     AND session.expires_at > now()
                 )
               ORDER BY object.updated_at, object.id
               LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             UPDATE asset_objects AS object
             SET status = 'deleting', updated_at = now()
             FROM candidates
             WHERE object.id = candidates.id
               AND object.status = 'writing'
             RETURNING object.id, object.asset_id, object.org_id, object.kind,
                       object.r2_key, object.bytes, object.reserved_bytes,
                       object.status`,
            [staleWritingGraceSeconds, maintenanceBound],
          )
          .pipe(Effect.map((result) => result.rows)),
      ).pipe(Effect.mapError(asError));

      let deleted = 0;
      let errors = 0;
      const reclaimed: Array<{ id: string }> = [];
      for (const object of claimed) {
        const removed = yield* Effect.match(deleteObject(storage, object.r2_key), {
          onFailure: () => {
            errors += 1;
            return false;
          },
          onSuccess: () => true,
        });
        if (removed) reclaimed.push({ id: object.id });
      }
      if (reclaimed.length > 0) {
        const settled = yield* Effect.match(
          settleDeletedObjects(env, reclaimed).pipe(Effect.mapError(asError)),
          {
            onFailure: () => {
              errors += 1;
              return undefined;
            },
            onSuccess: (result) => result,
          },
        );
        deleted = settled?.deleted_objects ?? 0;
      }
      return { deleted, errors };
    });
  }

  /**
   * Re-arms lifecycle events for Assets whose worker was lost.
   *
   * The threshold is above every Asset lease, so a genuinely stuck Asset (a
   * promotion or a deletion interrupted mid-flight) gets a fresh event while a
   * healthy long-running processor is never disturbed. The dedupe key includes
   * the stuck status so re-processing and re-deletion never share an identity.
   *
   * @returns Effect resolving to the number of recovery events armed.
   */
  function rearmStuckJobs(): Effect.Effect<number, Error> {
    return withSystemTransactionEffect(env, (client) =>
      client
        .query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
           SELECT
             asset.org_id,
             CASE asset.status
               WHEN 'deleting' THEN 'asset.deletion.requested'
               ELSE 'asset.processing.requested'
             END,
             'asset',
             asset.id,
             concat('asset:', asset.id, ':lifecycle-recovery:', asset.status),
             jsonb_build_object('asset_id', asset.id, 'lifecycle_recovery', true)
           FROM assets AS asset
           WHERE asset.status IN ('processing', 'deleting')
           AND asset.updated_at <= now() - ($1 * INTERVAL '1 second')
           ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING
           RETURNING id`,
          [stuckAssetGraceSeconds],
        )
        .pipe(
          Effect.map((result) => result.rowCount ?? 0),
          Effect.mapError(asError),
        ),
    );
  }

  return {
    /**
     * Main queue consumer entrypoint for processing asset outbox events.
     *
     * Claims an event lease with the topic-appropriate duration, dispatches
     * either media processing or deletion, converts an unrecoverable media
     * failure into a durable 'failed' Asset, and otherwise records the failure
     * on the lease so the Queue redelivers. The work program and its catch
     * handler share the outer gen scope so the handler can read claimedRow
     * (assigned inside the work program) when resolving the row for a permanent
     * failure; classifyJobError runs last so handler-raised failures are
     * classified too.
     *
     * @param message - Outbox message describing the requested asset operation.
     * @returns Effect resolving to 'processed' when handled or permanently failed, or 'skipped'
     *   if not applicable; fails with a classified AutomationJobError otherwise.
     */
    process(message: OutboxMessage): Effect.Effect<"processed" | "skipped", AutomationJobError> {
      return Effect.gen(function* () {
        const event = descriptor(message);
        // claimedRow is assigned inside the work program and read by the catch
        // handler below; both live in this gen scope so the handler closes over it.
        let claimedRow: AssetJobRow | undefined;
        const work = Effect.gen(function* () {
          const prepared = yield* withSystemTransactionEffect(env, (client) =>
            Effect.gen(function* () {
              if (!(yield* beginEvent(client, event))) {
                return { claimed: false, row: undefined };
              }
              const row = yield* assetRow(client, event);
              if (!row) {
                yield* finishEvent(client, event.eventKey, "skipped");
                return { claimed: true, row: undefined };
              }
              return { claimed: true, row };
            }),
          ).pipe(Effect.mapError(asError));
          if (!prepared.claimed || !prepared.row) return "skipped" as const;
          claimedRow = prepared.row;
          if (event.topic === "asset.deletion.requested") {
            return yield* processDeletion(event, claimedRow);
          }
          return yield* processMedia(event, claimedRow);
        });
        return yield* Effect.catch(work, (cause): Effect.Effect<"processed" | "skipped", Error> =>
          Effect.gen(function* () {
            // Records the failure on the lease and rethrows the original cause:
            // the shared tail of the permanent-failure path (no row found) and
            // every other failure. JobInProgressError skips the record so a
            // competing worker's active lease is not clobbered.
            const recordFailure: Effect.Effect<never, Error> = Effect.gen(function* () {
              if (!(cause instanceof JobInProgressError)) {
                yield* Effect.catch(
                  failEvent(env, event.eventKey, cause).pipe(Effect.mapError(asError)),
                  () => Effect.void,
                );
                emitLifecycleEvidence(
                  env,
                  "error",
                  event.eventKey,
                  {
                    asset_id: event.aggregateId,
                    error_code: "asset_job_failed",
                    event: "asset_job_failed",
                    outcome: "retry",
                    topic: event.topic,
                  },
                  cause,
                );
              }
              return yield* Effect.fail(cause);
            });
            // A terminal media failure is already durable: the media module
            // wrote assets.status='failed' plus the actionable failure code
            // and released its output reservation before failing. All that is
            // left is to conclude the lease, so redelivery cannot re-run a
            // job whose input can never succeed, and to record the evidence an
            // Operator investigates. The UPDATE guards are status-scoped, so
            // they are a no-op when that write already happened.
            if (cause instanceof TerminalJobError) {
              const row =
                claimedRow ??
                (yield* withSystemTransactionEffect(env, (client) => assetRow(client, event)).pipe(
                  Effect.mapError(asError),
                ));
              if (row) {
                yield* markPermanentFailure(env, event.eventKey, row, cause).pipe(
                  Effect.mapError(asError),
                );
                emitLifecycleEvidence(
                  env,
                  "error",
                  event.eventKey,
                  {
                    asset_id: row.id,
                    error_code: cause.code,
                    event: "asset_processing_failed_permanently",
                    outcome: "failed",
                    topic: event.topic,
                  },
                  cause,
                );
                return "processed" as const;
              }
            }
            return yield* recordFailure;
          }),
        );
      }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
    },

    /**
     * Performs bounded hourly maintenance over orphaned media, abandoned
     * multipart and single-PUT uploads, abandoned in-flight writes, and lost Asset jobs.
     *
     * The orphan sweep is the ownership-aware reclamation path: it claims only
     * Assets whose seven-day grace elapsed and whose bytes no retained Post,
     * live processing, promotion, or Provider attempt needs, writing each
     * `asset.deletion.requested` event and its `deleting` transition in one
     * statement. There is deliberately no age-based purge of failed Assets: a
     * saved draft's failed attachment must keep its actionable error, and an
     * unretained one ages out through this same sweep.
     *
     * The upload passes are the other half of that contract: a session the
     * sweep ends also fails the Asset still waiting on it, with the reason the
     * session's own end implies, so no Asset is left pending forever. Both
     * incomplete multipart uploads and abandoned single-PUT sessions are expired
     * autonomously without requiring client disappearance or another tenant action.
     * Only unfinished upload states are failed, and only an unretained Asset starts
     * the seven-day clock.
     * Per-item abort/delete failures increment `cleanup_errors` and continue;
     * the sweep queries and usage reconciliation propagate and are classified
     * at the end.
     *
     * @returns Effect resolving to sweep counters for claimed orphans, reclaimed sessions and writes, re-armed jobs, and reconciled usage.
     */
    runMaintenance() {
      return Effect.gen(function* () {
        const orphanAssetsClaimed = yield* claimDueOutboxWork(
          env,
          "asset_orphan_sweep",
          maintenanceBound,
        );

        const multipart = yield* abortAbandonedMultipartUploads();
        const single = yield* expireAbandonedSingleUploadSessions();
        const terminal = yield* reclaimTerminalSessionStaging();
        const stale = yield* reclaimStaleWritingObjects();
        // Promoted staging copies a crashed run left charged but never
        // deleted. The media-processing module owns this adoption-or-release
        // decision because it alone knows when a redelivered job could still
        // adopt a `superseded` row; the protected ready key is never touched.
        const releasedStaging = yield* Effect.match(
          releaseStaleProcessingStaging(env, storage, maintenanceBound),
          {
            onFailure: () => ({ errors: 1, released: 0 }),
            onSuccess: (released) => ({ errors: 0, released }),
          },
        );
        const reconciliationEvents = yield* rearmStuckJobs();
        const usage = yield* Effect.tryPromise({
          catch: asError,
          try: () => reconcileDueUsage(env),
        });

        const cleanupErrors =
          multipart.errors +
          single.errors +
          terminal.errors +
          stale.errors +
          releasedStaging.errors;
        const expiredSessions = multipart.sessions + single.sessions;
        emitLifecycleEvidence(env, cleanupErrors > 0 ? "warn" : "info", "asset-maintenance", {
          cleanup_errors: cleanupErrors,
          event: "asset_maintenance_completed",
          expired_sessions: expiredSessions,
          orphan_assets_claimed: orphanAssetsClaimed,
          outcome: "swept",
          reconciliation_events: reconciliationEvents,
          released_staging_objects: releasedStaging.released,
          stale_writing_objects_deleted: stale.deleted,
          terminal_sessions_reclaimed: terminal.sessions,
        });

        return {
          cleanup_errors: cleanupErrors,
          expired_sessions: expiredSessions,
          orphan_assets_claimed: orphanAssetsClaimed,
          reconciliation_events: reconciliationEvents,
          stale_writing_objects_deleted: stale.deleted,
          terminal_sessions_reclaimed: terminal.sessions,
          usage_rows: usage.reconciled,
        } satisfies AssetMaintenanceResult;
      }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
    },
  };
}
