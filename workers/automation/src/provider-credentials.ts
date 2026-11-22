import {
  createIsolateTokenCipherCache,
  TokenCipherUnavailableError,
  type TokenCipher,
} from "@meltiply/secrets";

import type { AutomationEnv } from "./env";

const resolveCipher = createIsolateTokenCipherCache();

/**
 * Retrieves or lazily creates an isolate-cached TokenCipher for provider secret operations.
 * Caches the cipher against the current TOKEN_ENCRYPTION_KEY to avoid rebuilding AES key structures.
 *
 * @param env - Automation worker environment containing TOKEN_ENCRYPTION_KEY.
 * @returns Configured TokenCipher instance.
 * @throws {TypeError} When TOKEN_ENCRYPTION_KEY is not defined or invalid.
 */
export function tokenCipherFor(env: AutomationEnv): TokenCipher {
  try {
    return resolveCipher(env);
  } catch (cause) {
    if (cause instanceof TokenCipherUnavailableError) {
      throw new TypeError("token encryption is unavailable", { cause });
    }
    throw cause;
  }
}

/**
 * Returns a token decryption closure bound to the isolate's TokenCipher.
 * Used across distribution, comment reply, and sync workloads to decrypt stored provider credentials.
 *
 * @param env - Automation worker environment containing TOKEN_ENCRYPTION_KEY.
 * @returns Async function that takes an encrypted token string and resolves to the decrypted plaintext.
 */
export function decryptStoredToken(env: AutomationEnv): (storedToken: string) => Promise<string> {
  return (storedToken) => tokenCipherFor(env).decrypt(storedToken);
}
