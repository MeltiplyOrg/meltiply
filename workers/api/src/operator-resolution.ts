import type { AccessClaims } from "@meltiply/auth";
import type { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN as uuid } from "./crypto";
import type { ApiWorkerEnv } from "./env";

export type OperatorDistributionResolution = "cancelled" | "failed" | "published";

export interface OperatorResolutionInput {
  failureCode: string | null;
  providerPostId: string | null;
  providerUrl: string | null;
  reason: string;
  resolution: OperatorDistributionResolution;
  retryable: boolean;
}

interface OperatorResolutionResult {
  auditId: string;
  distributionId: string;
  replayed: boolean;
  status: OperatorDistributionResolution;
}

export type OperatorBillingResolution = "no_effect" | "session_expired";

export interface OperatorBillingResolutionInput {
  providerSessionExpiresAt: string | null;
  reason: string;
  resolution: OperatorBillingResolution;
}

interface OperatorBillingResolutionResult {
  auditId: string;
  billingOperationId: string;
  replayed: boolean;
  resolution: OperatorBillingResolution;
  status: "failed" | "succeeded";
}

/**
 * Operator reconciliation contract: each method returns an Effect program the
 * operator route boundary executes once via runRouteEffect, keeping transaction
 * work and typed CoreApiError/DatabaseError failures on the Effect channel.
 */
export interface OperatorReconciliationService {
  resolveBillingOperation(
    env: ApiWorkerEnv,
    actor: AccessClaims,
    billingOperationId: string,
    input: OperatorBillingResolutionInput,
    idempotencyKey: string,
    requestId: string,
  ): Effect.Effect<OperatorBillingResolutionResult, CoreApiError | DatabaseError>;
  resolveDistribution(
    env: ApiWorkerEnv,
    actor: AccessClaims,
    distributionId: string,
    input: OperatorResolutionInput,
    idempotencyKey: string,
    requestId: string,
  ): Effect.Effect<OperatorResolutionResult, CoreApiError | DatabaseError>;
}

const safeCode = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const safeIdentifier = /^[^\u0000-\u0020\u007f]{1,512}$/;

/**
 * Type guard verifying an unknown value is a non-null, non-array object dictionary.
 *
 * @param value - Candidate value.
 * @returns `true` if value is an object record.
 */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates and trims an operator reconciliation justification reason string.
 *
 * @param value - Candidate reason string from operator request.
 * @returns Trimmed reason string.
 * @throws {CoreApiError} 400 `invalid_operator_resolution` if length is outside 8-500 characters.
 */
function reason(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 8 || normalized.length > 500) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "reason must contain between 8 and 500 characters.",
    );
  }
  return normalized;
}

/**
 * Parses and validates an operator resolution payload for a billing operation.
 *
 * Enforces field allowlisting, exact confirmation phrasing (`"resolve <id> as <resolution>"`),
 * and validates that `session_expired` resolutions include a valid past RFC 3339 timestamp.
 *
 * @param billingOperationId - UUID of the target billing operation.
 * @param value - Raw request body payload.
 * @returns Validated `OperatorBillingResolutionInput` object.
 * @throws {CoreApiError} 400 `invalid_operator_resolution` if fields, types, or timestamps are invalid.
 * @throws {CoreApiError} 400 `operator_confirmation_required` if the exact confirmation string is mismatched.
 */
export function parseOperatorBillingResolution(
  billingOperationId: string,
  value: unknown,
): OperatorBillingResolutionInput {
  if (!uuid.test(billingOperationId) || !record(value)) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "A valid billing operation and JSON resolution are required.",
    );
  }
  const allowed = new Set(["confirm", "provider_session_expires_at", "reason", "resolution"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "The resolution contains an unsupported field.",
    );
  }
  const resolution = value.resolution;
  if (resolution !== "no_effect" && resolution !== "session_expired") {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "resolution must be no_effect or session_expired.",
    );
  }
  if (value.confirm !== `resolve ${billingOperationId} as ${resolution}`) {
    throw new CoreApiError(
      400,
      "operator_confirmation_required",
      "The exact billing operation resolution confirmation is required.",
    );
  }
  let providerSessionExpiresAt: string | null = null;
  if (resolution === "session_expired") {
    if (
      typeof value.provider_session_expires_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value.provider_session_expires_at,
      )
    ) {
      throw new CoreApiError(
        400,
        "invalid_operator_resolution",
        "provider_session_expires_at must be a past RFC3339 timestamp.",
      );
    }
    const expiresAt = new Date(value.provider_session_expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() > Date.now()) {
      throw new CoreApiError(
        400,
        "invalid_operator_resolution",
        "provider_session_expires_at must be a past RFC3339 timestamp.",
      );
    }
    providerSessionExpiresAt = expiresAt.toISOString();
  } else if (value.provider_session_expires_at !== undefined) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "Only session_expired accepts provider session expiry evidence.",
    );
  }
  return {
    providerSessionExpiresAt,
    reason: reason(value.reason),
    resolution,
  };
}

/**
 * Validates that an optional provider URL is a bounded, canonical HTTPS URL without credentials or query fragments.
 *
 * @param value - Candidate URL value.
 * @returns Canonical HTTPS URL string, or `null` if empty/omitted.
 * @throws {CoreApiError} 400 `invalid_operator_resolution` if the URL is malformed, non-HTTPS, or contains search/hash/auth fragments.
 */
function canonicalUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "provider_url must be a bounded canonical HTTPS URL.",
    );
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.toString() !== value
    ) {
      throw new TypeError("unsafe provider URL");
    }
    return value;
  } catch {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "provider_url must be a bounded canonical HTTPS URL.",
    );
  }
}

/**
 * Parses and validates an operator manual reconciliation resolution for a publication distribution.
 *
 * Enforces field allowlisting, exact confirmation phrasing (`"resolve <id> as <resolution>"`),
 * and validates that resolution evidence matches terminal state invariants (`published` requires `provider_post_id`,
 * `failed` requires `failure_code` and boolean `retryable`).
 *
 * @param distributionId - UUID of the target distribution.
 * @param value - Raw request body payload.
 * @returns Validated `OperatorResolutionInput` object.
 * @throws {CoreApiError} 400 `invalid_operator_resolution` if payload or evidence fails validation.
 * @throws {CoreApiError} 400 `operator_confirmation_required` if confirmation string is mismatched.
 */
export function parseOperatorResolution(
  distributionId: string,
  value: unknown,
): OperatorResolutionInput {
  if (!uuid.test(distributionId) || !record(value)) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "A valid distribution and JSON resolution are required.",
    );
  }
  const allowed = new Set([
    "confirm",
    "failure_code",
    "provider_post_id",
    "provider_url",
    "reason",
    "resolution",
    "retryable",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "The resolution contains an unsupported field.",
    );
  }
  const resolution = value.resolution;
  if (resolution !== "cancelled" && resolution !== "failed" && resolution !== "published") {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "resolution must be published, failed, or cancelled.",
    );
  }
  if (value.confirm !== `resolve ${distributionId} as ${resolution}`) {
    throw new CoreApiError(
      400,
      "operator_confirmation_required",
      "The exact distribution resolution confirmation is required.",
    );
  }
  const normalizedReason = reason(value.reason);
  const providerPostId =
    typeof value.provider_post_id === "string" ? value.provider_post_id.trim() : null;
  const providerUrl = canonicalUrl(value.provider_url);
  const failureCode =
    typeof value.failure_code === "string" ? value.failure_code.trim().toLowerCase() : null;
  const retryable = value.retryable === true;
  if (
    (resolution === "published" && (!providerPostId || !safeIdentifier.test(providerPostId))) ||
    (resolution !== "published" && (providerPostId || providerUrl)) ||
    (resolution === "failed" && (!failureCode || !safeCode.test(failureCode))) ||
    (resolution !== "failed" && (failureCode !== null || value.retryable !== undefined)) ||
    (value.retryable !== undefined && typeof value.retryable !== "boolean")
  ) {
    throw new CoreApiError(
      400,
      "invalid_operator_resolution",
      "The resolution evidence does not match its terminal state.",
    );
  }
  return {
    failureCode,
    providerPostId,
    providerUrl,
    reason: normalizedReason,
    resolution,
    retryable,
  };
}
