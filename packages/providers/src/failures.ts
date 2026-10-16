import type { ProviderFailure, ProviderFailureClass } from "./types";

export interface ProviderFailureInput {
  code?: string;
  malformedResponse?: boolean;
  /**
   * Set when a safely parsed provider error body proves the rejection is a
   * quota exhaustion (e.g. Google `quotaExceeded`), which must classify as
   * 'quota' rather than the status-derived 'auth' class.
   */
  quotaExceeded?: boolean;
  /**
   * Set when a safely parsed provider error body proves the rejection is a
   * rate limit (e.g. Google `rateLimitExceeded`), which must classify as
   * 'rate_limit' rather than the status-derived 'auth' class.
   */
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  sideEffectPossible?: boolean;
  status?: number;
  timedOut?: boolean;
}

const messages: Readonly<Record<ProviderFailureClass, string>> = {
  ambiguous: "The provider outcome could not be confirmed.",
  auth: "The provider authorization must be refreshed.",
  deterministic: "The provider rejected this request.",
  quota: "The provider quota has been reached.",
  rate_limit: "The provider rate limit has been reached.",
  timeout: "The provider request timed out before an outcome was confirmed.",
  transient: "The provider is temporarily unavailable.",
};

/**
 * Sanitizes an arbitrary provider error code into a lowercase ASCII identifier.
 * Enforces length <= 100 and pattern `[a-z0-9][a-z0-9._-]*` to prevent injection or malformed metrics.
 * Returns the normalized code, or the provided fallback string if invalid or absent.
 */
function safeCode(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized) ? normalized : fallback;
}

/**
 * Validates and bounds a provider-suggested retry delay in seconds.
 * Clamps input between 0 and 86,400 seconds (24 hours) and rejects non-integer numbers.
 * Returns the integer retry delay in seconds, or undefined if absent, negative, or excessive.
 */
function retryAfter(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 0 && value! <= 86_400 ? value : undefined;
}

/**
 * Maps raw provider HTTP status, timeout, and response flags to a semantic failure class.
 * Enforces safety: write requests with possible remote side effects that timeout or return malformed
 * responses are classified as 'ambiguous' to trigger reconciliation rather than blind retry.
 * Parsed-body diagnoses (quotaExceeded, rateLimited) refine status-derived classes so a Google 403
 * quota or rate-limit reason is never mistaken for an authorization failure.
 * Returns one of the seven ProviderFailureClass discriminator strings.
 */
function classification(input: ProviderFailureInput): ProviderFailureClass {
  if (
    input.sideEffectPossible &&
    (input.timedOut || input.malformedResponse || input.status === undefined)
  ) {
    return "ambiguous";
  }
  if (input.timedOut || input.status === 408) return "timeout";
  if (input.quotaExceeded) return "quota";
  if (input.rateLimited) return "rate_limit";
  if (input.status === 401 || input.status === 403) return "auth";
  if (input.status === 402 || input.status === 507) return "quota";
  if (input.status === 429) return "rate_limit";
  if (input.malformedResponse || input.status === undefined || input.status >= 500) {
    return "transient";
  }
  return "deterministic";
}

/**
 * Evaluates whether a classified provider failure is safe and appropriate to retry.
 * Only 'rate_limit', 'timeout', and 'transient' classes are marked retryable;
 * 'auth', 'quota', 'deterministic', and 'ambiguous' require user or manual intervention.
 * Returns true if retryable, false otherwise.
 */
function isRetryable(failureClass: ProviderFailureClass): boolean {
  return (
    failureClass === "rate_limit" || failureClass === "timeout" || failureClass === "transient"
  );
}

/**
 * Normalizes a ProviderFailure object into a standard canonical shape.
 * Ensures consistent error messages, sanitizes code strings, and bounds retry delays according
 * to whether the classification permits retrying.
 * Returns normalized ProviderFailure descriptor.
 */
export function normalizeProviderFailure(failure: ProviderFailure): ProviderFailure {
  const retryable = isRetryable(failure.classification);
  const delay = retryable ? retryAfter(failure.retryAfterSeconds) : undefined;
  return {
    classification: failure.classification,
    code: safeCode(failure.code, `provider_${failure.classification}`),
    message: messages[failure.classification],
    retryable,
    ...(delay === undefined ? {} : { retryAfterSeconds: delay }),
  };
}

/**
 * Classifies raw provider HTTP status and response conditions into a normalized ProviderFailure.
 * Synthesizes classification, canonical human-readable message, sanitized code, and retry metadata.
 * Returns fully normalized ProviderFailure record.
 */
export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  const failureClass = classification(input);
  return normalizeProviderFailure({
    classification: failureClass,
    code: safeCode(input.code, `provider_${failureClass}`),
    message: messages[failureClass],
    retryable: isRetryable(failureClass),
    ...(input.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: input.retryAfterSeconds }),
  });
}

/** Credential-free facts identifying a failed outbound provider request. */
export interface ProviderRequestDiagnostic {
  method: string;
  origin: string;
  status_code?: number;
}

/** Internal causes are serialized only through the shared sanitized logger. */
export interface ProviderAdapterErrorOptions extends ErrorOptions {
  request?: ProviderRequestDiagnostic;
}

export class ProviderAdapterError extends Error {
  readonly failure: ProviderFailure;
  readonly request?: ProviderRequestDiagnostic;

  /**
   * Initializes a new ProviderAdapterError wrapping a canonical provider failure descriptor.
   * Normalizes the input failure and assigns the standard classification message to the Error.
   * Retains an optional non-enumerable cause for the shared logger to sanitize,
   * plus credential-free request metadata; public failure messages stay canonical.
   */
  constructor(failure: ProviderFailure, options?: ProviderAdapterErrorOptions) {
    const normalized = normalizeProviderFailure(failure);
    super(normalized.message, options);
    this.name = "ProviderAdapterError";
    this.failure = normalized;
    this.request = options?.request;
  }
}
