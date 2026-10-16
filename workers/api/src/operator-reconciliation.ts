import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";
import type {
  OperatorDistributionResolution,
  OperatorReconciliationService,
  OperatorResolutionInput,
} from "./operator-resolution";

type OperatorAction = "resolve_distribution_reconciliation";

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
 * Reconciles ambiguous distributions with strict idempotency, row locking,
 * and immutable audit evidence.
 *
 * @returns An initialized `OperatorReconciliationService` instance.
 */
export function createOperatorReconciliationService(): OperatorReconciliationService {
  return {

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
