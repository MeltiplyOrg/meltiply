import { Effect } from "effect";
import {
  assetLeaseSeconds,
  claimJobLease,
  finishJobLease,
  jobLeaseOutcome,
  JobInProgressError,
} from "./job-lease";
import {
  assetOrphanGraceSeconds,
  maximumDelayedDeliverySeconds,
  type DatabaseError,
} from "@meltiply/domain";
import { createObjectStoreFromEnv, type ObjectStore } from "@meltiply/storage";
import { errorDiagnostic, log } from "@meltiply/observability";

import {
  claimObjectsForDeletion,
  deleteObjectsAndSettleEffect,
  type ClaimedAssetObject,
} from "./object-cleanup";
import { safeErrorMessage, toError as asError } from "./errors";
import { withSystemTransactionEffect, type EffectTransactionClient } from "./database";
import { classifyJobError, TerminalJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { claimDueOutboxWork } from "./due-work";
import { type OutboxMessage } from "./messages";
import { outboxConflictClause, outboxDedupeKeySql } from "./outbox-commands";
import { reconcileDueUsageEffect } from "./usage";
import {
  failAssetInTransaction,
  processAssetMedia,
  releaseStaleProcessingStaging,
} from "./asset-processing";

export interface AssetMaintenanceResult {
  cleanup_errors: number;
  expired_sessions: number;
  orphan_assets_claimed: number;
  reconciliation_events: number;
  stale_writing_objects_deleted: number;
  terminal_sessions_reclaimed: number;
  usage_rows: number;
}

export interface AssetJobProcessor {
  process(message: OutboxMessage): Effect.Effect<"processed" | "skipped", AutomationJobError>;
  runMaintenance(): Effect.Effect<AssetMaintenanceResult, AutomationJobError>;
}

const multipartAbandonGraceSeconds = 3600;
const staleWritingGraceSeconds = 1800;
const stuckAssetGraceSeconds = 900;
const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);
const maintenanceBound = 50;

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

function logContext(
  env: AutomationEnv,
  eventKey: string,
): {
  environment: string;
  job_id: string;
  service: string;
  trace_id: string;
  version: string;
} {
  return {
    environment: env.ENVIRONMENT,
    job_id: eventKey,
    service: "automation",
    trace_id: eventKey,
    version: env.VERSION,
  };
}

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
  topic: string;
}

function descriptor(message: OutboxMessage): AssetEventDescriptor {
  return {
    aggregateId: message.aggregate_id,
    eventKey: `outbox:${message.event_id}`,
    jobType: message.topic,
    organizationId: message.organization_id,
    topic: message.topic,
  };
}

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

function finishEvent(
  client: EffectTransactionClient,
  eventKey: string,
  outcome: "skipped" | "succeeded",
  aggregateId?: string,
): Effect.Effect<void, DatabaseError> {
  return finishJobLease(client, eventKey, outcome, { aggregateId });
}

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

function markPermanentFailure(
  env: AutomationEnv,
  eventKey: string,
  row: AssetJobRow,
  cause: TerminalJobError,
): Effect.Effect<void, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* failAssetInTransaction(client, row.id, undefined, {
        code: cause.code,
        message: safeErrorMessage(cause),
      });
      yield* finishEvent(client, eventKey, "succeeded", row.id);
    }),
  );
}

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

function reclaimSessionStagingSql(options: {
  readonly failureCodeSql: string;
  readonly failureMessageSql: string;
  readonly orphanGraceParam: string;
  readonly selectSql: string;
  readonly sessionCteName: string;
  readonly sessionCteSql: string;
  readonly stagingStatusesSql: string;
  readonly writeHoldSql: string;
}): string {
  const cte = options.sessionCteName;
  return `WITH ${options.sessionCteSql},
          staged AS (
            UPDATE asset_objects AS object
            SET reserved_bytes = CASE
                  WHEN object.r2_key = ${cte}.object_key
                       AND object.bytes IS NULL
                  THEN COALESCE(object.reserved_bytes, reservation.bytes)
                  ELSE object.reserved_bytes
                END,
                status = 'deleting',
                write_hold_until = ${options.writeHoldSql},
                updated_at = now()
            FROM ${cte}
            LEFT JOIN asset_quota_reservations AS reservation
              ON reservation.session_id = ${cte}.id
             AND reservation.state = 'reserved'
            WHERE object.asset_id = ${cte}.asset_id
              AND object.kind = 'staging'
              AND object.status ${options.stagingStatusesSql}
            RETURNING object.id, object.asset_id, object.r2_key
          ), released AS (
            UPDATE asset_quota_reservations AS reservation
            SET state = 'released', released_at = now()
            FROM ${cte}
            WHERE reservation.session_id = ${cte}.id
              AND reservation.state = 'reserved'
              AND (
                EXISTS (
                  SELECT 1 FROM staged
                  WHERE staged.r2_key = ${cte}.object_key
                )
                OR NOT EXISTS (
                  SELECT 1
                    FROM asset_objects AS object
                   WHERE object.asset_id = ${cte}.asset_id
                     AND object.kind = 'staging'
                     AND object.r2_key = ${cte}.object_key
                     AND object.status <> 'deleted'
                )
              )
            RETURNING reservation.session_id
          ), failed AS (
            UPDATE assets AS asset
            SET status = 'failed',
                failure_code = ${options.failureCodeSql},
                failure_message = ${options.failureMessageSql},
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
                  ELSE now() + make_interval(days => ${options.orphanGraceParam})
                END,
                updated_at = now()
            FROM ${cte}
            WHERE asset.id = ${cte}.asset_id
              AND asset.status IN ('pending_upload', 'uploading')
            RETURNING asset.id
          )
          ${options.selectSql}`;
}

export function rearmStuckAssetJobs(env: AutomationEnv): Effect.Effect<number, Error> {
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
           ${outboxDedupeKeySql.assetLifecycleRecovery("asset.id", "asset.status")},
           jsonb_build_object('asset_id', asset.id, 'lifecycle_recovery', true)
         FROM assets AS asset
         WHERE asset.status IN ('processing', 'deleting')
         AND asset.updated_at <= now() - ($1 * INTERVAL '1 second')
         ${outboxConflictClause("revive", "$2")}
         RETURNING id`,
        [stuckAssetGraceSeconds, maximumDelayedDeliverySeconds],
      )
      .pipe(
        Effect.map((result) => result.rowCount ?? 0),
        Effect.mapError(asError),
      ),
  );
}

export function createAssetJobProcessor(
  env: AutomationEnv,
  objectStore?: ObjectStore,
): AssetJobProcessor {
  const storage = objectStore ?? createObjectStoreFromEnv(env);

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
      const cleanup = yield* deleteObjectsAndSettleEffect(env, storage, claimed).pipe(
        Effect.mapError(asError),
      );
      const failure = cleanup.firstError;
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
          deleted_objects: cleanup.deletedObjects,
          event: "asset_deletion_processed",
          outcome: completed && !failure ? "reclaimed" : "incomplete",
          released_bytes: cleanup.releasedBytes,
          remaining_objects: remaining,
        },
        failure,
      );
      if (failure) return yield* Effect.fail(failure);
      return completed ? ("processed" as const) : ("skipped" as const);
    });
  }

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
      const abortSql = reclaimSessionStagingSql({
        failureCodeSql: "'upload_aborted'",
        failureMessageSql: "'The upload was cancelled.'",
        orphanGraceParam: "$2",
        selectSql: `SELECT (SELECT COUNT(*)::integer FROM expired) AS sessions,
                           (SELECT COUNT(*)::integer FROM staged) AS staged,
                           (SELECT COUNT(*)::integer FROM failed) AS failed`,
        sessionCteName: "expired",
        sessionCteSql: `expired AS (
            UPDATE asset_upload_sessions
            SET status = 'aborted', aborted_at = now(), updated_at = now()
            WHERE id = $1 AND status IN ('created', 'uploading')
            RETURNING id, asset_id, object_key
          )`,
        stagingStatusesSql: "= 'writing'",
        writeHoldSql: "now()",
      });
      for (const row of abandoned) {
        const aborted = yield* Effect.match(
          Effect.tryPromise({
            catch: asError,
            try: () =>
              storage.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort(),
          }),
          {
            onFailure: (cause) => {
              errors += 1;
              emitLifecycleEvidence(
                env,
                "warn",
                "asset-maintenance",
                {
                  asset_id: row.asset_id,
                  event: "multipart_upload_abort_failed",
                  outcome: "failed",
                  session_id: row.id,
                },
                cause,
              );
              return false;
            },
            onSuccess: () => true,
          },
        );
        if (!aborted) continue;
        const cleared = yield* Effect.match(
          withSystemTransactionEffect(env, (client) =>
            client.query<{ failed: number; sessions: number; staged: number }>(abortSql, [
              row.id,
              orphanGraceDays,
            ]),
          ).pipe(Effect.mapError(asError)),
          {
            onFailure: (cause) => {
              errors += 1;
              emitLifecycleEvidence(
                env,
                "warn",
                "asset-maintenance",
                {
                  asset_id: row.asset_id,
                  event: "multipart_upload_reclaim_failed",
                  outcome: "failed",
                  session_id: row.id,
                },
                cause,
              );
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

  function expireAbandonedSingleUploadSessions(): Effect.Effect<
    { errors: number; sessions: number },
    Error
  > {
    return Effect.gen(function* () {
      const expireSql = reclaimSessionStagingSql({
        failureCodeSql: "'upload_session_expired'",
        failureMessageSql: "'The upload session expired before completion.'",
        orphanGraceParam: "$2",
        selectSql: `SELECT (SELECT COUNT(*)::integer FROM expired) AS sessions`,
        sessionCteName: "expired",
        sessionCteSql: `due AS (
            SELECT session.id, session.asset_id, session.object_key,
                   session.expires_at
            FROM asset_upload_sessions AS session
            WHERE (session.strategy = 'single' OR session.multipart_upload_id IS NULL)
              AND session.expires_at <= now()
              AND (
                session.status IN ('created', 'uploading')
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
          )`,
        stagingStatusesSql: "IN ('writing', 'ready')",
        writeHoldSql: "GREATEST(COALESCE(object.write_hold_until, expired.expires_at), now())",
      });
      const expired = yield* Effect.match(
        withSystemTransactionEffect(env, (client) =>
          client.query<{ sessions: number }>(expireSql, [
            maintenanceBound,
            orphanGraceDays,
            staleWritingGraceSeconds,
          ]),
        ).pipe(Effect.mapError(asError)),
        {
          onFailure: (cause) => {
            emitLifecycleEvidence(
              env,
              "warn",
              "asset-maintenance",
              { event: "single_upload_expiry_failed", outcome: "failed" },
              cause,
            );
            return undefined;
          },
          onSuccess: (result) => result,
        },
      );
      return {
        errors: expired ? 0 : 1,
        sessions: expired?.rows[0]?.sessions ?? 0,
      };
    });
  }

  function reclaimTerminalSessionStaging(): Effect.Effect<
    { errors: number; sessions: number },
    Error
  > {
    return Effect.gen(function* () {
      const reclaimSql = reclaimSessionStagingSql({
        failureCodeSql: `CASE WHEN terminal.status = 'aborted' THEN 'upload_aborted' ELSE 'upload_session_expired' END`,
        failureMessageSql: `CASE WHEN terminal.status = 'aborted' THEN 'The upload was cancelled.' ELSE 'The upload session expired before completion.' END`,
        orphanGraceParam: "$2",
        selectSql: `SELECT (SELECT COUNT(DISTINCT staged.asset_id)::integer FROM staged) AS sessions`,
        sessionCteName: "terminal",
        sessionCteSql: `terminal AS (
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
          )`,
        stagingStatusesSql: "= 'writing'",
        writeHoldSql: "GREATEST(COALESCE(object.write_hold_until, terminal.expires_at), now())",
      });
      const reclaimed = yield* Effect.match(
        withSystemTransactionEffect(env, (client) =>
          client.query<{ failed: number; sessions: number }>(reclaimSql, [
            maintenanceBound,
            orphanGraceDays,
          ]),
        ).pipe(Effect.mapError(asError)),
        {
          onFailure: (cause) => {
            emitLifecycleEvidence(
              env,
              "warn",
              "asset-maintenance",
              { event: "terminal_session_reclaim_failed", outcome: "failed" },
              cause,
            );
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

      const cleanup = yield* deleteObjectsAndSettleEffect(env, storage, claimed, {
        failOnSettlementError: false,
      }).pipe(Effect.mapError(asError));
      if (cleanup.firstError) {
        emitLifecycleEvidence(
          env,
          "warn",
          "asset-maintenance",
          {
            deleted_objects: cleanup.deletedObjects,
            errors: cleanup.errors,
            event: "stale_writing_object_reclaim_failed",
            outcome: "partial",
          },
          cleanup.firstError,
        );
      }
      return { deleted: cleanup.deletedObjects, errors: cleanup.errors };
    });
  }

  return {
    process(message: OutboxMessage): Effect.Effect<"processed" | "skipped", AutomationJobError> {
      return Effect.gen(function* () {
        const event = descriptor(message);
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
        const releasedStaging = yield* Effect.match(
          releaseStaleProcessingStaging(env, storage, maintenanceBound),
          {
            onFailure: (cause) => {
              emitLifecycleEvidence(
                env,
                "warn",
                "asset-maintenance",
                { event: "stale_processing_staging_release_failed", outcome: "failed" },
                cause,
              );
              return { errors: 1, released: 0 };
            },
            onSuccess: (released) => ({ errors: 0, released }),
          },
        );
        const reconciliationEvents = yield* rearmStuckAssetJobs(env);
        const usage = yield* reconcileDueUsageEffect(env).pipe(Effect.mapError(asError));

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
