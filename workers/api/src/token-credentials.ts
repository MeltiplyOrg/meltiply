import { TokenCipher } from "@meltiply/secrets";

import { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";

let cachedCipher: TokenCipher | undefined;
let cachedKey: string | undefined;

/**
 * Retrieves or initializes an isolate-cached TokenCipher for OAuth token cryptographic operations.
 *
 * Encrypts and decrypts provider access and refresh tokens stored in `platform_accounts`.
 * Reuses the cipher across requests within the Worker isolate unless the encryption key changes.
 *
 * **Key replacement safety**: Both the API and Automation workers configure only one primary
 * key (`currentKeyId: "primary"`). Replacing `TOKEN_ENCRYPTION_KEY` immediately makes all
 * existing ciphertext undecryptable — token refresh, publication, and analytics sync will fail
 * with decryption errors. Before rotating the key:
 * 1. Pause Queue delivery and scheduled triggers to stop background decryption attempts.
 * 2. Either re-encrypt all `platform_accounts.encrypted_*` columns under the new key while
 *    the old key is still available, or accept that existing OAuth grants are invalidated
 *    and trigger an OAuth reconnect flow for all affected accounts.
 * 3. Deploy the new key and resume queue delivery.
 *
 * @param env - Worker environment bindings containing `TOKEN_ENCRYPTION_KEY`.
 * @returns Initialized `TokenCipher` instance configured with the primary key.
 * @throws {CoreApiError} 503 if `TOKEN_ENCRYPTION_KEY` binding is not configured.
 */
export function tokenCipherFor(env: ApiWorkerEnv): TokenCipher {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new CoreApiError(503, "service_unavailable", "Token encryption is unavailable.");
  }
  if (!cachedCipher || cachedKey !== env.TOKEN_ENCRYPTION_KEY) {
    cachedKey = env.TOKEN_ENCRYPTION_KEY;
    cachedCipher = new TokenCipher({
      currentKeyId: "primary",
      keys: [{ id: "primary", material: cachedKey }],
    });
  }
  return cachedCipher;
}
