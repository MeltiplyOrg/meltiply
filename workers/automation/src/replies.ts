import { Effect } from "effect";
import { claimJobLease, finishJobLease, jobLeaseOutcome } from "./job-lease";
import type { DatabaseError, Platform } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  cachedProviderRegistryFromEnvironment,
  createProviderServiceLive,
  type ProviderAdapterError,
  type ProviderFailure,
  type ProviderOperationResult,
  type ProviderRegistry,
} from "@meltiply/providers";

import { withSystemTransactionEffect } from "./database";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import { maximumReconciliationAttempts, reconciliationDedupeKey } from "./due-work";
import {
  executeProviderLookupEffect,
  executeProviderReplyEffect,
  type DistributionLookupExecution,
  type ProviderReplyExecution,
} from "./distribution-provider";
import type { AutomationEnv } from "./env";
import { isOutboxMessage, type OutboxMessage } from "./messages";
import { decryptStoredToken } from "./provider-credentials";

type ReplyMessage = OutboxMessage;
/**
 * Transaction runner for reply processing: the Effect-native system
 * transaction contract, so lease/state statements compose inside the
 * caller's program.
 */
type SystemTransaction = typeof withSystemTransactionEffect;

interface ReplySelection extends Record<string, unknown> {
  access_token: string | null;
  comment_id: string;
  connection_status: string | null;
  distribution_id: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string | null;
  platform_comment_id: string;
  provider_operation_id: string | null;
  provider_post_id: string | null;
  reply_attempt_count: number;
  reply_reconciliation_attempt_count: number;
  replied: boolean;
  reply_status: string;
  reply_text: string;
  token_expires_at: Date | string | null;
}

interface ReplyRow extends ReplySelection {
  operation_database_id: string;
}

type ReplyPreparation =
  | { outcome: "deferred" }
  | { outcome: "ready"; phase: "lookup" | "send"; row: ReplyRow }
  | { outcome: "skipped" };

export interface ReplyProcessingDependencies {
  decryptToken?: (storedToken: string) => Promise<string>;
  now?: () => Date;
  providerRegistry?: ProviderRegistry;
  transaction?: SystemTransaction;
}

export class RetryableReplyError extends Error {
  /**
   * Constructs a retryable reply error to trigger message redelivery.
   *
   * @param message - Error description detailing why the reply or reconciliation should be retried.
   */
  constructor(message = "reply delivery should be retried") {
    super(message);
    this.name = "RetryableReplyError";
  }
}

const leaseSeconds = 300;

/**
 * Arms the next reconciliation attempt as a delayed Outbox command.
 *
 * The dedupe key carries the attempt number so re-delivery of the current message
 * cannot arm the same attempt twice, and the relay reads `delay_seconds` to schedule
 * delivery at the cadence instead of relying on an immediate poll.
 *
 * @param client - Transactional database client.
 * @param row - Target comment selection fields including comment ID and attempt count.
 * @param delaySeconds - Delay in seconds before the reconciliation event should be dispatched.
 */
function emitDelayedReconciliation(
  client: EffectTransactionClient,
  row: Pick<ReplyRow, "comment_id" | "org_id" | "reply_reconciliation_attempt_count">,
  delaySeconds: number,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `INSERT INTO outbox_events
       (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
     VALUES
       ($1::uuid, 'comment.reply.requested', 'comment', $2::uuid,
        ${reconciliationDedupeKey("$2::text", "$3::int")},
        jsonb_build_object(
          'comment_id', $2::uuid,
          'reconciliation', true,
          'delay_seconds', $4::int
        ))
     ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING`,
      [row.org_id, row.comment_id, row.reply_reconciliation_attempt_count, delaySeconds],
    )
    .pipe(Effect.asVoid);
}

/**
 * Calculates the exponential backoff delay in seconds for comment reply reconciliation.
 *
 * Delays double with each attempt (60s, 120s, 240s, ...) up to a maximum cap of 3,600s (1 hour).
 *
 * @param attemptCount - Current 1-based reconciliation attempt count.
 * @returns Calculated delay interval in seconds.
 */
export function replyReconciliationCadenceSeconds(attemptCount: number): number {
  return Math.min(3_600, 60 * 2 ** Math.max(0, attemptCount - 1));
}

/**
 * Generates the distributed lease event key for an outbox message.
 *
 * @param message - Outbox message containing the event ID.
 * @returns Formatted event key string.
 */
function eventKey(message: ReplyMessage): string {
  return `outbox:${message.event_id}`;
}

/**
 * Generates an idempotent provider operation key for a comment reply action.
 *
 * @param commentId - UUID of the comment being replied to.
 * @returns Formatted idempotency key string.
 */
function idempotencyKey(commentId: string): string {
  return `reply:${commentId}`;
}

/**
 * Selects and row-locks a comment record and its distribution account details for processing.
 *
 * @param client - Transactional database client.
 * @param message - Outbox message identifying the comment and organization.
 * @returns Locked comment selection row, or undefined if not found.
 */
function selectReply(
  client: EffectTransactionClient,
  message: ReplyMessage,
): Effect.Effect<ReplySelection | undefined, DatabaseError> {
  return Effect.map(
    client.query<ReplySelection>(
      `SELECT comment.id AS comment_id, comment.org_id,
            comment.distribution_id, comment.platform_comment_id,
            comment.replied, comment.reply_status,
            COALESCE(comment.reply_text, '') AS reply_text,
            comment.reply_attempt_count,
            comment.reply_reconciliation_attempt_count,
            distribution.platform, account.access_token,
            account.connection_status, account.token_expires_at,
            account.platform_user_id,
            comment.reply_provider_operation_id AS provider_operation_id,
            comment.reply_provider_post_id AS provider_post_id
       FROM comments AS comment
       JOIN distributions AS distribution
         ON distribution.id = comment.distribution_id
       LEFT JOIN platform_accounts AS account
         ON account.id = distribution.platform_account_id
      WHERE comment.id = $1 AND comment.org_id = $2
      FOR UPDATE OF comment`,
      [message.aggregate_id, message.organization_id],
    ),
    (result) => result.rows[0],
  );
}

/**
 * Flags a comment and its provider operation as requiring manual reconciliation.
 *
 * Used when maximum automated reconciliation attempts are exceeded or required provider
 * identifiers are missing, releasing the job lease as succeeded to avoid stuck retries.
 *
 * @param client - Transactional database client.
 * @param row - Comment row selection being updated.
 * @param operationId - Database ID of the provider operation record.
 * @param message - Outbox message being completed.
 */
function markManualReconciliation(
  client: EffectTransactionClient,
  row: ReplySelection,
  operationId: string,
  message: ReplyMessage,
): Effect.Effect<void, DatabaseError> {
  const error = "A prior reply may have succeeded without durable provider evidence.";
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE provider_operations
     SET status = 'needs_reconciliation', error_class = 'ambiguous',
         last_error = $2, completed_at = NULL, updated_at = now()
     WHERE id = $1`,
      [operationId, error],
    );
    yield* client.query(
      `UPDATE comments
     SET reply_status = 'needs_reconciliation', reply_error = $2,
         reply_lease_expires_at = NULL, updated_at = now()
     WHERE id = $1`,
      [row.comment_id, error],
    );
    yield* finishJobLease(client, eventKey(message), "succeeded");
  });
}

/**
 * Claims a distributed job lease and prepares a comment reply for provider execution.
 *
 * Acquires a 300-second lease in `async_job_events`, inspects existing provider operations,
 * detects prior successes or in-progress ambiguous states requiring reconciliation lookup,
 * and increments attempt counters while placing the record in progress.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message carrying reply request context.
 * @param transaction - Database transaction runner.
 * @returns Preparation result indicating whether work is deferred, skipped, or ready for lookup/send.
 */
function prepare(
  env: AutomationEnv,
  message: ReplyMessage,
  transaction: SystemTransaction,
): Effect.Effect<ReplyPreparation, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      if (
        !(yield* claimJobLease(client, {
          aggregateId: message.aggregate_id,
          aggregateType: "comment",
          eventKey: eventKey(message),
          jobType: message.topic,
          leaseSeconds,
          orgId: message.organization_id,
        }))
      ) {
        return (yield* jobLeaseOutcome(client, eventKey(message))) === "processing"
          ? { outcome: "deferred" }
          : { outcome: "skipped" };
      }

      const row = yield* selectReply(client, message);
      if (
        !row ||
        row.replied ||
        !["queued", "in_progress", "needs_reconciliation"].includes(row.reply_status)
      ) {
        yield* finishJobLease(client, eventKey(message), "skipped");
        return { outcome: "skipped" };
      }

      const key = idempotencyKey(row.comment_id);
      const operation = yield* client.query<{
        attempt_count: number;
        id: string;
        provider_operation_id: string | null;
        provider_post_id: string | null;
        status: string;
      }>(
        `SELECT id, status, attempt_count, provider_operation_id,
              provider_post_id
         FROM provider_operations
        WHERE distribution_id = $1 AND operation = 'reply'
          AND idempotency_key = $2
        FOR UPDATE`,
        [row.distribution_id, key],
      );
      const existing = operation.rows[0];
      if (existing?.status === "succeeded") {
        yield* client.query(
          `UPDATE comments
         SET replied = true, reply_status = 'succeeded', reply_error = NULL,
             reply_provider_operation_id = $2,
             reply_provider_post_id = $3,
             reply_lease_expires_at = NULL,
             reply_attempted_at = COALESCE(reply_attempted_at, now()),
             updated_at = now()
         WHERE id = $1`,
          [row.comment_id, existing.provider_operation_id, existing.provider_post_id],
        );
        yield* finishJobLease(client, eventKey(message), "succeeded");
        return { outcome: "skipped" };
      }

      if (existing && ["started", "needs_reconciliation"].includes(existing.status)) {
        const providerOperationId = existing.provider_operation_id ?? row.provider_operation_id;
        const providerPostId = existing.provider_post_id ?? row.provider_post_id;
        if (!providerOperationId && !providerPostId) {
          yield* markManualReconciliation(client, row, existing.id, message);
          return { outcome: "skipped" };
        }
        if (row.reply_reconciliation_attempt_count >= maximumReconciliationAttempts) {
          yield* markManualReconciliation(client, row, existing.id, message);
          return { outcome: "skipped" };
        }
        // The claim below owns the increment, so the claimed attempt number is
        // captured before the write: deriving it from the row afterwards would
        // count the claim twice when the selected row already reflects it.
        const claimedAttempt = row.reply_reconciliation_attempt_count + 1;
        yield* client.query(
          `UPDATE provider_operations
         SET status = 'needs_reconciliation', error_class = 'ambiguous',
             completed_at = NULL, updated_at = now()
         WHERE id = $1`,
          [existing.id],
        );
        yield* client.query(
          `UPDATE comments
         SET reply_status = 'needs_reconciliation', reply_error = NULL,
             reply_provider_operation_id = $2,
             reply_provider_post_id = $3,
             reply_reconciliation_attempt_count =
               reply_reconciliation_attempt_count + 1,
             reply_lease_expires_at = now() + ($4 * INTERVAL '1 second'),
             updated_at = now()
         WHERE id = $1`,
          [row.comment_id, providerOperationId, providerPostId, leaseSeconds],
        );
        return {
          outcome: "ready",
          phase: "lookup",
          row: {
            ...row,
            operation_database_id: existing.id,
            provider_operation_id: providerOperationId,
            provider_post_id: providerPostId,
            reply_reconciliation_attempt_count: claimedAttempt,
          },
        };
      }

      const maxSendAttempts = 10;
      if (
        row.reply_attempt_count >= maxSendAttempts ||
        (existing?.status === "failed" && existing.attempt_count >= maxSendAttempts)
      ) {
        yield* client.query(
          `UPDATE comments
         SET reply_status = 'failed',
             reply_error = 'Reply retry attempts were exhausted.',
             reply_lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
          [row.comment_id],
        );
        yield* finishJobLease(client, eventKey(message), "succeeded");
        return { outcome: "skipped" };
      }

      const intent = existing
        ? yield* client.query<{ id: string }>(
            `UPDATE provider_operations
           SET status = 'started', attempt_count = attempt_count + 1,
               error_class = NULL, last_error = NULL, completed_at = NULL,
               provider_operation_id = NULL, provider_post_id = NULL,
               provider_url = NULL, updated_at = now()
           WHERE id = $1 AND status = 'failed'
           RETURNING id`,
            [existing.id],
          )
        : yield* client.query<{ id: string }>(
            `INSERT INTO provider_operations
             (org_id, distribution_id, comment_id, operation,
              idempotency_key, status)
           VALUES ($1, $2, $3, 'reply', $4, 'started')
           RETURNING id`,
            [row.org_id, row.distribution_id, row.comment_id, key],
          );
      const operationDatabaseId = intent.rows[0]?.id;
      if (!operationDatabaseId) {
        yield* finishJobLease(client, eventKey(message), "failed", {
          error: "Reply intent could not be claimed.",
        });
        return { outcome: "deferred" };
      }
      yield* client.query(
        `UPDATE comments
       SET reply_status = 'in_progress', reply_error = NULL,
           reply_attempt_count = reply_attempt_count + 1,
           reply_attempted_at = now(),
           reply_lease_expires_at = now() + ($2 * INTERVAL '1 second'),
           updated_at = now()
       WHERE id = $1`,
        [row.comment_id, leaseSeconds],
      );
      return {
        outcome: "ready",
        phase: "send",
        row: {
          ...row,
          operation_database_id: operationDatabaseId,
          provider_operation_id: null,
          provider_post_id: null,
          reply_attempt_count: row.reply_attempt_count + 1,
        },
      };
    }),
  );
}

/**
 * Flags the platform account as requiring reconnection when authentication errors occur.
 *
 * Checks if the provider failure is classified as 'auth' and updates the linked platform
 * account status to 'reconnect_required'.
 *
 * @param client - Transactional database client.
 * @param row - Reply row containing the distribution reference.
 * @param failure - Provider failure descriptor, or null if successful.
 */
function markAccountReconnectRequired(
  client: EffectTransactionClient,
  row: ReplyRow,
  failure: ProviderFailure | null,
): Effect.Effect<void, DatabaseError> {
  if (failure?.classification !== "auth") return Effect.void;
  return client
    .query(
      `UPDATE platform_accounts AS account
     SET connection_status = 'reconnect_required', updated_at = now()
     FROM distributions AS distribution
     WHERE distribution.id = $1
       AND account.id = distribution.platform_account_id
       AND account.connection_status IN ('connected', 'expiring', 'expired')`,
      [row.distribution_id],
    )
    .pipe(Effect.asVoid);
}

/**
 * Records a successful comment reply delivery in both the provider operations and comments tables.
 *
 * Marks the operation as succeeded, updates the comment with replied = true, clears lease expirations,
 * and finalizes the async job lease.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Reply row being updated.
 * @param providerOperationId - Platform-assigned operation or reply ID, if returned.
 * @param providerPostId - Platform-assigned post identifier, if returned.
 * @param transaction - Database transaction runner.
 */
function recordReplySuccess(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  providerOperationId: string | null,
  providerPostId: string | null,
  transaction: SystemTransaction,
): Effect.Effect<void, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE provider_operations
       SET status = 'succeeded', provider_operation_id = $2,
           provider_post_id = $3, error_class = NULL, last_error = NULL,
           completed_at = now(), updated_at = now()
       WHERE id = $1`,
        [row.operation_database_id, providerOperationId, providerPostId],
      );
      yield* client.query(
        `UPDATE comments
       SET replied = true, reply_status = 'succeeded', reply_error = NULL,
           reply_provider_operation_id = $2,
           reply_provider_post_id = $3, reply_lease_expires_at = NULL,
           reply_attempted_at = COALESCE(reply_attempted_at, now()),
           updated_at = now()
       WHERE id = $1
         AND reply_status IN ('in_progress', 'needs_reconciliation')`,
        [row.comment_id, providerOperationId, providerPostId],
      );
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

/**
 * Records a permanent or retryable failure for a comment reply attempt.
 *
 * Updates provider operations and comments status, marks the account for reconnection if auth
 * failed, and finalizes or releases the job lease depending on whether retries remain.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Reply row being updated.
 * @param failure - Provider failure metadata including message and classification.
 * @param retry - Boolean indicating whether the reply will be retried.
 * @param transaction - Database transaction runner.
 */
function recordReplyFailure(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  failure: ProviderFailure,
  retry: boolean,
  transaction: SystemTransaction,
): Effect.Effect<void, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE provider_operations
       SET status = 'failed', error_class = $2, last_error = $3,
           completed_at = now(), updated_at = now()
       WHERE id = $1`,
        [row.operation_database_id, failure.classification, failure.message],
      );
      yield* client.query(
        `UPDATE comments
       SET reply_status = $2, reply_error = $3,
           reply_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1
         AND reply_status IN ('in_progress', 'needs_reconciliation')`,
        [row.comment_id, retry ? "queued" : "failed", failure.message],
      );
      yield* markAccountReconnectRequired(client, row, failure);
      yield* finishJobLease(client, eventKey(message), retry ? "failed" : "succeeded", {
        error: retry ? failure.message : undefined,
      });
    }),
  );
}

/**
 * Records an ambiguous reply dispatch outcome and arms delayed reconciliation if an operation ID exists.
 *
 * When an unknown outcome occurs, marks comment and operation status as 'needs_reconciliation'.
 * If a provider operation ID was captured, schedules a delayed reconciliation outbox event.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Reply row being updated.
 * @param result - Provider operation result with unknown outcome.
 * @param transaction - Database transaction runner.
 * @returns True if reconciliation lookup can proceed, false otherwise.
 */
function recordReplyAmbiguous(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  result: Extract<ProviderOperationResult, { outcome: "unknown" }>,
  transaction: SystemTransaction,
): Effect.Effect<boolean, DatabaseError> {
  const canLookup = Boolean(result.providerOperationId);
  const delay = replyReconciliationCadenceSeconds(row.reply_reconciliation_attempt_count + 1);
  return Effect.gen(function* () {
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE provider_operations
       SET status = 'needs_reconciliation', provider_operation_id = $2,
           error_class = 'ambiguous', last_error = $3,
           completed_at = NULL, updated_at = now()
       WHERE id = $1`,
          [row.operation_database_id, result.providerOperationId ?? null, result.failure.message],
        );
        yield* client.query(
          `UPDATE comments
       SET reply_status = 'needs_reconciliation', reply_error = $2,
           reply_provider_operation_id = $3,
           reply_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND reply_status = 'in_progress'`,
          [row.comment_id, result.failure.message, result.providerOperationId ?? null],
        );
        if (canLookup) {
          yield* emitDelayedReconciliation(client, row, delay);
        }
        yield* finishJobLease(client, eventKey(message), canLookup ? "failed" : "succeeded", {
          error: canLookup ? result.failure.message : undefined,
        });
      }),
    );
    return canLookup;
  });
}
/**
 * Records a confirmed reply dispatch that produced only a provider operation identity.
 *
 * A 'confirmed_success' without a post identity means the platform accepted a
 * durable operation (for example a Threads reply media container) whose
 * publication is still pending: the operation identity is evidence for
 * reconciliation, never permission to mark the reply sent. The comment and its
 * provider operation therefore move to 'needs_reconciliation' without
 * `replied = true`, and a delayed reconciliation Outbox event is armed at the
 * cadence so a lost Queue delivery can never strand the pending container.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Reply row being updated.
 * @param providerOperationId - Platform-assigned operation identity to persist.
 * @param transaction - Database transaction runner.
 */
function recordReplyPending(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  providerOperationId: string | null,
  transaction: SystemTransaction,
): Effect.Effect<void, DatabaseError> {
  const delay = replyReconciliationCadenceSeconds(row.reply_reconciliation_attempt_count + 1);
  return transaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE provider_operations
       SET status = 'needs_reconciliation', provider_operation_id = $2,
           error_class = NULL, last_error = NULL,
           completed_at = NULL, updated_at = now()
       WHERE id = $1`,
        [row.operation_database_id, providerOperationId],
      );
      yield* client.query(
        `UPDATE comments
       SET reply_status = 'needs_reconciliation', reply_error = NULL,
           reply_provider_operation_id = $2,
           reply_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND reply_status = 'in_progress'`,
        [row.comment_id, providerOperationId],
      );
      yield* emitDelayedReconciliation(client, row, delay);
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

/**
 * Processes the outcome of a provider reply publication call.
 *
 * Routes confirmed successes carrying post evidence to recordReplySuccess,
 * confirmed successes carrying only an operation identity to recordReplyPending
 * (the reply stays pending platform processing, never `replied`), ambiguous
 * outcomes to recordReplyAmbiguous, or classifies failures and triggers retries
 * if permitted by the adapter's retry policy.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Active reply row being processed.
 * @param execution - Result object returned from provider reply invocation.
 * @param transaction - Database transaction runner.
 * @returns True if the reply attempt should be retried, false otherwise.
 */
function recordSendOutcome(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  execution: ProviderReplyExecution,
  transaction: SystemTransaction,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
    const { result } = execution;
    if (result.outcome === "confirmed_success") {
      // A confirmed operation identity without a post identity is a pending
      // container, not a delivered reply: persist the evidence and arm delayed
      // reconciliation instead of recording reply success (#256 story 3).
      if (!result.providerPostId) {
        yield* recordReplyPending(
          env,
          message,
          row,
          result.providerOperationId ?? null,
          transaction,
        );
        return false;
      }
      yield* recordReplySuccess(
        env,
        message,
        row,
        result.providerOperationId ?? null,
        result.providerPostId,
        transaction,
      );
      return false;
    }
    if (result.outcome === "unknown") {
      return yield* recordReplyAmbiguous(env, message, row, result, transaction);
    }
    const retry =
      result.failure.retryable &&
      row.reply_attempt_count < (execution.retryPolicy?.maxAttempts ?? 1);
    yield* recordReplyFailure(env, message, row, result.failure, retry, transaction);
    return retry;
  });
}

interface LookupState {
  failure: ProviderFailure | null;
  providerOperationId: string | null;
  providerPostId: string | null;
  state: "failed" | "manual" | "retry" | "succeeded";
}

/**
 * Computes the normalized state resolution from a distribution lookup execution result.
 *
 * Maps lookup status states (published, failed, processing, not_found, unknown) into
 * state transitions ('succeeded', 'failed', 'retry', 'manual') and extracts provider IDs.
 *
 * @param execution - Distribution lookup execution result from the provider adapter.
 * @param row - Current reply row with attempt counters and existing IDs.
 * @returns Derived lookup state resolution containing status and failure details.
 */
function lookupState(execution: DistributionLookupExecution, row: ReplyRow): LookupState {
  if (execution.result.kind === "lookup_failure") {
    const { failure } = execution.result;
    return {
      failure,
      providerOperationId: row.provider_operation_id,
      providerPostId: row.provider_post_id,
      state:
        failure.retryable && row.reply_reconciliation_attempt_count < maximumReconciliationAttempts
          ? "retry"
          : "manual",
    };
  }
  const { status } = execution.result;
  if (status.state === "published") {
    return {
      failure: null,
      providerOperationId: status.result.providerOperationId ?? row.provider_operation_id,
      providerPostId: status.result.providerPostId ?? row.provider_post_id,
      state: "succeeded",
    };
  }
  if (status.state === "failed") {
    return {
      failure: status.result.failure,
      providerOperationId: status.result.providerOperationId ?? row.provider_operation_id,
      providerPostId: row.provider_post_id,
      state: "failed",
    };
  }
  const retry = row.reply_reconciliation_attempt_count < maximumReconciliationAttempts;
  return {
    failure:
      status.state === "unknown"
        ? status.result.failure
        : {
            classification: "ambiguous",
            code:
              status.state === "not_found"
                ? "provider_reply_not_found"
                : "provider_reply_processing",
            message: "The provider reply outcome could not be confirmed.",
            retryable: false,
          },
    providerOperationId:
      status.state === "processing"
        ? status.providerOperationId
        : status.state === "unknown"
          ? (status.result.providerOperationId ?? row.provider_operation_id)
          : row.provider_operation_id,
    providerPostId: row.provider_post_id,
    state: retry ? "retry" : "manual",
  };
}

/**
 * Records the outcome of a provider status lookup during comment reply reconciliation.
 *
 * If confirmed succeeded or failed, transitions the comment accordingly. If still ambiguous,
 * schedules the next delayed reconciliation attempt if retry limits have not been reached.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message being processed.
 * @param row - Active reply row being reconciled.
 * @param execution - Result of the provider status lookup.
 * @param transaction - Database transaction runner.
 * @returns True if reconciliation should be retried, false otherwise.
 */
function recordLookupOutcome(
  env: AutomationEnv,
  message: ReplyMessage,
  row: ReplyRow,
  execution: DistributionLookupExecution,
  transaction: SystemTransaction,
): Effect.Effect<boolean, DatabaseError> {
  const state = lookupState(execution, row);
  return Effect.gen(function* () {
    if (state.state === "succeeded") {
      yield* recordReplySuccess(
        env,
        message,
        row,
        state.providerOperationId,
        state.providerPostId,
        transaction,
      );
      return false;
    }
    if (state.state === "failed" && state.failure) {
      yield* recordReplyFailure(env, message, row, state.failure, false, transaction);
      return false;
    }

    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        const error =
          state.failure?.message ?? "The provider reply outcome could not be confirmed.";
        const delay = replyReconciliationCadenceSeconds(row.reply_reconciliation_attempt_count + 1);
        yield* client.query(
          `UPDATE provider_operations
       SET status = 'needs_reconciliation', provider_operation_id = $2,
            provider_post_id = $3, error_class = $4, last_error = $5,
            completed_at = NULL, updated_at = now()
       WHERE id = $1`,
          [
            row.operation_database_id,
            state.providerOperationId,
            state.providerPostId,
            state.failure?.classification ?? "ambiguous",
            error,
          ],
        );
        yield* client.query(
          `UPDATE comments
       SET reply_status = 'needs_reconciliation', reply_error = $2,
           reply_provider_operation_id = $3,
           reply_provider_post_id = $4,
           reply_lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND reply_status = 'needs_reconciliation'`,
          [row.comment_id, error, state.providerOperationId, state.providerPostId],
        );
        if (state.state === "retry") {
          yield* emitDelayedReconciliation(client, row, delay);
        }
        yield* markAccountReconnectRequired(client, row, state.failure);
        yield* finishJobLease(
          client,
          eventKey(message),
          state.state === "retry" ? "failed" : "succeeded",
          { error: state.state === "retry" ? error : undefined },
        );
      }),
    );
    return state.state === "retry";
  });
}

/**
 * Main queue consumer handler for processing comment reply requested outbox messages.
 *
 * Manages leases, sends or reconciles replies, and records outcomes in the caller's
 * job fiber. Existing transactions remain intact; retry signals and persistence
 * rejections travel on the Effect failure channel without an internal runner.
 * RetryableReplyError retries stay site-local: the trailing classification maps
 * them by name to RetryableJobError (the original exception name survives in the
 * wrapper's `cause`), so the channel carries only typed AutomationJobError or
 * propagated ProviderAdapterError failures.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message from the queue.
 * @param dependencies - Optional dependency overrides for testing (credentials, time, registry, transaction).
 * @returns Effect producing 'processed' or 'skipped'; fails with a classified AutomationJobError (retryable reply outcomes become RetryableJobError).
 */
export function processReplyMessage(
  env: AutomationEnv,
  message: ReplyMessage,
  dependencies: ReplyProcessingDependencies = {},
): Effect.Effect<"processed" | "skipped", AutomationJobError | ProviderAdapterError> {
  return Effect.gen(function* () {
    if (!isOutboxMessage(message) || message.topic !== "comment.reply.requested") {
      return "skipped" as const;
    }
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const prepared = yield* prepare(env, message, transaction).pipe(
      Effect.mapError(classifyJobError),
    );
    if (prepared.outcome === "deferred") {
      return yield* Effect.fail(new RetryableReplyError("reply event lease is still active"));
    }
    if (prepared.outcome === "skipped") return "skipped" as const;

    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const decryptToken = dependencies.decryptToken ?? decryptStoredToken(env);
    const now = dependencies.now?.() ?? new Date();
    const requestContext = {
      operationId: idempotencyKey(prepared.row.comment_id),
      requestId: message.request_id ?? message.event_id,
    };
    let retry: boolean;
    if (prepared.phase === "send") {
      const execution = yield* Effect.provide(
        executeProviderReplyEffect(
          registry,
          requestContext,
          {
            connectionStatus: prepared.row.connection_status ?? "unavailable",
            idempotencyKey: idempotencyKey(prepared.row.comment_id),
            platform: prepared.row.platform,
            providerAccountId: prepared.row.platform_user_id ?? undefined,
            providerCommentId: prepared.row.platform_comment_id,
            storedAccessToken: prepared.row.access_token ?? "",
            text: prepared.row.reply_text,
            tokenExpiresAt:
              prepared.row.token_expires_at === null
                ? null
                : new Date(prepared.row.token_expires_at),
          },
          { decryptToken },
          now,
        ),
        createProviderServiceLive(registry),
      );
      retry = yield* recordSendOutcome(env, message, prepared.row, execution, transaction).pipe(
        Effect.mapError(classifyJobError),
      );
    } else {
      const execution = yield* Effect.provide(
        executeProviderLookupEffect(
          registry,
          requestContext,
          {
            connectionStatus: prepared.row.connection_status ?? "unavailable",
            platform: prepared.row.platform,
            providerAccountId: prepared.row.platform_user_id ?? undefined,
            providerOperationId: prepared.row.provider_operation_id,
            providerPostId: prepared.row.provider_post_id,
            storedAccessToken: prepared.row.access_token ?? "",
            tokenExpiresAt:
              prepared.row.token_expires_at === null
                ? null
                : new Date(prepared.row.token_expires_at),
          },
          { decryptToken },
          now,
        ),
        createProviderServiceLive(registry),
      );
      retry = yield* recordLookupOutcome(env, message, prepared.row, execution, transaction).pipe(
        Effect.mapError(classifyJobError),
      );
    }
    if (retry) return yield* Effect.fail(new RetryableReplyError());
    return "processed" as const;
  }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
}
