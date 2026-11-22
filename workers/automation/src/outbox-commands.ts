import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { maximumDelayedDeliverySeconds, type DatabaseError } from "@meltiply/domain";

/** Closed set of outbox topics emitted by automation producers. */
type OutboxCommandTopic =
  | "asset.deletion.requested"
  | "asset.processing.requested"
  | "comment.reply.requested"
  | "distribution.publish.requested"
  | "distribution.reconcile.requested";

/** Closed set of aggregate types owning automation outbox commands. */
export type OutboxAggregateType = "asset" | "comment" | "distribution";

/** Conflict behavior when an identical `(org_id, topic, dedupe_key)` already exists. */
export type OutboxConflictMode = "nothing" | "revive";

/**
 * Typed dedupe-key builders keeping outbox command identities in one module.
 * Every builder preserves the exact persisted wire format used by in-flight
 * outbox rows and due-work scans.
 */
export const outboxDedupeKey = {
  /** Re-arms a stuck asset processing or deletion lifecycle job. */
  assetLifecycleRecovery(assetId: string, status: string): string {
    return `asset:${assetId}:lifecycle-recovery:${status}`;
  },
  /** Arms the next comment reply reconciliation attempt (1-based attempt suffix). */
  commentReplyReconcile(commentId: string, completedAttempts: number): string {
    return `comment-reply-reconcile:${commentId}:${completedAttempts + 1}`;
  },
  /** Parks a rate-limited distribution publish until its next retry window. */
  distributionRateLimitPark(distributionId: string, sourceEventId: string): string {
    return `distribution:${distributionId}:rate-limit-park:${sourceEventId}`;
  },
  /** Arms the next distribution reconcile attempt (1-based attempt suffix). */
  distributionReconcile(distributionId: string, completedAttempts: number): string {
    return `distribution:${distributionId}:reconcile:${completedAttempts + 1}`;
  },
} as const;

/**
 * SQL dedupe-key expression builders for set-based `INSERT ... SELECT` queries
 * (`due-work.ts`, `assets.ts`). Expressions must match `outboxDedupeKey` byte-for-byte.
 */
export const outboxDedupeKeySql = {
  assetLifecycleRecovery(idExpr: string, statusExpr: string): string {
    return `concat('asset:', ${idExpr}, ':lifecycle-recovery:', ${statusExpr})`;
  },
  commentReplyReconcile(idExpr: string, attemptExpr: string): string {
    return `concat('comment-reply-reconcile:', ${idExpr}, ':', (${attemptExpr} + 1)::text)`;
  },
  distributionReconcile(idExpr: string, attemptExpr: string): string {
    return `concat('distribution:', ${idExpr}, ':reconcile:', ${attemptExpr} + 1)`;
  },
} as const;

/**
 * Builds the `ON CONFLICT` clause for outbox command inserts.
 *
 * `"nothing"` drops duplicates without altering existing rows. `"revive"`
 * resurrects a `'dead'` row or a `'published'` row older than the delayed
 * delivery horizon as `'pending'` with a fresh attempt budget while leaving
 * live rows untouched.
 *
 * @param mode - Conflict handling policy (`"nothing"` or `"revive"`).
 * @param horizonParameter - SQL placeholder binding `maximumDelayedDeliverySeconds` (required when `mode === "revive"`).
 * @returns SQL `ON CONFLICT ...` fragment.
 */
export function outboxConflictClause(mode: "nothing"): string;
export function outboxConflictClause(mode: "revive", horizonParameter: string): string;
export function outboxConflictClause(mode: OutboxConflictMode, horizonParameter?: string): string {
  if (mode === "nothing") {
    return "ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING";
  }
  return `ON CONFLICT (org_id, topic, dedupe_key) DO UPDATE
            SET state = 'pending',
                attempt_count = 0,
                available_at = now(),
                lease_expires_at = NULL,
                published_at = NULL,
                last_error = NULL,
                updated_at = now()
          WHERE outbox_events.state = 'dead'
             OR (outbox_events.state = 'published'
                 AND outbox_events.updated_at
                     <= now() - (${horizonParameter} * INTERVAL '1 second'))`;
}

export interface OutboxCommandInput {
  readonly aggregateId: string;
  readonly aggregateType: OutboxAggregateType;
  readonly dedupeKey: string;
  readonly onConflict: OutboxConflictMode;
  readonly orgId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly topic: OutboxCommandTopic;
}

/**
 * Inserts one outbox command with an explicit conflict policy.
 *
 * Uses `(org_id, topic, dedupe_key)` as the uniqueness target so duplicate
 * arming is idempotent; when `onConflict` is `"revive"`, dead or stale
 * published rows past the delayed-delivery horizon are reset to `'pending'`.
 *
 * @param client - Active Effect transaction client.
 * @param command - Typed outbox command descriptor.
 * @returns Effect resolving to the number of rows inserted or revived (0 or 1).
 */
export function armOutboxCommand(
  client: EffectTransactionClient,
  command: OutboxCommandInput,
): Effect.Effect<number, DatabaseError> {
  const conflictSql =
    command.onConflict === "revive"
      ? outboxConflictClause("revive", "$7")
      : outboxConflictClause("nothing");
  const values: unknown[] = [
    command.orgId,
    command.topic,
    command.aggregateType,
    command.aggregateId,
    command.dedupeKey,
    JSON.stringify(command.payload),
    ...(command.onConflict === "revive" ? [maximumDelayedDeliverySeconds] : []),
  ];
  return Effect.map(
    client.query(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb)
       ${conflictSql}`,
      values,
    ),
    (result) => result.rowCount ?? 0,
  );
}
