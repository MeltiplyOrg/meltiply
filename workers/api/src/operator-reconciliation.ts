import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";
import type {
  OperatorBillingResolution,
  OperatorBillingResolutionInput,
  OperatorDistributionResolution,
  OperatorReconciliationService,
  OperatorResolutionInput,
} from "./operator-resolution";

type OperatorAction = "resolve_billing_reconciliation" | "resolve_distribution_reconciliation";

interface OperatorAuditReplay extends Record<string, unknown> {
  action: OperatorAction;
  after_state: Record<string, unknown>;
  id: string;
  request_hash: string;
  target_id: string;
}

interface DistributionResolutionState extends Record<string, unknown> {
  failure_code: string | null;
  failure_retryable: boolean | null;
  id: string;
  next_attempt_at: Date | string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  provider_operation_id: string | null;
  status: string;
}

interface BillingResolutionState extends Record<string, unknown> {
  attempt_count: number;
  created_at: Date | string;
  id: string;
  idempotency_id: string;
  last_error_code: string | null;
  lease_expires_at: Date | string | null;
  operation: string;
  operation_id: string;
  provider_customer_id: string | null;
  provider_session_expires_at: Date | string | null;
  response_status: number | null;
  status: string;
}

/**
 * Normalizes a date or string value to an ISO 8601 string for audit logging.
 *
 * @param value - Date, ISO string, or null.
 * @returns Formatted ISO 8601 string, or `null`.
 */
function auditDate(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Extracts a normalized before/after audit snapshot from a `BillingResolutionState` row.
 *
 * @param row - Billing resolution database row.
 * @returns Serialized audit representation of billing state.
 */
function billingAuditState(row: BillingResolutionState) {
  return {
    attempt_count: row.attempt_count,
    last_error_code: row.last_error_code,
    lease_expires_at: auditDate(row.lease_expires_at),
    operation: row.operation,
    operation_id: row.operation_id,
    provider_customer_id: row.provider_customer_id,
    provider_session_expires_at: auditDate(row.provider_session_expires_at),
    status: row.status,
  };
}

/**
 * Extracts a normalized before/after audit snapshot from a `DistributionResolutionState` row.
 *
 * @param row - Distribution resolution database row.
 * @returns Serialized audit representation of distribution state.
 */
function auditState(row: DistributionResolutionState) {
  return {
    failure_code: row.failure_code,
    failure_retryable: row.failure_retryable,
    next_attempt_at:
      row.next_attempt_at === null ? null : new Date(row.next_attempt_at).toISOString(),
    platform_post_id: row.platform_post_id,
    platform_url: row.platform_url,
    provider_operation_id: row.provider_operation_id,
    status: row.status,
  };
}

/**
 * Serializes distribution resolution parameters into a canonical JSON string for idempotency hashing.
 *
 * @param distributionId - Target distribution UUID.
 * @param input - Operator resolution input parameters.
 * @returns Serialized JSON string.
 */
function distributionRequestHashValue(
  distributionId: string,
  input: OperatorResolutionInput,
): string {
  return JSON.stringify({ distributionId, ...input });
}

/**
 * Serializes billing resolution parameters into a canonical JSON string for idempotency hashing.
 *
 * @param billingOperationId - Target billing operation UUID.
 * @param input - Operator billing resolution input parameters.
 * @returns Serialized JSON string.
 */
function billingRequestHashValue(
  billingOperationId: string,
  input: OperatorBillingResolutionInput,
): string {
  return JSON.stringify({ billingOperationId, ...input });
}

/**
 * Locks an operator action idempotency key and checks for a completed replay in `operator_actions`.
 *
 * Uses `operator_action_locks` to prevent concurrent dual execution by the same actor. If a prior
 * action was already recorded, verifies request hash consistency and returns the replay record.
 * Runs inside the caller's Effect transaction so the lock and replay check share one commit scope.
 *
 * @param client - Active Effect transaction client.
 * @param actorSubject - Authenticated operator subject.
 * @param idempotencyKey - Client-supplied idempotency key.
 * @param requestHash - SHA-256 digest of the canonical request parameters.
 * @param action - The operator action type being executed.
 * @returns Effect resolving to the prior `OperatorAuditReplay` record if already completed, or `null` if newly locked.
 * Fails with {CoreApiError} 409 `idempotency_conflict` if the idempotency key was used with different parameters or action.
 */
function lockAndFindReplay(
  client: EffectTransactionClient,
  actorSubject: string,
  idempotencyKey: string,
  requestHash: string,
  action: OperatorAction,
): Effect.Effect<OperatorAuditReplay | null, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(
      `INSERT INTO operator_action_locks (actor_subject, idempotency_key)
       VALUES ($1, $2)
       ON CONFLICT (actor_subject, idempotency_key) DO NOTHING`,
      [actorSubject, idempotencyKey],
    );
    yield* client.query(
      `SELECT actor_subject
       FROM operator_action_locks
       WHERE actor_subject = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [actorSubject, idempotencyKey],
    );
    const replay = yield* client.query<OperatorAuditReplay>(
      `SELECT id, action, target_id, request_hash, after_state
       FROM operator_actions
       WHERE actor_subject = $1 AND idempotency_key = $2`,
      [actorSubject, idempotencyKey],
    );
    const prior = replay.rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash || prior.action !== action) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "idempotency_conflict",
          "The Idempotency-Key was already used for another operator action.",
        ),
      );
    }
    return prior;
  });
}

/**
 * Factory creating the default `OperatorReconciliationService` implementation.
 *
 * Provides administrative reconciliation operations for unblocking stuck billing sessions and distributions
 * with strict idempotency, row locking, and immutable audit trailing.
 *
 * @returns An initialized `OperatorReconciliationService` instance.
 */
export function createOperatorReconciliationService(): OperatorReconciliationService {
  return {
    /**
     * Resolves a stuck or indeterminate billing operation requiring manual intervention.
     *
     * Locks the organization and billing operation row, verifies it is in `needs_reconciliation`,
     * updates its status to `failed` or `succeeded`, closes the associated idempotency key with a 409
     * error prompting client retry with a new key, and writes an audit record in `operator_actions`.
     *
     * @param env - Worker environment bindings.
     * @param actor - Authenticated operator access claims (subject and email).
     * @param billingOperationId - UUID of the target billing operation.
     * @param input - Validated resolution input (`no_effect` or `session_expired` with evidence).
     * @param idempotencyKey - Operator client idempotency key.
     * @param requestId - HTTP request trace identifier.
     * @returns Resolution summary with audit ID, status, and replay flag.
     * @throws {CoreApiError} 404 `billing_operation_not_found` if operation does not exist.
     * @throws {CoreApiError} 409 `billing_operation_not_reconcilable` if not in `needs_reconciliation`.
     */
    resolveBillingOperation(env, actor, billingOperationId, input, idempotencyKey, requestId) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          billingRequestHashValue(billingOperationId, input),
        );
        return yield* withSystemTransactionEffect(env, (client) =>
          Effect.gen(function* () {
            const prior = yield* lockAndFindReplay(
              client,
              actor.subject,
              idempotencyKey,
              requestHash,
              "resolve_billing_reconciliation",
            );
            if (prior) {
              return {
                auditId: prior.id,
                billingOperationId: prior.target_id,
                replayed: true,
                resolution: prior.after_state.resolution as OperatorBillingResolution,
                status: prior.after_state.status as "failed" | "succeeded",
              };
            }

            const owner = yield* client.query<{ org_id: string }>(
              "SELECT org_id FROM billing_operations WHERE id = $1",
              [billingOperationId],
            );
            if (!owner.rows[0]) {
              return yield* Effect.fail(
                new CoreApiError(
                  404,
                  "billing_operation_not_found",
                  "The billing operation was not found.",
                ),
              );
            }
            yield* lockOrganizationEffect(client, owner.rows[0].org_id);

            const selected = yield* client.query<BillingResolutionState>(
              `SELECT bo.id, bo.idempotency_id, bo.operation, bo.operation_id,
                      bo.status, bo.provider_customer_id,
                      bo.provider_session_expires_at, bo.attempt_count,
                      bo.lease_expires_at, bo.last_error_code, bo.created_at,
                      ik.response_status
               FROM billing_operations bo
               JOIN idempotency_keys ik ON ik.id = bo.idempotency_id
               WHERE bo.id = $1
               FOR UPDATE OF bo, ik`,
              [billingOperationId],
            );
            const current = selected.rows[0];
            if (!current) {
              return yield* Effect.fail(
                new CoreApiError(
                  404,
                  "billing_operation_not_found",
                  "The billing operation was not found.",
                ),
              );
            }
            if (current.status !== "needs_reconciliation" || current.response_status !== null) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "billing_operation_not_reconcilable",
                  "The billing operation does not require operator reconciliation.",
                ),
              );
            }
            if (input.resolution === "session_expired") {
              const expiresAt = new Date(input.providerSessionExpiresAt!);
              if (
                !current.provider_customer_id ||
                expiresAt.getTime() <= new Date(current.created_at).getTime()
              ) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "billing_session_evidence_required",
                    "Customer evidence and a plausible expired session are required.",
                  ),
                );
              }
            }

            const beforeState = billingAuditState(current);
            const status: "failed" | "succeeded" =
              input.resolution === "no_effect" ? "failed" : "succeeded";
            const error =
              input.resolution === "no_effect"
                ? {
                    code: "billing_operation_no_effect",
                    message:
                      "The prior billing operation created no usable session; use a new Idempotency-Key.",
                  }
                : {
                    code: "billing_session_expired",
                    message: "The prior billing session has expired; use a new Idempotency-Key.",
                  };
            const updated = yield* client.query<BillingResolutionState>(
              `UPDATE billing_operations
               SET status = $2,
                   provider_session_expires_at = $3,
                   lease_expires_at = NULL,
                   last_error_code = $4,
                   completed_at = now(),
                   updated_at = now()
               WHERE id = $1
               RETURNING id, idempotency_id, operation, operation_id, status,
                         provider_customer_id, provider_session_expires_at,
                         attempt_count, lease_expires_at, last_error_code,
                         created_at, NULL::int AS response_status`,
              [
                billingOperationId,
                status,
                input.providerSessionExpiresAt,
                input.resolution === "no_effect"
                  ? "operator_confirmed_no_effect"
                  : "operator_confirmed_session_expired",
              ],
            );
            const completed = yield* client.query(
              `UPDATE idempotency_keys
               SET response_status = 409, response_body = $2
               WHERE id = $1 AND response_status IS NULL`,
              [current.idempotency_id, error],
            );
            if (completed.rowCount !== 1) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "billing_operation_not_reconcilable",
                  "The billing operation no longer requires reconciliation.",
                ),
              );
            }
            const afterState = {
              ...billingAuditState(updated.rows[0]!),
              resolution: input.resolution,
            };
            const audit = yield* client.query<{ id: string }>(
              `INSERT INTO operator_actions
                 (action, actor_subject, actor_email, idempotency_key,
                  request_hash, request_id, reason, target_type, target_id,
                  before_state, after_state)
               VALUES (
                 'resolve_billing_reconciliation', $1, $2, $3, $4, $5, $6,
                 'billing_operation', $7, $8, $9
               )
               RETURNING id`,
              [
                actor.subject,
                actor.email,
                idempotencyKey,
                requestHash,
                requestId,
                input.reason,
                billingOperationId,
                beforeState,
                afterState,
              ],
            );
            return {
              auditId: audit.rows[0]!.id,
              billingOperationId,
              replayed: false,
              resolution: input.resolution,
              status,
            };
          }),
        );
      });
    },

    /**
     * Resolves an ambiguous or failed distribution requiring manual operator reconciliation.
     *
     * Locks the distribution row with `FOR UPDATE`, validates it is in `awaiting_provider` or
     * `needs_reconciliation`, updates its status to `published`, `failed`, or `cancelled` with verified
     * external evidence, and logs the action and before/after diff in `operator_actions`.
     *
     * @param env - Worker environment bindings.
     * @param actor - Authenticated operator access claims.
     * @param distributionId - UUID of the target distribution.
     * @param input - Validated resolution input (`published`, `failed`, or `cancelled` with evidence).
     * @param idempotencyKey - Operator client idempotency key.
     * @param requestId - HTTP request trace identifier.
     * @returns Resolution summary with audit ID, status, and replay flag.
     * @throws {CoreApiError} 404 `distribution_not_found` if distribution does not exist.
     * @throws {CoreApiError} 409 `distribution_not_reconcilable` if not awaiting provider or in reconciliation.
     */
    resolveDistribution(env, actor, distributionId, input, idempotencyKey, requestId) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          distributionRequestHashValue(distributionId, input),
        );
        return yield* withSystemTransactionEffect(env, (client) =>
          Effect.gen(function* () {
            const prior = yield* lockAndFindReplay(
              client,
              actor.subject,
              idempotencyKey,
              requestHash,
              "resolve_distribution_reconciliation",
            );
            if (prior) {
              return {
                auditId: prior.id,
                distributionId: prior.target_id,
                replayed: true,
                status: prior.after_state.status as OperatorDistributionResolution,
              };
            }

            const selected = yield* client.query<DistributionResolutionState>(
              `SELECT id, status, next_attempt_at, provider_operation_id,
                      platform_post_id, platform_url, failure_code,
                      failure_retryable
               FROM distributions WHERE id = $1 FOR UPDATE`,
              [distributionId],
            );
            const current = selected.rows[0];
            if (!current) {
              return yield* Effect.fail(
                new CoreApiError(404, "distribution_not_found", "The distribution was not found."),
              );
            }
            if (!["awaiting_provider", "needs_reconciliation"].includes(current.status)) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "distribution_not_reconcilable",
                  "The distribution does not require operator reconciliation.",
                ),
              );
            }
            if (input.resolution === "cancelled") {
              const cancellation = yield* client.query<{ status: string }>(
                `SELECT status FROM provider_operations
                 WHERE distribution_id = $1 AND operation = 'cancel'
                 ORDER BY updated_at DESC, id DESC
                 LIMIT 1`,
                [distributionId],
              );
              if (cancellation.rows[0]?.status !== "needs_reconciliation") {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "cancellation_evidence_required",
                    "A reconciliable provider cancellation is required.",
                  ),
                );
              }
            }

            const beforeState = auditState(current);
            const updated = yield* client.query<DistributionResolutionState>(
              `UPDATE distributions
               SET status = $2,
                   platform_post_id = CASE WHEN $2 = 'published' THEN $3 ELSE NULL END,
                   platform_url = CASE WHEN $2 = 'published' THEN $4 ELSE NULL END,
                   published_at = CASE WHEN $2 = 'published' THEN now() ELSE NULL END,
                   failure_code = CASE WHEN $2 = 'failed' THEN $5 ELSE NULL END,
                   failure_retryable = CASE
                     WHEN $2 = 'failed' THEN $6::boolean ELSE NULL
                   END,
                   error_message = CASE WHEN $2 = 'failed'
                     THEN 'An operator confirmed the provider failure.' ELSE NULL END,
                   next_attempt_at = NULL, updated_at = now()
               WHERE id = $1
               RETURNING id, status, next_attempt_at, provider_operation_id,
                         platform_post_id, platform_url, failure_code,
                         failure_retryable`,
              [
                distributionId,
                input.resolution,
                input.providerPostId,
                input.providerUrl,
                input.failureCode,
                input.retryable,
              ],
            );
            const afterState = auditState(updated.rows[0]!);
            const audit = yield* client.query<{ id: string }>(
              `INSERT INTO operator_actions
                 (action, actor_subject, actor_email, idempotency_key,
                  request_hash, request_id, reason, target_type, target_id,
                  before_state, after_state)
               VALUES (
                 'resolve_distribution_reconciliation', $1, $2, $3, $4, $5, $6,
                 'distribution', $7, $8, $9
               )
               RETURNING id`,
              [
                actor.subject,
                actor.email,
                idempotencyKey,
                requestHash,
                requestId,
                input.reason,
                distributionId,
                beforeState,
                afterState,
              ],
            );
            return {
              auditId: audit.rows[0]!.id,
              distributionId,
              replayed: false,
              status: input.resolution,
            };
          }),
        );
      });
    },
  };
}
