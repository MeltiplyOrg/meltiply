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

/**
 * Operator reconciliation contract: each method returns an Effect program the
 * operator route boundary executes once via runRouteEffect, keeping transaction
 * work and typed CoreApiError/DatabaseError failures on the Effect channel.
 */
export interface OperatorReconciliationService {
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
