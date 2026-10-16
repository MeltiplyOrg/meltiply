import { Effect } from "effect";
import { DomainError, type RequestContext } from "@meltiply/domain";
import { ProviderAdapterError } from "@meltiply/providers";

import { CoreApiError } from "../core-types";

/**
 * Lifts one sync or async route step into an Effect program.
 *
 * Preserves typed failures (CoreApiError, DomainError, ProviderAdapterError) on the
 * failure channel so the boundary maps them to the existing HTTP error envelope;
 * unexpected throws escape as defects so they take the 500 internal_error path with
 * diagnostics instead of being misclassified as typed client errors. Covers sync
 * validation helpers (uuidParam, jsonBody, enumParam) and async service calls alike
 * by awaiting the step inside the async wrapper, so each route executes exactly one
 * Effect program beneath the transport boundary.
 *
 * @param operation - Sync or async route step, e.g. `() => uuidParam(...)`.
 * @returns Effect program resolving to the step value, e.g. `Effect<string, CoreApiError>`.
 */
export function fromPromise<A>(
  operation: () => Promise<A> | A,
): Effect.Effect<A, CoreApiError | DomainError | ProviderAdapterError, RequestContext> {
  return Effect.tryPromise({
    catch: (cause) => {
      if (
        cause instanceof CoreApiError ||
        cause instanceof DomainError ||
        cause instanceof ProviderAdapterError
      ) {
        return cause;
      }
      throw cause;
    },
    try: async () => operation(),
  });
}
