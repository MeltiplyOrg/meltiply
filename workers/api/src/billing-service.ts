import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { PLAN_LIMITS } from "@meltiply/domain";

import { validateBillingRedirect } from "./billing-redirects";
import { CoreApiError, type CoreServiceError, type IdempotentResult } from "./core-types";
import {
  activeOrganizationIdEffect,
  withSystemTransactionEffect,
  withTenantTransactionEffect,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  type IdempotencyRecord,
} from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";

type SignedUrlResponse = components["schemas"]["SignedUrlResponse"];
type BillingOperation = "checkout" | "portal";
type BillingIdempotencyOperation = "billing-checkout" | "billing-portal";

const operationLease = "2 minutes";
const maximumAutomaticAttempts = 3;

export interface BillingSessionProvider {
  checkoutPlan?(input: { plan: string }): { providerPlanId: string };
  ensureCustomer(input: {
    operationId: string;
    organizationId: string;
  }): Promise<{ providerCustomerId: string }>;
  createCheckoutSession(input: {
    cancelUrl: string;
    operationId: string;
    organizationId: string;
    plan: string;
    providerIntentCreatedAt: string;
    providerCustomerId: string;
    providerPlanId?: string;
    successUrl: string;
  }): Promise<SignedUrlResponse>;
  createPortalSession(input: {
    operationId: string;
    organizationId: string;
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<SignedUrlResponse>;
}

export type BillingSessionProviderFactory = (
  env: ApiWorkerEnv,
) => BillingSessionProvider | undefined;

export interface BillingSessionInput {
  cancelUrl: string;
  plan: string;
  successUrl: string;
}

export interface BillingPortalInput {
  returnUrl: string;
}

interface BillingOperationRow extends Record<string, unknown> {
  attempt_count: number;
  created_at: Date | string;
  id: string;
  lease_active: boolean;
  operation: BillingOperation;
  operation_id: string;
  provider_customer_id: string | null;
  provider_plan_id: string | null;
  status: "failed" | "needs_reconciliation" | "started" | "succeeded";
}

interface BillingIdempotencyRow extends IdempotencyRecord {
  id: string;
}

type PreparedBillingOperation =
  | { kind: "replay"; value: SignedUrlResponse }
  | {
      billingOperationId: string;
      kind: "execute";
      operationId: string;
      providerIntentCreatedAt: string;
      providerCustomerId: string | null;
      providerPlanId: string | null;
    };

type BillingReplayRecord = Pick<IdempotencyRecord, "response_body" | "response_status">;

/**
 * Asserts that the authenticated session possesses administrative billing permissions via Effect.
 *
 * Checks that the user is an organization admin (`"admin"` or `"org:admin"`). Personal workspaces
 * without an explicit organizationId are treated as owner-admin.
 *
 * @param session - Authenticated user session claims.
 * @returns Effect resolving with void if authorized or failing with 403 `forbidden`.
 */
function requireBillingAdminEffect(session: SessionClaims): Effect.Effect<void, CoreApiError> {
  if (!session.organizationId || ["admin", "org:admin"].includes(session.organizationRole ?? "")) {
    return Effect.void;
  }
  return Effect.fail(
    new CoreApiError(
      403,
      "forbidden",
      "Billing management requires an organization administrator.",
    ),
  );
}

const safeIdentifier = /^[^\u0000-\u0020\u007f]{1,512}$/;

/**
 * Validates and trims an external billing customer identifier returned by the billing provider.
 *
 * @param value - Raw customer identifier string.
 * @returns Trimmed identifier string.
 * @throws {CoreApiError} 503 `billing_unavailable` if identifier contains non-printable/whitespace characters or exceeds 512 chars.
 */
function providerCustomerId(value: string): string {
  const normalized = value.trim();
  if (!safeIdentifier.test(normalized)) {
    throw new CoreApiError(
      503,
      "billing_unavailable",
      "The billing provider returned invalid customer evidence.",
    );
  }
  return normalized;
}

/**
 * Validates and trims an external billing customer identifier via Effect.
 *
 * @param value - Raw customer identifier string.
 * @returns Effect resolving to trimmed identifier string or failing with 503 `billing_unavailable`.
 */
function providerCustomerIdEffect(value: string): Effect.Effect<string, CoreApiError> {
  return Effect.try({
    try: () => providerCustomerId(value),
    catch: (cause) => cause as CoreApiError,
  });
}

/**
 * Validates and trims an external provider plan identifier.
 *
 * @param value - Raw plan identifier string from provider.
 * @returns Trimmed plan identifier string.
 * @throws {CoreApiError} 503 `billing_unavailable` if plan identifier format is invalid.
 */
function providerPlanId(value: string): string {
  const normalized = value.trim();
  if (!safeIdentifier.test(normalized)) {
    throw new CoreApiError(
      503,
      "billing_unavailable",
      "The billing provider returned invalid plan evidence.",
    );
  }
  return normalized;
}

/**
 * Validates and trims an external provider plan identifier via Effect.
 *
 * @param value - Raw plan identifier string from provider.
 * @returns Effect resolving to trimmed plan identifier string or failing with 503 `billing_unavailable`.
 */
function providerPlanIdEffect(value: string): Effect.Effect<string, CoreApiError> {
  return Effect.try({
    try: () => providerPlanId(value),
    catch: (cause) => cause as CoreApiError,
  });
}

/**
 * Validates and formats the creation timestamp of a billing intent for upstream provider correlation.
 *
 * @param value - Date object or ISO string.
 * @returns Canonical ISO 8601 string representation.
 * @throws {CoreApiError} 503 `billing_reconciliation_required` if timestamp cannot be parsed into a finite time.
 */
function providerIntentCreatedAt(value: Date | string): string {
  const createdAt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new CoreApiError(
      503,
      "billing_reconciliation_required",
      "The billing provider intent requires reconciliation.",
    );
  }
  return createdAt.toISOString();
}

/**
 * Validates and formats the creation timestamp of a billing intent via Effect.
 *
 * @param value - Date object or ISO string.
 * @returns Effect resolving to canonical ISO 8601 string or failing with 503 `billing_reconciliation_required`.
 */
function providerIntentCreatedAtEffect(value: Date | string): Effect.Effect<string, CoreApiError> {
  return Effect.try({
    try: () => providerIntentCreatedAt(value),
    catch: (cause) => cause as CoreApiError,
  });
}

/**
 * Validates the structure and safety of a hosted checkout or portal session returned by the provider.
 *
 * Asserts the URL uses HTTPS without credentials or excessive length, and verifies that the expiration
 * timestamp is valid, strictly in the future, and not beyond 1 hour.
 *
 * @param value - Raw response payload from provider.
 * @param replay - Whether this session is being replayed from idempotency cache.
 * @returns Validated `SignedUrlResponse` containing url and expires_at.
 * @throws {CoreApiError} 409 `billing_session_expired` if an idempotency replay has already expired.
 * @throws {CoreApiError} 503 `billing_unavailable` if session fields are missing, malformed, or unsafe.
 */
function signedSession(value: unknown, replay = false): SignedUrlResponse {
  try {
    if (!value || typeof value !== "object") {
      throw new TypeError("missing billing session");
    }
    const candidate = value as Partial<SignedUrlResponse>;
    if (typeof candidate.expires_at !== "string" || typeof candidate.url !== "string") {
      throw new TypeError("invalid billing session fields");
    }
    const expiresAt = new Date(candidate.expires_at);
    const url = new URL(candidate.url);
    const now = Date.now();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.toString() !== candidate.url ||
      candidate.url.length > 2_048 ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() > now + 60 * 60 * 1_000
    ) {
      throw new TypeError("unsafe billing session");
    }
    if (expiresAt.getTime() <= now) {
      if (replay) {
        throw new CoreApiError(
          409,
          "billing_session_expired",
          "The idempotent billing session has expired; use a new Idempotency-Key.",
        );
      }
      throw new TypeError("expired billing session");
    }
    return candidate as SignedUrlResponse;
  } catch (error) {
    if (error instanceof CoreApiError) throw error;
    throw new CoreApiError(
      503,
      "billing_unavailable",
      "The billing provider returned an invalid session.",
    );
  }
}

/**
 * Validates the structure and safety of a hosted checkout or portal session via Effect.
 *
 * @param value - Raw response payload from provider.
 * @param replay - Whether this session is being replayed from idempotency cache.
 * @returns Effect resolving to validated `SignedUrlResponse` or failing with CoreApiError.
 */
function signedSessionEffect(
  value: unknown,
  replay = false,
): Effect.Effect<SignedUrlResponse, CoreApiError> {
  return Effect.try({
    try: () => signedSession(value, replay),
    catch: (cause) => cause as CoreApiError,
  });
}

/**
 * Replays a previously completed billing response from an idempotency record.
 *
 * If the record status was 201 Created, validates and returns the stored session (checking expiry).
 * If the record represents an error, reconstructs and throws the corresponding `CoreApiError`.
 *
 * @param record - Stored idempotency record containing status and body.
 * @returns Replayed `SignedUrlResponse` if successful.
 * @throws {CoreApiError} The recorded API error or 503 `billing_reconciliation_required` if state is corrupted.
 */
function replayBillingResponse(record: BillingReplayRecord): SignedUrlResponse {
  if (record.response_status === 201) {
    return signedSession(record.response_body, true);
  }
  if (
    record.response_status !== null &&
    record.response_status >= 400 &&
    record.response_status <= 599 &&
    record.response_body &&
    typeof record.response_body === "object"
  ) {
    const body = record.response_body as { code?: unknown; message?: unknown };
    if (
      typeof body.code === "string" &&
      /^[a-z0-9_]{1,64}$/.test(body.code) &&
      typeof body.message === "string" &&
      body.message.length >= 1 &&
      body.message.length <= 256
    ) {
      throw new CoreApiError(record.response_status, body.code, body.message);
    }
  }
  throw new CoreApiError(
    503,
    "billing_reconciliation_required",
    "The billing provider outcome requires reconciliation.",
  );
}

/**
 * Replays a previously completed billing response from an idempotency record via Effect.
 *
 * @param record - Stored idempotency record containing status and body.
 * @returns Effect resolving to replayed `SignedUrlResponse` or failing with CoreApiError.
 */
function replayBillingResponseEffect(
  record: BillingReplayRecord,
): Effect.Effect<SignedUrlResponse, CoreApiError> {
  return Effect.try({
    try: () => replayBillingResponse(record),
    catch: (cause) => cause as CoreApiError,
  });
}

/**
 * Derives a deterministic provider operation identifier scoped to an organization and idempotency key via Effect.
 *
 * @param organizationId - UUID of the customer organization.
 * @param operation - Billing operation type (`"checkout"` or `"portal"`).
 * @param idempotencyKey - Client-provided idempotency key.
 * @returns Effect resolving to deterministic operation identifier string (e.g. `"billing-checkout:<hash>"`).
 */
function providerOperationIdEffect(
  organizationId: string,
  operation: BillingOperation,
  idempotencyKey: string,
): Effect.Effect<string> {
  return hashIdempotencyRequestEffect(JSON.stringify([organizationId, idempotencyKey])).pipe(
    Effect.map((hash) => `billing-${operation}:${hash}`),
  );
}

/**
 * Prepares or recovers an idempotent billing operation within a system transaction via Effect.
 *
 * Checks `idempotency_keys` and `billing_operations`. Replays completed responses, handles in-flight
 * lease renewals, rejects conflicting requests, and enforces bounded retry limits before delegating to
 * operator reconciliation.
 *
 * @param env - Worker environment bindings.
 * @param organizationId - Target organization UUID.
 * @param operation - Billing operation type (`"checkout"` or `"portal"`).
 * @param idempotencyOperation - Operation key for `idempotency_keys` table.
 * @param idempotencyKey - Client idempotency key.
 * @param requestHash - SHA-256 digest of normalized request parameters.
 * @param requestedProviderPlanId - Resolved provider plan ID (for checkout).
 * @returns Effect resolving to prepared operation ready for execution, or cached replay.
 * @throws {CoreApiError} 409 `idempotency_conflict` if idempotency key was previously used with different params.
 * @throws {CoreApiError} 409 `idempotency_in_progress` if an operation with active lease is ongoing.
 * @throws {CoreApiError} 503 `billing_reconciliation_required` if automatic retries are exhausted or state is corrupt.
 */
function prepareBillingOperationEffect(
  env: ApiWorkerEnv,
  organizationId: string,
  operation: BillingOperation,
  idempotencyOperation: BillingIdempotencyOperation,
  idempotencyKey: string,
  requestHash: string,
  requestedProviderPlanId: string | null,
): Effect.Effect<PreparedBillingOperation, CoreServiceError> {
  return Effect.gen(function* () {
    const operationId = yield* providerOperationIdEffect(organizationId, operation, idempotencyKey);
    const prepared = yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* lockOrganizationEffect(client, organizationId);
        const inserted = yield* client.query<{ id: string }>(
          `INSERT INTO idempotency_keys
           (org_id, operation, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
          [organizationId, idempotencyOperation, idempotencyKey, requestHash],
        );
        const insertedId = inserted.rows[0]?.id;
        let idempotency: BillingIdempotencyRow | undefined;
        if (insertedId) {
          idempotency = {
            id: insertedId,
            request_hash: requestHash,
            response_body: null,
            response_status: null,
          };
        } else {
          const fetched = yield* client.query<BillingIdempotencyRow>(
            `SELECT id, request_hash, response_status, response_body
             FROM idempotency_keys
             WHERE org_id = $1 AND operation = $2 AND idempotency_key = $3
             FOR UPDATE`,
            [organizationId, idempotencyOperation, idempotencyKey],
          );
          idempotency = fetched.rows[0];
        }
        if (!idempotency) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "idempotency_in_progress",
              "The idempotent operation is still being recorded.",
            ),
          );
        }
        if (idempotency.request_hash !== requestHash) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "idempotency_conflict",
              "The Idempotency-Key was already used with a different request.",
            ),
          );
        }
        if (idempotency.response_status !== null) {
          const replayValue = yield* replayBillingResponseEffect(idempotency);
          return {
            kind: "replay" as const,
            value: replayValue,
          };
        }

        const existing = yield* client.query<BillingOperationRow>(
          `SELECT bo.id, bo.operation, bo.operation_id, bo.status, bo.created_at,
                bo.provider_customer_id, bo.provider_plan_id, bo.attempt_count,
                bo.lease_expires_at > now() AS lease_active
         FROM billing_operations bo
         WHERE bo.idempotency_id = $1
         FOR UPDATE`,
          [idempotency.id],
        );
        const row = existing.rows[0];
        if (!row) {
          if (inserted.rowCount !== 1) {
            yield* client.query(
              `INSERT INTO billing_operations
               (org_id, idempotency_id, operation, operation_id, status,
                attempt_count, last_error_code)
             VALUES ($1, $2, $3, $4, 'needs_reconciliation', 1,
                     'legacy_pending_intent')`,
              [organizationId, idempotency.id, operation, operationId],
            );
            return { kind: "blocked" as const };
          }
          const created = yield* client.query<{
            created_at: Date | string;
            id: string;
          }>(
            `INSERT INTO billing_operations
             (org_id, idempotency_id, operation, operation_id,
              provider_plan_id, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + $6::interval)
           RETURNING id, created_at`,
            [
              organizationId,
              idempotency.id,
              operation,
              operationId,
              requestedProviderPlanId,
              operationLease,
            ],
          );
          const organization = yield* client.query<{
            billing_customer_id: string | null;
          }>("SELECT billing_customer_id FROM organizations WHERE id = $1", [organizationId]);
          const customerId = organization.rows[0]?.billing_customer_id ?? null;
          const validatedCustomerId = customerId
            ? yield* providerCustomerIdEffect(customerId)
            : null;
          const validatedIntentCreatedAt = yield* providerIntentCreatedAtEffect(
            created.rows[0]!.created_at,
          );
          return {
            billingOperationId: created.rows[0]!.id,
            kind: "execute" as const,
            operationId,
            providerIntentCreatedAt: validatedIntentCreatedAt,
            providerCustomerId: validatedCustomerId,
            providerPlanId: requestedProviderPlanId,
          };
        }
        if (row.operation !== operation || row.operation_id !== operationId) {
          return { kind: "blocked" as const };
        }
        if (
          operation === "checkout" &&
          requestedProviderPlanId !== null &&
          row.provider_plan_id === null
        ) {
          return { kind: "blocked" as const };
        }
        if (row.status === "started" && row.lease_active) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "idempotency_in_progress",
              "The idempotent billing operation is still in progress.",
            ),
          );
        }
        if (
          row.status === "failed" ||
          row.status === "succeeded" ||
          row.attempt_count >= maximumAutomaticAttempts
        ) {
          if (row.status === "started") {
            yield* client.query(
              `UPDATE billing_operations
             SET status = 'needs_reconciliation', lease_expires_at = NULL,
                 last_error_code = 'automatic_attempts_exhausted',
                 updated_at = now()
             WHERE id = $1`,
              [row.id],
            );
          }
          return { kind: "blocked" as const };
        }
        yield* client.query(
          `UPDATE billing_operations
         SET status = 'started', attempt_count = attempt_count + 1,
             lease_expires_at = now() + $2::interval,
             last_error_code = NULL, started_at = now(), updated_at = now()
         WHERE id = $1`,
          [row.id, operationLease],
        );
        const validatedIntentCreatedAt = yield* providerIntentCreatedAtEffect(row.created_at);
        const validatedCustomerId = row.provider_customer_id
          ? yield* providerCustomerIdEffect(row.provider_customer_id)
          : null;
        const validatedPlanId = row.provider_plan_id
          ? yield* providerPlanIdEffect(row.provider_plan_id)
          : null;
        return {
          billingOperationId: row.id,
          kind: "execute" as const,
          operationId,
          providerIntentCreatedAt: validatedIntentCreatedAt,
          providerCustomerId: validatedCustomerId,
          providerPlanId: validatedPlanId,
        };
      }),
    );
    if (prepared.kind === "blocked") {
      return yield* Effect.fail(
        new CoreApiError(
          503,
          "billing_reconciliation_required",
          "The billing provider outcome requires reconciliation.",
        ),
      );
    }
    return prepared;
  });
}

/**
 * Associates an external customer identifier with an organization and active billing operation via Effect.
 *
 * Locks the organization, verifies customer ID consistency, and persists the external identifier.
 *
 * @param env - Worker environment bindings.
 * @param organizationId - Target organization UUID.
 * @param billingOperationId - UUID of the active billing operation.
 * @param customerId - Validated customer identifier from provider.
 * @returns Effect resolving when customer evidence is persisted or failing with CoreServiceError.
 */
function recordCustomerEvidenceEffect(
  env: ApiWorkerEnv,
  organizationId: string,
  billingOperationId: string,
  customerId: string,
): Effect.Effect<void, CoreServiceError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* lockOrganizationEffect(client, organizationId);
      const operation = yield* client.query<{ status: string }>(
        `SELECT status FROM billing_operations
         WHERE id = $1 AND org_id = $2
         FOR UPDATE`,
        [billingOperationId, organizationId],
      );
      if (operation.rows[0]?.status !== "started") {
        return yield* Effect.fail(
          new CoreApiError(
            503,
            "billing_reconciliation_required",
            "The billing provider outcome requires reconciliation.",
          ),
        );
      }
      const organization = yield* client.query<{
        billing_customer_id: string | null;
      }>("SELECT billing_customer_id FROM organizations WHERE id = $1 FOR UPDATE", [
        organizationId,
      ]);
      const existing = organization.rows[0]?.billing_customer_id;
      if (existing && existing !== customerId) {
        return yield* Effect.fail(
          new CoreApiError(
            503,
            "billing_reconciliation_required",
            "The billing provider returned conflicting customer evidence.",
          ),
        );
      }
      yield* client.query(
        `UPDATE organizations
         SET billing_customer_id = $2, updated_at = now()
         WHERE id = $1 AND billing_customer_id IS NULL`,
        [organizationId, customerId],
      );
      yield* client.query(
        `UPDATE billing_operations
         SET provider_customer_id = $2, updated_at = now()
         WHERE id = $1`,
        [billingOperationId, customerId],
      );
    }),
  );
}

/**
 * Commits a successful billing session outcome into `billing_operations` and `idempotency_keys` via Effect.
 *
 * Marks status as `succeeded`, clears the active lease, and records the 201 response body in idempotency table.
 *
 * @param env - Worker environment bindings.
 * @param organizationId - Target organization UUID.
 * @param billingOperationId - UUID of the active billing operation.
 * @param idempotencyOperation - Operation key in `idempotency_keys`.
 * @param idempotencyKey - Client idempotency key.
 * @param result - Generated `SignedUrlResponse` session.
 * @returns Effect resolving to confirmed `SignedUrlResponse` or failing with CoreServiceError.
 */
function completeBillingOperationEffect(
  env: ApiWorkerEnv,
  organizationId: string,
  billingOperationId: string,
  idempotencyOperation: BillingIdempotencyOperation,
  idempotencyKey: string,
  result: SignedUrlResponse,
): Effect.Effect<SignedUrlResponse, CoreServiceError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* lockOrganizationEffect(client, organizationId);
      const operation = yield* client.query<{
        response_body: unknown;
        response_status: number | null;
        status: string;
      }>(
        `SELECT bo.status, ik.response_status, ik.response_body
         FROM billing_operations bo
         JOIN idempotency_keys ik ON ik.id = bo.idempotency_id
         WHERE bo.id = $1 AND bo.org_id = $2
         FOR UPDATE OF bo, ik`,
        [billingOperationId, organizationId],
      );
      const row = operation.rows[0];
      if (row?.status === "succeeded" && row.response_status !== null) {
        return yield* replayBillingResponseEffect(row);
      }
      if (row?.status !== "started") {
        return yield* Effect.fail(
          new CoreApiError(
            503,
            "billing_reconciliation_required",
            "The billing provider outcome requires reconciliation.",
          ),
        );
      }
      yield* client.query(
        `UPDATE billing_operations
         SET status = 'succeeded', provider_session_expires_at = $2,
             lease_expires_at = NULL, last_error_code = NULL,
             completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [billingOperationId, result.expires_at],
      );
      yield* completeIdempotencyEffect(
        client,
        organizationId,
        idempotencyOperation,
        idempotencyKey,
        201,
        result,
      );
      return result;
    }),
  );
}

/**
 * Transitions an in-flight billing operation to `needs_reconciliation` following a provider or persistence failure via Effect.
 *
 * Clears the active lease and records the failure error code and optional customer ID evidence so an operator
 * can inspect or unblock the operation safely. Catches any database failure to never mask original errors.
 *
 * @param env - Worker environment bindings.
 * @param billingOperationId - UUID of the failed billing operation.
 * @param errorCode - Machine-readable error code describing the failure point.
 * @param customerId - Customer identifier from provider if known.
 * @returns Effect resolving to void (swallows any internal database error).
 */
function markBillingOperationAmbiguousEffect(
  env: ApiWorkerEnv,
  billingOperationId: string,
  errorCode: string,
  customerId: string | null,
): Effect.Effect<void> {
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE billing_operations
       SET status = 'needs_reconciliation',
           provider_customer_id = COALESCE(provider_customer_id, $3),
           lease_expires_at = NULL, last_error_code = $2,
           updated_at = now()
       WHERE id = $1 AND status = 'started'`,
      [billingOperationId, errorCode, customerId],
    ),
  ).pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );
}

/**
 * Orchestrates external provider session generation with atomic customer linking and error handling via Effect.
 *
 * Ensures the organization's billing customer exists on the provider, executes the session creation callback,
 * validates the returned URL/expiry, commits the result to database idempotency records, and marks the operation
 * as ambiguous if any unexpected error occurs.
 *
 * @param env - Worker environment bindings.
 * @param provider - Configured `BillingSessionProvider` adapter instance.
 * @param organizationId - UUID of the customer organization.
 * @param prepared - Prepared operation execution metadata.
 * @param idempotencyOperation - Operation identifier for `idempotency_keys`.
 * @param idempotencyKey - Client idempotency key.
 * @param createSession - Callback invoking the upstream provider session endpoint.
 * @returns Effect resolving to `IdempotentResult<SignedUrlResponse>` or failing with CoreServiceError.
 */
function executeBillingOperationEffect(
  env: ApiWorkerEnv,
  provider: BillingSessionProvider,
  organizationId: string,
  prepared: Extract<PreparedBillingOperation, { kind: "execute" }>,
  idempotencyOperation: BillingIdempotencyOperation,
  idempotencyKey: string,
  createSession: (
    customerId: string,
    operationId: string,
    providerIntentCreatedAt: string,
    providerPlanId: string | null,
  ) => Promise<SignedUrlResponse>,
): Effect.Effect<IdempotentResult<SignedUrlResponse>, CoreServiceError> {
  return Effect.gen(function* () {
    let customerId = prepared.providerCustomerId;
    let errorCode = "provider_request_failed";

    const runExecution = Effect.gen(function* () {
      if (!customerId) {
        errorCode = "provider_request_failed";
        const customer = yield* Effect.tryPromise({
          try: () =>
            provider.ensureCustomer({
              operationId: `billing-customer:${organizationId}`,
              organizationId,
            }),
          catch: (cause) => cause,
        });
        errorCode = "provider_response_invalid";
        customerId = yield* providerCustomerIdEffect(customer.providerCustomerId);
        errorCode = "persistence_failed";
        yield* recordCustomerEvidenceEffect(
          env,
          organizationId,
          prepared.billingOperationId,
          customerId,
        );
      }
      errorCode = "provider_request_failed";
      const providerResult = yield* Effect.tryPromise({
        try: () =>
          createSession(
            customerId!,
            prepared.operationId,
            prepared.providerIntentCreatedAt,
            prepared.providerPlanId,
          ),
        catch: (cause) => cause,
      });
      errorCode = "provider_response_invalid";
      const result = yield* signedSessionEffect(providerResult);
      errorCode = "persistence_failed";
      const completed = yield* completeBillingOperationEffect(
        env,
        organizationId,
        prepared.billingOperationId,
        idempotencyOperation,
        idempotencyKey,
        result,
      );
      return {
        replayed: false,
        value: completed,
      };
    });

    return yield* runExecution.pipe(
      Effect.catchCause(() =>
        markBillingOperationAmbiguousEffect(
          env,
          prepared.billingOperationId,
          errorCode,
          customerId,
        ).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new CoreApiError(
                503,
                "billing_reconciliation_required",
                "The billing provider outcome requires reconciliation.",
              ),
            ),
          ),
        ),
      ),
    );
  });
}

/**
 * Creates billing service method handlers for checkout and customer portal sessions.
 *
 * @param configuredProvider - Optional pre-instantiated `BillingSessionProvider`.
 * @param providerFactory - Optional provider factory function taking worker environment.
 * @returns Object providing `createCheckoutSession` and `createPortalSession` methods.
 */
export function createBillingMethods(
  configuredProvider?: BillingSessionProvider,
  providerFactory?: BillingSessionProviderFactory,
) {
  const providerFor = (env: ApiWorkerEnv) => configuredProvider ?? providerFactory?.(env);

  return {
    /**
     * Initiates a hosted billing checkout session for upgrading or subscribing to a paid tier.
     *
     * Enforces organization admin permissions, validates return/cancel URLs against allowed origins,
     * resolves the active organization ID under tenant RLS, reserves an idempotency lease, and creates
     * or replays the provider checkout URL.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated caller session claims.
     * @param input - Checkout input containing plan, successUrl, and cancelUrl.
     * @param idempotencyKey - Client idempotency key.
     * @returns The signed checkout URL and expiration, indicating whether it was replayed.
     * @throws {CoreApiError} 403 `forbidden` if caller is not an organization administrator.
     * @throws {CoreApiError} 422 `validation_error` if the target plan is free or invalid.
     * @throws {CoreApiError} 503 `billing_unavailable` if billing provider is unconfigured.
     */
    createCheckoutSession(
      env: ApiWorkerEnv,
      session: SessionClaims,
      input: BillingSessionInput,
      idempotencyKey: string,
    ): Effect.Effect<IdempotentResult<SignedUrlResponse>, CoreServiceError> {
      return Effect.gen(function* () {
        yield* requireBillingAdminEffect(session);
        const provider = providerFor(env);
        if (!provider) {
          return yield* Effect.fail(
            new CoreApiError(503, "billing_unavailable", "Billing checkout is not configured."),
          );
        }
        const safeInput = yield* Effect.try({
          try: () => ({
            ...input,
            cancelUrl: validateBillingRedirect(input.cancelUrl, "cancel_url", env.ALLOWED_ORIGINS),
            successUrl: validateBillingRedirect(
              input.successUrl,
              "success_url",
              env.ALLOWED_ORIGINS,
            ),
          }),
          catch: (cause) =>
            cause instanceof CoreApiError
              ? cause
              : new CoreApiError(500, "internal_error", "An unexpected error occurred."),
        });
        if (
          safeInput.plan === "free" ||
          !Object.prototype.hasOwnProperty.call(PLAN_LIMITS, safeInput.plan)
        ) {
          return yield* Effect.fail(
            new CoreApiError(422, "validation_error", "Checkout requires an approved paid plan."),
          );
        }
        const hash = yield* hashIdempotencyRequestEffect(JSON.stringify(safeInput));
        let requestedProviderPlanId: string | null = null;
        if (provider.checkoutPlan) {
          const planInfo = yield* Effect.try({
            try: () => provider.checkoutPlan!({ plan: safeInput.plan }),
            catch: (cause) =>
              cause instanceof CoreApiError
                ? cause
                : new CoreApiError(
                    503,
                    "billing_unavailable",
                    "The billing provider returned invalid plan evidence.",
                  ),
          });
          requestedProviderPlanId = yield* providerPlanIdEffect(planInfo.providerPlanId);
        }
        const organizationId = yield* withTenantTransactionEffect(
          env,
          session,
          activeOrganizationIdEffect,
        );
        const prepared = yield* prepareBillingOperationEffect(
          env,
          organizationId,
          "checkout",
          "billing-checkout",
          idempotencyKey,
          hash,
          requestedProviderPlanId,
        );
        if (prepared.kind === "replay") {
          return { replayed: true, value: prepared.value };
        }
        return yield* executeBillingOperationEffect(
          env,
          provider,
          organizationId,
          prepared,
          "billing-checkout",
          idempotencyKey,
          (customerId, operationId, intentCreatedAt, selectedProviderPlanId) =>
            provider.createCheckoutSession({
              ...safeInput,
              operationId,
              organizationId,
              providerIntentCreatedAt: intentCreatedAt,
              providerCustomerId: customerId,
              ...(selectedProviderPlanId ? { providerPlanId: selectedProviderPlanId } : {}),
            }),
        );
      });
    },

    /**
     * Creates a customer billing portal session for managing subscription and payment methods via Effect.
     *
     * Validates admin permissions, retrieves the provider customer ID, invokes the billing provider portal
     * session endpoint, and records an idempotent response mapping to prevent duplicate portal URLs.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param input - Return URL payload.
     * @param idempotencyKey - Client idempotency key.
     * @returns Effect resolving to signed URL response and replay indicator.
     * @throws {CoreApiError} 403 `forbidden` if caller is not an organization administrator.
     * @throws {CoreApiError} 404 `billing_customer_not_found` if no provider customer ID is associated with the organization.
     * @throws {CoreApiError} 503 `billing_unavailable` if billing provider is unconfigured.
     */
    createPortalSession(
      env: ApiWorkerEnv,
      session: SessionClaims,
      input: BillingPortalInput,
      idempotencyKey: string,
    ): Effect.Effect<IdempotentResult<SignedUrlResponse>, CoreServiceError> {
      return Effect.gen(function* () {
        yield* requireBillingAdminEffect(session);
        const provider = providerFor(env);
        if (!provider) {
          return yield* Effect.fail(
            new CoreApiError(503, "billing_unavailable", "Billing portal is not configured."),
          );
        }
        const safeInput = yield* Effect.try({
          try: () => ({
            returnUrl: validateBillingRedirect(input.returnUrl, "return_url", env.ALLOWED_ORIGINS),
          }),
          catch: (cause) =>
            cause instanceof CoreApiError
              ? cause
              : new CoreApiError(500, "internal_error", "An unexpected error occurred."),
        });
        const hash = yield* hashIdempotencyRequestEffect(JSON.stringify(safeInput));
        const organizationId = yield* withTenantTransactionEffect(
          env,
          session,
          activeOrganizationIdEffect,
        );
        const prepared = yield* prepareBillingOperationEffect(
          env,
          organizationId,
          "portal",
          "billing-portal",
          idempotencyKey,
          hash,
          null,
        );
        if (prepared.kind === "replay") {
          return { replayed: true, value: prepared.value };
        }
        return yield* executeBillingOperationEffect(
          env,
          provider,
          organizationId,
          prepared,
          "billing-portal",
          idempotencyKey,
          (customerId, operationId) =>
            provider.createPortalSession({
              ...safeInput,
              operationId,
              organizationId,
              providerCustomerId: customerId,
            }),
        );
      });
    },
  };
}
