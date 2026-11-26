import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { maximumDelayedDeliverySeconds, type DatabaseError } from "@meltiply/domain";

type OutboxCommandTopic =
  | "asset.deletion.requested"
  | "asset.processing.requested"
  | "comment.reply.requested"
  | "distribution.publish.requested"
  | "distribution.reconcile.requested";

export type OutboxAggregateType = "asset" | "comment" | "distribution";

export type OutboxConflictMode = "nothing" | "rearm" | "revive";

export const outboxDedupeKey = {
  assetLifecycleRecovery(assetId: string, status: string): string {
    return `asset:${assetId}:lifecycle-recovery:${status}`;
  },
  commentReplyReconcile(commentId: string, completedAttempts: number): string {
    return `comment-reply-reconcile:${commentId}:${completedAttempts + 1}`;
  },
  distributionRateLimitPark(distributionId: string, sourceEventId: string): string {
    return `distribution:${distributionId}:rate-limit-park:${sourceEventId}`;
  },
  distributionReconcile(distributionId: string, completedAttempts: number): string {
    return `distribution:${distributionId}:reconcile:${completedAttempts + 1}`;
  },
} as const;

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

export function outboxConflictClause(mode: "nothing" | "rearm"): string;
export function outboxConflictClause(mode: "revive", horizonParameter: string): string;
export function outboxConflictClause(mode: OutboxConflictMode, horizonParameter?: string): string {
  if (mode === "nothing") {
    return "ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING";
  }
  if (mode === "rearm") {
    return `ON CONFLICT (org_id, topic, dedupe_key) DO UPDATE
            SET id = gen_random_uuid(),
                state = 'pending',
                attempt_count = 0,
                available_at = now(),
                lease_expires_at = NULL,
                published_at = NULL,
                last_error = NULL,
                updated_at = now()
          WHERE outbox_events.state IN ('published', 'dead')`;
  }
  return `ON CONFLICT (org_id, topic, dedupe_key) DO UPDATE
            SET id = gen_random_uuid(),
                state = 'pending',
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

export function armOutboxCommand(
  client: EffectTransactionClient,
  command: OutboxCommandInput,
): Effect.Effect<number, DatabaseError> {
  const conflictSql =
    command.onConflict === "revive"
      ? outboxConflictClause("revive", "$7")
      : outboxConflictClause(command.onConflict);
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

export function armDistributionReconcile(
  client: EffectTransactionClient,
  target: {
    readonly completedAttempts: number;
    readonly distributionId: string;
    readonly orgId: string;
  },
): Effect.Effect<void, DatabaseError> {
  return armOutboxCommand(client, {
    aggregateId: target.distributionId,
    aggregateType: "distribution",
    dedupeKey: outboxDedupeKey.distributionReconcile(
      target.distributionId,
      target.completedAttempts,
    ),
    onConflict: "rearm",
    orgId: target.orgId,
    payload: { distribution_id: target.distributionId, version: 1 },
    topic: "distribution.reconcile.requested",
  }).pipe(Effect.asVoid);
}
