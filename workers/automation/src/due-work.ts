import { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "./database";
import { type AutomationJobError, classifyJobError } from "./effect/index";
import { recurringCommentsEnabled, type AutomationEnv } from "./env";
import { safeErrorMessage } from "./errors";
import type { ProviderSyncWorkload } from "./messages";
import {
  outboxConflictClause,
  outboxDedupeKeySql,
  type OutboxAggregateType,
} from "./outbox-commands";
export { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds };

export const distributionProcessingGraceSeconds = 300;

const minimumProviderVisibilityTimeoutSeconds = 120;
export const providerAttemptLeaseSeconds = Math.floor(minimumProviderVisibilityTimeoutSeconds / 2);

export const maximumProviderSyncAttempts = 20;
export const maximumReconciliationAttempts = 10;

export const maximumProviderPollAttempts = 90;
export const providerPollIntervalSeconds = 20;

export const onDemandCommentsBound = 10;
const onDemandCommentsIntervalSeconds = 900;

export interface DueWorkClaim extends Record<string, unknown> {
  event_id: string;
  next_due_at?: Date | string | null;
  target_id: string;
}

export interface FailedDueWorkClaim {
  cause: unknown;
  claim: DueWorkClaim;
}

export type DueWorkTransaction = typeof withSystemTransactionEffect;

export type OutboxDueWorkKind =
  | "asset_orphan_sweep"
  | "distribution"
  | "distribution_sweep"
  | "reply_reconciliation";

type DueWorkTable = "assets" | "comments" | "distributions" | "platform_accounts";

interface OutboxDueWorkDescriptor {
  aggregateType: OutboxAggregateType;
  conflictClause: string;
  constants?: readonly unknown[];
  dedupeKeyExpression: string;
  lock: string;
  ordering: string;
  payloadExpression: string;
  predicate: string;
  selection: string;
  table: DueWorkTable;
  tableAlias?: string;
  topicExpression: string;
  transitionAssignments?: string;
}

const distributionDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "distribution",
  conflictClause: outboxConflictClause("revive", "$3"),
  constants: [maximumDelayedDeliverySeconds],
  dedupeKeyExpression: `CASE
        WHEN due.source_status IN (
          'awaiting_provider', 'needs_reconciliation', 'processing'
        ) THEN ${outboxDedupeKeySql.distributionReconcile("due.id", "due.reconciliation_attempt_count")}
        WHEN due.source_status = 'scheduled' THEN
          concat('distribution:', due.id, ':publish')
        ELSE concat(
          'distribution:', due.id, ':automatic-retry:',
          due.attempt_count + 1
        )
      END`,
  lock: "FOR UPDATE SKIP LOCKED",
  ordering: "due_at, id",
  payloadExpression: `jsonb_build_object(
        'distribution_id', due.id,
        'version', 1
      )`,
  predicate: `(status = 'scheduled' AND scheduled_at <= now())
     OR (status = 'failed' AND failure_retryable = true
         AND next_attempt_at <= now())
     OR (status IN ('awaiting_provider', 'needs_reconciliation')
         AND next_attempt_at <= now())
     OR (status = 'processing'
         AND updated_at <= now() - ($2 * INTERVAL '1 second'))
     OR (status IN ('awaiting_provider', 'needs_reconciliation')
         AND NOT EXISTS (
           SELECT 1
             FROM outbox_events AS e
            WHERE e.org_id = distributions.org_id
              AND e.aggregate_id = distributions.id
              AND e.topic = 'distribution.reconcile.requested'
              AND (
                e.state IN ('pending', 'leased', 'failed')
                OR (e.state = 'published'
                    AND e.updated_at
                        > now() - ($3 * INTERVAL '1 second'))
              )
         ))`,
  selection: `id, org_id, status AS source_status, attempt_count,
             reconciliation_attempt_count,
             CASE WHEN status = 'scheduled' THEN scheduled_at
                  WHEN status = 'processing' THEN updated_at + ($2 * INTERVAL '1 second')
                  ELSE next_attempt_at END AS due_at`,
  table: "distributions",
  topicExpression: `CASE
      WHEN due.source_status IN (
        'awaiting_provider', 'needs_reconciliation', 'processing'
      ) THEN 'distribution.reconcile.requested'
      ELSE 'distribution.publish.requested'
    END`,
  transitionAssignments: `status = CASE
        WHEN due.source_status IN ('scheduled', 'failed') THEN 'queued'
        WHEN due.source_status = 'processing' THEN 'needs_reconciliation'
        ELSE d.status
      END,
       next_attempt_at = NULL,
       failure_code = CASE
         WHEN due.source_status IN ('scheduled', 'failed') THEN NULL
         WHEN due.source_status = 'processing' THEN 'provider_outcome_ambiguous'
         ELSE d.failure_code
       END,
       failure_retryable = CASE
         WHEN due.source_status IN ('scheduled', 'failed') THEN NULL
         WHEN due.source_status = 'processing' THEN false
         ELSE d.failure_retryable
       END,
       error_message = CASE
         WHEN due.source_status IN ('scheduled', 'failed') THEN NULL
         WHEN due.source_status = 'processing'
           THEN 'The provider outcome requires reconciliation.'
         ELSE d.error_message
       END,
       updated_at = now()`,
};

const distributionSweepDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "distribution",
  conflictClause: outboxConflictClause("nothing"),
  dedupeKeyExpression: `CASE
        WHEN due.is_overdue THEN
          concat(
            'distribution:', due.id, ':distribution.publish.requested:at:',
            floor(extract(epoch from due.scheduled_at) * 1000)::bigint::text,
            ':recovery:',
            floor(extract(epoch from now()) / 3600)::bigint::text
          )
        ELSE
          concat(
            'distribution:', due.id, ':distribution.publish.requested:at:',
            floor(extract(epoch from due.scheduled_at) * 1000)::bigint::text
          )
      END`,
  lock: "FOR UPDATE SKIP LOCKED",
  ordering: "scheduled_at, id",
  payloadExpression: `jsonb_build_object(
        'distribution_id', due.id,
        'version', 1
      )`,
  predicate: `status = 'scheduled'
     AND scheduled_at <= now() + ($3 * INTERVAL '1 second')
     AND (
       (
         scheduled_at > now() - ($2 * INTERVAL '1 second')
         AND NOT EXISTS (
           SELECT 1
             FROM outbox_events AS e
            WHERE e.org_id = distributions.org_id
              AND e.aggregate_id = distributions.id
              AND e.topic = 'distribution.publish.requested'
              AND e.dedupe_key = concat(
                'distribution:', distributions.id::text,
                ':distribution.publish.requested:at:',
                floor(extract(epoch from distributions.scheduled_at) * 1000)::bigint::text
              )
         )
       )
       OR (
         scheduled_at <= now() - ($2 * INTERVAL '1 second')
         AND NOT EXISTS (
           SELECT 1
             FROM outbox_events AS e
            WHERE e.org_id = distributions.org_id
              AND e.aggregate_id = distributions.id
              AND e.topic = 'distribution.publish.requested'
              AND e.state IN ('pending', 'leased', 'failed')
         )
       )
     )`,
  selection: `id, org_id, status AS source_status, scheduled_at,
             CASE
               WHEN scheduled_at <= now() - ($2 * INTERVAL '1 second') THEN true
               ELSE false
             END AS is_overdue`,
  table: "distributions",
  topicExpression: `'distribution.publish.requested'`,
};

const assetOrphanSweepDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "asset",
  constants: [maximumDelayedDeliverySeconds],
  conflictClause: outboxConflictClause("revive", "$2"),
  dedupeKeyExpression: `concat(
        'asset:', due.id, ':orphan:',
        floor(extract(epoch from due.orphan_delete_after) * 1000)::bigint
      )`,
  lock: "FOR UPDATE SKIP LOCKED",
  ordering: "orphan_delete_after, id",
  payloadExpression: `jsonb_build_object(
        'asset_id', due.id,
        'orphan_sweep', true,
        'version', 1
      )`,
  predicate: `status IN ('ready', 'failed')
     AND orphan_delete_after IS NOT NULL
     AND orphan_delete_after <= now()
     AND NOT EXISTS (
       SELECT 1
       FROM post_attachments AS attachment
       WHERE attachment.asset_id = assets.id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM asset_renditions AS rendition
       WHERE rendition.asset_id = assets.id
         AND rendition.status IN ('processing', 'deleting')
     )
     AND NOT EXISTS (
       SELECT 1
       FROM asset_objects AS object
       WHERE object.asset_id = assets.id
         AND object.status = 'writing'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM provider_operation_media AS media
       JOIN provider_operations AS operation ON operation.id = media.operation_id
       WHERE media.asset_id = assets.id
         AND (
           operation.status IN ('started', 'needs_reconciliation')
           OR (
             operation.media_hold_until IS NOT NULL
             AND operation.media_hold_until > now()
           )
         )
     )`,
  selection: "id, org_id, orphan_delete_after",
  table: "assets",
  topicExpression: `'asset.deletion.requested'`,
  transitionAssignments: `status = 'deleting',
       orphaned_at = NULL,
       orphan_delete_after = NULL,
       updated_at = now()`,
};

const replyReconciliationDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "comment",
  constants: [maximumReconciliationAttempts, maximumDelayedDeliverySeconds],
  conflictClause: outboxConflictClause("revive", "$3"),
  dedupeKeyExpression: outboxDedupeKeySql.commentReplyReconcile(
    "due.id::text",
    "due.reply_reconciliation_attempt_count",
  ),
  lock: "FOR UPDATE OF comment SKIP LOCKED",
  ordering: "comment.updated_at, comment.id",
  payloadExpression: `jsonb_build_object(
      'comment_id', due.id,
      'reconciliation', true
    )`,
  predicate: `comment.reply_status IN ('needs_reconciliation', 'in_progress')
    AND (
      comment.reply_lease_expires_at IS NULL
      OR comment.reply_lease_expires_at <= now()
    )
    AND comment.reply_reconciliation_attempt_count < $2`,
  selection: `comment.id, comment.org_id,
           comment.reply_reconciliation_attempt_count`,
  table: "comments",
  tableAlias: "comment",
  topicExpression: `'comment.reply.requested'`,
};

const outboxDueWorkDescriptors: Readonly<Record<OutboxDueWorkKind, OutboxDueWorkDescriptor>> = {
  asset_orphan_sweep: assetOrphanSweepDueWork,
  distribution: distributionDueWork,
  distribution_sweep: distributionSweepDueWork,
  reply_reconciliation: replyReconciliationDueWork,
};

function outboxFromClause(descriptor: OutboxDueWorkDescriptor): string {
  return `${descriptor.table}${descriptor.tableAlias ? ` AS ${descriptor.tableAlias}` : ""}`;
}

function outboxClaimStatement(descriptor: OutboxDueWorkDescriptor): string {
  const claimed = descriptor.transitionAssignments
    ? `, claimed AS (
         UPDATE ${descriptor.table} d
            SET ${descriptor.transitionAssignments}
           FROM due
           JOIN emitted ON emitted.aggregate_id = due.id
          WHERE d.id = due.id
        RETURNING d.id
       )`
    : "";
  return `WITH due AS (
         SELECT ${descriptor.selection}
           FROM ${outboxFromClause(descriptor)}
          WHERE ${descriptor.predicate}
          ORDER BY ${descriptor.ordering}
          LIMIT $1
          ${descriptor.lock}
       ), emitted AS (
         INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         SELECT due.org_id,
                ${descriptor.topicExpression},
                '${descriptor.aggregateType}',
                due.id,
                ${descriptor.dedupeKeyExpression},
                ${descriptor.payloadExpression}
           FROM due
         ${descriptor.conflictClause}
         RETURNING aggregate_id
       )${claimed}
       SELECT ${
         descriptor.transitionAssignments
           ? "(SELECT COUNT(*)::integer FROM claimed) AS claimed_count"
           : "(SELECT COUNT(*)::integer FROM emitted) AS claimed_count"
       }`;
}

export function claimDueOutboxWork(
  env: AutomationEnv,
  kind: OutboxDueWorkKind,
  bound: number,
  values: readonly unknown[] = [],
): Effect.Effect<number, AutomationJobError> {
  const descriptor = outboxDueWorkDescriptors[kind];
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(
      client.query<{ claimed_count: number }>(outboxClaimStatement(descriptor), [
        bound,
        ...values,
        ...(descriptor.constants ?? []),
      ]),
      (result) => result.rows[0]?.claimed_count ?? 0,
    ),
  ).pipe(Effect.mapError(classifyJobError));
}

interface LeaseDueWorkDescriptor {
  constants: readonly unknown[];
  join?: string;
  leaseColumns: {
    attemptCount: string;
    eventId: string;
    lastError: string;
    leaseExpiresAt: string;
    nextAttemptAt: string;
  };
  ordering: string;
  predicate: string;
  selection: string;
  table: DueWorkTable;
  tableAlias: string;
}

const platformAccountJoin = `JOIN platform_accounts AS account
           ON account.id = distribution.platform_account_id`;

function readableDistributionPredicate(platformsParameter: string): string {
  return `distribution.status = 'published'
      AND distribution.platform_post_id IS NOT NULL
      AND distribution.platform_post_id <> ''
      AND distribution.platform = ANY(${platformsParameter}::text[])
      AND account.connection_status = 'connected'
      AND (account.token_expires_at IS NULL OR account.token_expires_at > now())`;
}

function providerReadDueWork(workload: "analytics" | "comments"): LeaseDueWorkDescriptor {
  return {
    constants: [
      maximumProviderSyncAttempts,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      providerAttemptLeaseSeconds,
    ],
    join: platformAccountJoin,
    leaseColumns: {
      attemptCount: `${workload}_attempt_count`,
      eventId: `${workload}_sync_event_id`,
      lastError: `${workload}_last_error`,
      leaseExpiresAt: `${workload}_lease_expires_at`,
      nextAttemptAt: `${workload}_next_sync_at`,
    },
    ordering: `distribution.${workload}_next_sync_at, distribution.id`,
    predicate: `${readableDistributionPredicate("$2")}
      AND distribution.${workload}_attempt_count < $3
      AND distribution.${workload}_next_sync_at <= now() + ($5 * INTERVAL '1 second')
      AND (
        distribution.${workload}_next_sync_at <= now() - ($4 * INTERVAL '1 second')
        OR distribution.${workload}_sync_event_id IS NULL
      )
      AND (
        distribution.${workload}_lease_expires_at IS NULL
        OR distribution.${workload}_lease_expires_at <= now()
      )`,
    selection: `distribution.id, distribution.${workload}_next_sync_at AS next_due_at`,
    table: "distributions",
    tableAlias: "distribution",
  };
}

const providerSyncDueWorkDescriptors: Readonly<
  Record<ProviderSyncWorkload, LeaseDueWorkDescriptor>
> = {
  analytics: providerReadDueWork("analytics"),
  comments: providerReadDueWork("comments"),
  token_refresh: {
    constants: [
      maximumProviderSyncAttempts,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      providerAttemptLeaseSeconds,
    ],
    leaseColumns: {
      attemptCount: "token_refresh_attempt_count",
      eventId: "token_refresh_event_id",
      lastError: "token_refresh_last_error",
      leaseExpiresAt: "token_refresh_lease_expires_at",
      nextAttemptAt: "token_refresh_next_attempt_at",
    },
    ordering: "account.token_refresh_next_attempt_at, account.id",
    predicate: `account.platform = ANY($2::text[])
      AND account.connection_status IN ('connected', 'expiring')
      AND account.token_expires_at IS NOT NULL
      AND account.token_refresh_attempt_count < $3
      AND account.token_refresh_next_attempt_at <= now() + ($5 * INTERVAL '1 second')
      AND (
        account.token_refresh_next_attempt_at <= now() - ($4 * INTERVAL '1 second')
        OR account.token_refresh_event_id IS NULL
      )
      AND (
        account.token_refresh_lease_expires_at IS NULL
        OR account.token_refresh_lease_expires_at <= now()
      )`,
    selection: "account.id, account.token_refresh_next_attempt_at AS next_due_at",
    table: "platform_accounts",
    tableAlias: "account",
  },
};

function providerSyncClaimStatement(descriptor: LeaseDueWorkDescriptor): string {
  const columns = descriptor.leaseColumns;
  const alias = descriptor.tableAlias;
  const leaseParamIndex = 2 + descriptor.constants.length;
  return `WITH candidates AS (
     SELECT ${descriptor.selection}
     FROM ${descriptor.table} AS ${alias}
     ${descriptor.join ?? ""}
     WHERE ${descriptor.predicate}
     ORDER BY ${descriptor.ordering}
     LIMIT $1
     FOR UPDATE OF ${alias} SKIP LOCKED
   )
   UPDATE ${descriptor.table} AS ${alias}
   SET ${columns.eventId} = gen_random_uuid(),
       ${columns.leaseExpiresAt} = now() + ($${leaseParamIndex} * INTERVAL '1 second'),
       ${columns.attemptCount} = ${alias}.${columns.attemptCount} + 1,
       ${columns.lastError} = NULL,
       updated_at = now()
   FROM candidates
   WHERE ${alias}.id = candidates.id
   RETURNING ${alias}.id AS target_id,
             ${alias}.${columns.eventId}::text AS event_id,
             ${alias}.${columns.nextAttemptAt} AS next_due_at`;
}

const onDemandCommentsClaimStatement = `WITH candidates AS (
     SELECT distribution.id
     FROM distributions AS distribution
     ${platformAccountJoin}
     WHERE distribution.org_id = $2::uuid
       AND ($3::uuid IS NULL OR distribution.id = $3::uuid)
       AND ${readableDistributionPredicate("$4")}
       AND (
         (distribution.comments_next_sync_at IS NULL AND distribution.comments_sync_event_id IS NULL)
         OR (NOT $8::boolean AND NOT distribution.comments_sync_on_demand)
       )
       AND distribution.comments_attempt_count < $5
       AND (
         distribution.comments_last_synced_at IS NULL
         OR distribution.comments_last_synced_at <= now() - ($6 * INTERVAL '1 second')
       )
       AND (
         distribution.comments_lease_expires_at IS NULL
         OR distribution.comments_lease_expires_at <= now()
       )
     ORDER BY distribution.comments_last_synced_at ASC NULLS FIRST, distribution.id
     LIMIT $1
     FOR UPDATE OF distribution SKIP LOCKED
   )
   UPDATE distributions AS distribution
   SET comments_sync_event_id = gen_random_uuid(),
       comments_sync_on_demand = true,
       comments_next_sync_at = NULL,
       comments_lease_expires_at = now() + ($7 * INTERVAL '1 second'),
       comments_attempt_count = distribution.comments_attempt_count + 1,
       comments_last_error = NULL,
       updated_at = now()
   FROM candidates
   WHERE distribution.id = candidates.id
   RETURNING distribution.id AS target_id,
             distribution.comments_sync_event_id::text AS event_id`;

function providerSyncReleaseStatement(descriptor: LeaseDueWorkDescriptor): string {
  const columns = descriptor.leaseColumns;
  const alias = descriptor.tableAlias;
  return `UPDATE ${descriptor.table} AS ${alias}
   SET ${columns.eventId} = NULL,
       ${columns.leaseExpiresAt} = NULL,
       ${columns.nextAttemptAt} = now() + INTERVAL '1 minute',
       ${columns.lastError} = failed.last_error,
       updated_at = now()
   FROM unnest(
     $1::uuid[],
     $2::uuid[],
     $3::text[]
   ) AS failed(target_id, event_id, last_error)
   WHERE ${alias}.id = failed.target_id
     AND ${alias}.${columns.eventId} = failed.event_id`;
}

export function sweepDueProviderSyncWork(
  env: AutomationEnv,
  workload: ProviderSyncWorkload,
  bound: number,
  platforms: readonly Platform[],
  transaction: DueWorkTransaction,
): Effect.Effect<DueWorkClaim[], AutomationJobError> {
  if (platforms.length === 0) return Effect.succeed([]);
  const base = providerSyncDueWorkDescriptors[workload];
  const descriptor =
    workload === "comments" && !recurringCommentsEnabled(env)
      ? { ...base, predicate: `${base.predicate} AND distribution.comments_sync_on_demand` }
      : base;
  return transaction(env, (client) =>
    Effect.map(
      client.query<DueWorkClaim>(providerSyncClaimStatement(descriptor), [
        bound,
        platforms,
        ...descriptor.constants,
      ]),
      (result) => result.rows,
    ),
  ).pipe(Effect.mapError(classifyJobError));
}

export function claimOnDemandCommentsWork(
  env: AutomationEnv,
  input: {
    bound: number;
    distributionId: string | null;
    organizationId: string;
    platforms: readonly Platform[];
  },
  transaction: DueWorkTransaction,
): Effect.Effect<DueWorkClaim[], AutomationJobError> {
  if (input.platforms.length === 0) return Effect.succeed([]);
  return transaction(env, (client) =>
    Effect.map(
      client.query<DueWorkClaim>(onDemandCommentsClaimStatement, [
        input.bound,
        input.organizationId,
        input.distributionId,
        input.platforms,
        maximumProviderSyncAttempts,
        onDemandCommentsIntervalSeconds,
        providerAttemptLeaseSeconds,
        recurringCommentsEnabled(env),
      ]),
      (result) => result.rows,
    ),
  ).pipe(Effect.mapError(classifyJobError));
}

export function releaseDueProviderSyncClaims(
  env: AutomationEnv,
  workload: ProviderSyncWorkload,
  failures: readonly FailedDueWorkClaim[],
  transaction: DueWorkTransaction,
): Effect.Effect<void, AutomationJobError> {
  if (failures.length === 0) return Effect.void;
  const descriptor = providerSyncDueWorkDescriptors[workload];
  return transaction(env, (client) =>
    client.query(providerSyncReleaseStatement(descriptor), [
      failures.map(({ claim }) => claim.target_id),
      failures.map(({ claim }) => claim.event_id),
      failures.map(({ cause }) => safeErrorMessage(cause, "queue send failed")),
    ]),
  ).pipe(Effect.mapError(classifyJobError), Effect.asVoid);
}
