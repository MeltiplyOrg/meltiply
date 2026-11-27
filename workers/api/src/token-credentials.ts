import {
  createIsolateTokenCipherCache,
  TokenCipherUnavailableError,
  type TokenCipher,
} from "@meltiply/secrets";

import { CoreApiError } from "./api-errors";
import type { ApiWorkerEnv } from "./env";

const resolveTokenCipher = createIsolateTokenCipherCache();

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
