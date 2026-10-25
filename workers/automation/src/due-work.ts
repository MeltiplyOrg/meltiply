import { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "./database";
import { type AutomationJobError, classifyJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { safeErrorMessage } from "./errors";
import type { ProviderSyncWorkload } from "./messages";
export { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds };

/**
 * The one bounded, skip-locked claim protocol for Due work.
 *
 * Every scheduled scan claims a bounded page of due rows with
 * `FOR UPDATE SKIP LOCKED` and then either emits Outbox events
 * (`distribution`, `reply_reconciliation`) or mints a short attempt lease for
 * direct Queue delivery (`analytics`, `comments`, `token_refresh`). The kinds
 * differ only by the closed descriptor sets below: table, due/status
 * predicate, ordering, bound, topic, and dedupe/payload shape are all
 * descriptor data. Table and column identifiers are interpolated exclusively
 * inside this module from those descriptors — callers pass bounds, numbers,
 * platform lists, and transactions, never identifiers or SQL fragments.
 *
 * Statement parameters are laid out uniformly so the claim bound is always
 * `$1`: `$2…` are the per-call values documented on each entry point,
 * followed by descriptor-owned constants.
 */

export const distributionProcessingGraceSeconds = 300;

// Shortest consumer visibility timeout among the Queues that deliver provider
// sync messages; analytics, comments, and token-refresh all use it in
// infra/cloudflare/main.tf. The attempt lease below is derived from it so it can
// never silently outlive delivery: any redelivery arrives after its claim's
// lease has lapsed and fails the event-key guard instead of reprocessing the
// work, which matters most for token refresh because two Platforms rotate the
// refresh token on use. The Queues Terraform module enforces the same inequality
// from the infrastructure side, in milliseconds
// (`local.provider_attempt_lease_ms` in infra/cloudflare/modules/queues/main.tf).
export const minimumProviderVisibilityTimeoutSeconds = 120;
export const providerAttemptLeaseSeconds = Math.floor(minimumProviderVisibilityTimeoutSeconds / 2);

/** Attempt ceiling shared by the provider-sync claims and their retry backoff. */
export const maximumProviderSyncAttempts = 20;
/** Attempt ceiling shared by the reconciliation claim and the reply path. */
export const maximumReconciliationAttempts = 10;

/**
 * Bounds on the poll loop an `awaiting_provider` Distribution runs while its
 * Provider is still assembling the publication. Polls are spaced on a fixed
 * interval instead of an exponential ladder because the wait is the Provider's
 * own processing time, not a failure to back off from, and they are counted in
 * `distributions.provider_poll_attempts` so the budget stays separate from
 * `reconciliation_attempt_count`. Exhausting the budget (about thirty minutes)
 * hands the row to `needs_reconciliation` instead of polling forever.
 */
export const maximumProviderPollAttempts = 90;
export const providerPollIntervalSeconds = 20;

/**
 * Dedupe identity of a reply reconciliation command, in one place because both
 * the scheduled claim and the reply path emit it. The attempt number is part of
 * the identity, so a re-delivery of the current message cannot arm the same
 * attempt twice while a genuinely later attempt still gets its own command.
 * `idExpression` and `attemptExpression` are SQL fragments owned by the caller
 * inside this Worker — never caller-supplied identifiers.
 *
 * @param idExpression - SQL expression representing the comment identifier.
 * @param attemptExpression - SQL expression representing the reconciliation attempt count.
 * @returns SQL concatenation expression producing the dedupe key.
 */
export function reconciliationDedupeKey(idExpression: string, attemptExpression: string): string {
  return `concat('comment-reply-reconcile:', ${idExpression}, ':', (${attemptExpression} + 1)::text)`;
}

/**
 * Bounds on the demand-driven Comment fetch armed by an Inbox open, past
 * `demandDrivenCommentsAgeSeconds`. Both are trust-boundary guards: a creator
 * controls when the Inbox is opened, so one open may arm at most
 * `onDemandCommentsBound` Distributions, and a single Distribution may not be
 * fetched again until `onDemandCommentsIntervalSeconds` have passed since its
 * last recorded Comment sync. Claims are ordered least-recently-synced first so
 * repeated opens rotate through the whole backlog instead of re-arming one page.
 */
export const onDemandCommentsBound = 10;
export const onDemandCommentsIntervalSeconds = 900;

/** A claimed unit of Due work awaiting Queue delivery. */
export interface DueWorkClaim extends Record<string, unknown> {
  event_id: string;
  next_due_at?: Date | string | null;
  target_id: string;
}

export interface FailedDueWorkClaim {
  cause: unknown;
  claim: DueWorkClaim;
}

/**
 * Transaction runner for Due work claims: the Effect-native system transaction
 * contract, so claim/release statements compose inside the caller's program.
 */
export type DueWorkTransaction = typeof withSystemTransactionEffect;

/** Due work whose claim emits Outbox events in the claim statement. */
export type OutboxDueWorkKind =
  | "asset_orphan_sweep"
  | "distribution"
  | "distribution_sweep"
  | "reply_reconciliation";

/**
 * Tables a Due work statement may touch. Every table identifier in every
 * generated statement is read from this record; no other identifier source
 * exists.
 */
const dueWorkTables = {
  assets: "assets",
  comments: "comments",
  distributions: "distributions",
  platform_accounts: "platform_accounts",
} as const;

type DueWorkTable = keyof typeof dueWorkTables;

interface OutboxDueWorkDescriptor {
  aggregateType: "asset" | "comment" | "distribution";
  /** Conflict action appended after ON CONFLICT <target> (e.g. DO NOTHING or a DO UPDATE revive clause). */
  conflictAction: string;
  /** Conflict target appended after ON CONFLICT (empty means any conflict). */
  conflictTarget: string;
  /** Descriptor-owned constants bound after `$1` and any caller values. */
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
  /** Optional transition applied to rows whose event was actually inserted. */
  transitionAssignments?: string;
}

/**
 * Revive clause for a dedupe-key conflict against an outbox event that can no
 * longer deliver. A 'dead' event exhausted its relay attempts and a 'published'
 * event older than the delayed-delivery horizon can no longer have a Queue
 * message in flight, so the claim resurrects the row as 'pending' with a fresh
 * attempt budget instead of stranding the aggregate behind a dedupe key that
 * blocks every re-arm (#256). Conflicts with live events fail the WHERE clause
 * and emit nothing, preserving exactly-once arming.
 *
 * @param horizonParameter - Placeholder index of the delayed-delivery horizon
   in seconds for this descriptor's parameter layout.
 @returns The `DO UPDATE` clause, with the horizon placeholder substituted.
 */
function reviveLostOutboxEvent(horizonParameter: string): string {
  return `DO UPDATE
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

const distributionDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "distribution",
  conflictAction: reviveLostOutboxEvent("$3"),
  conflictTarget: " (org_id, topic, dedupe_key)",
  constants: [maximumDelayedDeliverySeconds],
  dedupeKeyExpression: `CASE
        WHEN due.source_status IN (
          'awaiting_provider', 'needs_reconciliation', 'processing'
        ) THEN concat(
          'distribution:', due.id, ':reconcile:',
          due.reconciliation_attempt_count + 1
        )
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
  // $2 is the stalled-processing grace period in seconds (#138). A stalled
  // 'processing' row means the worker was lost after the publish intent was
  // committed, so the provider side effect is unknown: the claim must arm
  // reconciliation, never a second publish (#256).
  // $3 is the delayed-delivery horizon bounding 'published' event staleness.
  // The NOT EXISTS branch is the durable fallback for a lost reconcile
  // trigger: the claim clears next_attempt_at once an event is armed, so a
  // reconcile-eligible row whose armed event can no longer deliver (dead, or
  // published past the horizon with its Queue message gone) stays claimable
  // and the conflict revive above re-arms delivery (#256).
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
  conflictAction: "DO NOTHING",
  conflictTarget: "",
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
  // $2 is the overdue recovery grace period in seconds (#143).
  // $3 is the maximum delayed delivery horizon in seconds.
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

/**
 * Ownership-aware reclamation of completed uploads and detached attachments
 * whose seven-day orphan deadline has elapsed (issue #284 decisions 11-13).
 *
 * Candidates are `ready` and `failed` Assets only: a saved draft's failed
 * attachment keeps its error visible, while an unretained failure ages out
 * exactly like retained-ready media. Eligibility additionally requires the
 * absence of every hold that could still need the bytes: retained Post
 * attachments, in-flight processing or promotion (an unfinished rendition row
 * or a `writing` object reservation), and any Provider attempt that is
 * started, ambiguous, awaiting reconciliation, or inside its media hold
 * window. An ambiguous provider outcome is never treated as ordinary failure,
 * so its media stays protected.
 *
 * The claim writes the `deleting` transition and the Outbox event in one
 * statement over `FOR UPDATE SKIP LOCKED` rows of the partial
 * `idx_assets_orphan_due` index, so the delete claim and its event cannot
 * diverge: a rolled-back claim leaves the Asset claimable again, and the
 * `assets_guard_delete_claim` trigger refuses a claim that raced an attachment
 * or a Provider hold. The dedupe key carries the deadline in epoch
 * milliseconds, so a re-armed grace period is a genuinely new event while a
 * repeated sweep of the same deadline is not.
 *
 * `FOR UPDATE SKIP LOCKED` also closes the attach-versus-delete race without
 * relying on the predicate alone: the `post_attachments` insert trigger takes
 * `FOR UPDATE` on the same Asset row, so an attachment created concurrently
 * blocks behind this claim and then observes `status = 'deleting'` and refuses
 * itself. The delete-claim trigger is therefore a backstop rather than a
 * per-batch abort risk.
 */
const assetOrphanSweepDueWork: OutboxDueWorkDescriptor = {
  aggregateType: "asset",
  // $2 is the delayed-delivery horizon bounding 'published' event staleness in
  // the revive clause: an armed deletion event that died before delivery must
  // be re-armed, not stranded behind its own dedupe key.
  constants: [maximumDelayedDeliverySeconds],
  conflictAction: reviveLostOutboxEvent("$2"),
  conflictTarget: " (org_id, topic, dedupe_key)",
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
  // $2 is the reconciliation attempt cap.
  // $3 is the delayed-delivery horizon bounding 'published' event staleness in
  // the revive clause; a lost reply reconcile trigger is recovered the same
  // way as a lost distribution reconcile trigger (#256).
  constants: [maximumReconciliationAttempts, maximumDelayedDeliverySeconds],
  conflictAction: reviveLostOutboxEvent("$3"),
  conflictTarget: " (org_id, topic, dedupe_key)",
  dedupeKeyExpression: reconciliationDedupeKey(
    "due.id::text",
    "due.reply_reconciliation_attempt_count",
  ),
  lock: "FOR UPDATE OF comment SKIP LOCKED",
  ordering: "comment.updated_at, comment.id",
  payloadExpression: `jsonb_build_object(
      'comment_id', due.id,
      'reconciliation', true
    )`,
  // $2 is the reconciliation attempt cap.
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

/**
 * Resolves the SQL FROM table reference with alias for an outbox due work descriptor.
 *
 * @param descriptor - Outbox due work descriptor.
 * @returns Formatted table identifier with optional alias.
 */
function outboxFromClause(descriptor: OutboxDueWorkDescriptor): string {
  return `${dueWorkTables[descriptor.table]}${
    descriptor.tableAlias ? ` AS ${descriptor.tableAlias}` : ""
  }`;
}

/**
 * Constructs the atomic CTE query to claim due work rows and insert outbox events.
 *
 * Scans candidate rows with `FOR UPDATE SKIP LOCKED`, emits rows to `outbox_events`
 * under the descriptor's ON CONFLICT action (DO NOTHING, or a DO UPDATE that
 * revives events which can no longer deliver), and optionally transitions
 * source table status in the same statement.
 *
 * @param descriptor - Outbox due work descriptor.
 * @returns Complete parameterized SQL statement.
 */
function outboxClaimStatement(descriptor: OutboxDueWorkDescriptor): string {
  const claimed = descriptor.transitionAssignments
    ? `, claimed AS (
         UPDATE ${dueWorkTables[descriptor.table]} d
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
         ON CONFLICT${descriptor.conflictTarget} ${descriptor.conflictAction}
         RETURNING aggregate_id
       )${claimed}
       SELECT ${
         descriptor.transitionAssignments
           ? "(SELECT COUNT(*)::integer FROM claimed) AS claimed_count,\n              (SELECT COUNT(*)::integer FROM emitted) AS inserted_count"
           : "(SELECT COUNT(*)::integer FROM emitted) AS claimed_count"
       }`;
}

/**
 * Claims a bounded page of due rows and emits their Outbox events in one set-based statement.
 *
 * Returns the number of events actually armed — inserted, or revived from a
 * dead/stale-published state by the descriptor's conflict action (for kinds
 * with a source transition: the number of rows transitioned).
 *
 * @param env - Automation worker environment bindings.
 * @param kind - Outbox due work kind to process (`asset_orphan_sweep`,
   `distribution`, `distribution_sweep`, or `reply_reconciliation`).
 * @param bound - Maximum number of rows to claim ($1).
 * @param values - Additional parameters binding $2 onward (e.g. grace periods).
 * @returns Effect producing the number of claimed or transitioned records; the
 *   transaction's throws are classified onto the AutomationJobError channel.
 */
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
  /** Descriptor constants bound after the caller values ($3 onward). */
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

/**
 * Eligibility a published Distribution must satisfy before any Provider read is
 * attempted against it. Shared by the scheduled analytics/comments claim and the
 * demand-driven Comment claim so both agree on what is readable.
 *
 * @param platformsParameter - SQL parameter expression binding the eligible platform array (e.g. '$2').
 * @returns SQL boolean predicate fragment.
 */
function readableDistributionPredicate(platformsParameter: string): string {
  return `distribution.status = 'published'
      AND distribution.platform_post_id IS NOT NULL
      AND distribution.platform_post_id <> ''
      AND distribution.platform = ANY(${platformsParameter}::text[])
      AND account.connection_status = 'connected'
      AND (account.token_expires_at IS NULL OR account.token_expires_at > now())`;
}

/**
 * Constructs a lease descriptor for periodic provider read workloads (analytics or comments).
 *
 * Binds constants for max attempts, overdue grace, delayed delivery horizon, and attempt lease length.
 *
 * @param workload - Target workload ('analytics' or 'comments').
 * @returns Lease due work descriptor.
 */
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
    // $2 is the eligible platform list, $3 attempt cap, $4 overdue grace,
    // $5 maximum delayed delivery horizon, $6 attempt lease.
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

/**
 * Generates the SQL statement for claiming candidate provider sync records and locking leases.
 *
 * Selects candidate rows using `FOR UPDATE SKIP LOCKED`, generates a fresh UUID event ID,
 * sets the lease expiration relative to the visibility timeout, and increments the attempt count.
 *
 * @param descriptor - Lease due work descriptor specifying tables, predicates, and columns.
 * @returns Parameterized SQL claim and update statement.
 */
function providerSyncClaimStatement(descriptor: LeaseDueWorkDescriptor): string {
  const columns = descriptor.leaseColumns;
  const alias = descriptor.tableAlias;
  const leaseParamIndex = 2 + descriptor.constants.length;
  return `WITH candidates AS (
     SELECT ${descriptor.selection}
     FROM ${dueWorkTables[descriptor.table]} AS ${alias}
     ${descriptor.join ?? ""}
     WHERE ${descriptor.predicate}
     ORDER BY ${descriptor.ordering}
     LIMIT $1
     FOR UPDATE OF ${alias} SKIP LOCKED
   )
   UPDATE ${dueWorkTables[descriptor.table]} AS ${alias}
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

/**
 * Demand-driven Comment claim: bounded by `$1`, scoped to one organization, and
 * rate limited per Distribution against `comments_last_synced_at`, so repeated
 * Inbox opens cannot force repeated Provider calls. Least-recently-synced first
 * so successive opens rotate through the backlog.
 */
const onDemandCommentsClaimStatement = `WITH candidates AS (
     SELECT distribution.id
     FROM ${dueWorkTables.distributions} AS distribution
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
   UPDATE ${dueWorkTables.distributions} AS distribution
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

/**
 * Generates the SQL statement to release claimed provider sync leases when Queue delivery fails.
 *
 * Uses unnested arrays of target IDs, event IDs, and error messages to clear active leases,
 * record the last error, and schedule the next attempt in one minute.
 *
 * @param descriptor - Lease due work descriptor for the target workload.
 * @returns Parameterized SQL update statement.
 */
function providerSyncReleaseStatement(descriptor: LeaseDueWorkDescriptor): string {
  const columns = descriptor.leaseColumns;
  const alias = descriptor.tableAlias;
  return `UPDATE ${dueWorkTables[descriptor.table]} AS ${alias}
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

/**
 * Sweeps provider sync work whose trigger was never armed (beyond the delayed
 * delivery horizon when it was recorded) or was lost (overdue past the grace
 * period), by minting a fresh attempt lease and event identifier and returning
 * the identifiers to deliver on the workload's Queue.
 *
 * @param env - Automation worker environment bindings.
 * @param workload - Provider sync workload kind ('analytics', 'comments', or 'token_refresh').
 * @param bound - Maximum number of rows to claim.
 * @param platforms - List of eligible platforms to sweep.
 * @param transaction - Transaction runner for database operations.
 * @returns Effect producing the claimed work items with targets and event IDs;
 *   transaction throws are classified onto the AutomationJobError channel.
 */
export function sweepDueProviderSyncWork(
  env: AutomationEnv,
  workload: ProviderSyncWorkload,
  bound: number,
  platforms: readonly Platform[],
  transaction: DueWorkTransaction,
): Effect.Effect<DueWorkClaim[], AutomationJobError> {
  if (platforms.length === 0) return Effect.succeed([]);
  const base = providerSyncDueWorkDescriptors[workload];
  // Deployment policy never discards authorized demand continuations/retries.
  const descriptor =
    workload === "comments" && env.RECURRING_COMMENTS_ENABLED !== "true"
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

/**
 * Claims a bounded page of Distributions for a demand-driven Comment fetch.
 *
 * Used for Distributions the cadence ladder no longer schedules (their
 * `comments_next_sync_at` is NULL), so an Inbox open is the only trigger fetching their Comments.
 *
 * @param env - Automation worker environment bindings.
 * @param input - Claim parameters including bound, distributionId filter, organizationId, and platforms.
 * @param transaction - Transaction runner for database operations.
 * @returns Effect producing the claimed work items ready for immediate Queue
 *   dispatch; transaction throws are classified onto the AutomationJobError channel.
 */
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
        env.RECURRING_COMMENTS_ENABLED === "true",
      ]),
      (result) => result.rows,
    ),
  ).pipe(Effect.mapError(classifyJobError));
}

/**
 * Returns leases whose Queue delivery failed to their next attempt in one durable update.
 *
 * @param env - Automation worker environment bindings.
 * @param workload - Provider sync workload kind.
 * @param failures - Array of failed claims and error causes.
 * @param transaction - Transaction runner for database operations.
 * @returns Effect completing once leases are released; transaction throws are
 *   classified onto the AutomationJobError channel.
 */
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
