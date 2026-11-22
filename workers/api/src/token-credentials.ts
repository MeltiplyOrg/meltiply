import {
  createIsolateTokenCipherCache,
  TokenCipherUnavailableError,
  type TokenCipher,
} from "@meltiply/secrets";

import { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";

const resolveTokenCipher = createIsolateTokenCipherCache();

/**
 * Retrieves the isolate-cached `TokenCipher` for OAuth token cryptographic operations.
 *
 * Maps missing or invalid `TOKEN_ENCRYPTION_KEY` configuration to HTTP 503
 * `service_unavailable` at the API boundary.
 *
 * @param env - Worker environment bindings containing `TOKEN_ENCRYPTION_KEY`.
 * @returns Cached `TokenCipher` configured with the primary key.
 * @throws {CoreApiError} 503 when `TOKEN_ENCRYPTION_KEY` is missing or malformed.
 */
export function tokenCipherFor(env: ApiWorkerEnv): TokenCipher {
  try {
    return resolveTokenCipher(env);
  } catch (cause) {
    if (cause instanceof TokenCipherUnavailableError) {
      throw new CoreApiError(503, "service_unavailable", "Token encryption is unavailable.");
    }
    throw cause;
  }
}
