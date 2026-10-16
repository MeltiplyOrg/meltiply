import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import { providerIdentifier } from "./meta-common";
import type { ProviderFailure, ProviderOperationResult } from "./types";

/**
 * Convert an invalid provider response into the shared failure taxonomy.
 *
 * Provider adapters use this for both read and write response parsing. A
 * caller can mark a response as side-effect-capable when a malformed payload
 * follows a request that may already have been accepted remotely.
 */
export function malformed(sideEffectPossible = false): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({ malformedResponse: true, sideEffectPossible }),
  );
}

/**
 * Determines whether an unknown error corresponds to an HTTP 404 Not Found from a provider.
 * Used by adapters to detect missing or deleted remote accounts, media, and post resources.
 * Returns true if cause is a ProviderAdapterError with code 'provider_http_404', false otherwise.
 */
export function isHttp404(cause: unknown): boolean {
  return cause instanceof ProviderAdapterError && cause.failure.code === "provider_http_404";
}

/**
 * Add a bounded, positive integer number of seconds to `now` and return the
 * resulting ISO timestamp. A non-integer, non-positive, or over-`maxSeconds`
 * value is a malformed provider token response. Each adapter passes its own
 * provider token-lifetime ceiling.
 */
export function addSeconds(now: Date, value: unknown, maxSeconds: number): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxSeconds) {
    throw malformed();
  }
  return new Date(now.getTime() + value * 1_000).toISOString();
}

/** Build a confirmed-failure result from a provider HTTP code and status. */
export function confirmedFailure(
  code: string,
  status: number,
  providerOperationId?: string,
): Extract<ProviderOperationResult, { outcome: "confirmed_failure" }> {
  return {
    failure: classifyProviderFailure({ code, status }),
    outcome: "confirmed_failure",
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

/**
 * Reclassify a provider failure as an ambiguous "unknown" outcome for a
 * request whose side effect may already have been accepted remotely.
 */
export function unknownResult(
  failure: ProviderFailure,
  providerOperationId?: string,
): Extract<ProviderOperationResult, { outcome: "unknown" }> {
  const ambiguous = classifyProviderFailure({
    code: failure.code,
    sideEffectPossible: true,
  });
  if (ambiguous.classification !== "ambiguous") {
    throw new TypeError("provider failure was not ambiguous");
  }
  return {
    failure: { ...ambiguous, classification: "ambiguous" },
    outcome: "unknown",
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

/**
 * Validate a provider-supplied identifier (account, post, or media id) and
 * return the normalized value, or throw a 400 provider failure under `code`.
 */
export function requiredIdentifier(value: unknown, code: string): string {
  const identifier = providerIdentifier(value);
  if (!identifier) {
    throw new ProviderAdapterError(classifyProviderFailure({ code, status: 400 }));
  }
  return identifier;
}
