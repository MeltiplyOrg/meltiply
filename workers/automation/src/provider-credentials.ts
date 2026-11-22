import {
  createIsolateTokenCipherCache,
  TokenCipherUnavailableError,
  type TokenCipher,
} from "@meltiply/secrets";

import type { AutomationEnv } from "./env";

const resolveCipher = createIsolateTokenCipherCache();

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

export function decryptStoredToken(env: AutomationEnv): (storedToken: string) => Promise<string> {
  return (storedToken) => tokenCipherFor(env).decrypt(storedToken);
}
