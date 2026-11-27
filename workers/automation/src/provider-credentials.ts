import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
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

export function nextTokenRefreshAt(expiresAt: Date | null, now: Date): Date | null {
  return expiresAt !== null
    ? new Date(Math.max(now.getTime() + 3_600_000, expiresAt.getTime() - 7 * 86_400_000))
    : null;
}

export function encryptRotatedTokens(
  env: AutomationEnv,
  tokens: { accessToken: string; refreshToken?: string },
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const cipher = tokenCipherFor(env);
  return Promise.all([
    cipher.encrypt(tokens.accessToken),
    tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : Promise.resolve(null),
  ]).then(([accessToken, refreshToken]) => ({ accessToken, refreshToken }));
}

export function persistRotatedPlatformTokens(
  client: EffectTransactionClient,
  input: {
    accessToken: string;
    expectedEventId?: string;
    expectedTokenExpiresAt: Date | string | null;
    expiresAt: Date | null;
    nextAttemptAt: Date | null;
    nextEventId?: string | null;
    platformAccountId: string;
    refreshToken: string | null;
    scopes: string[] | null;
  },
): Effect.Effect<boolean, DatabaseError> {
  if (input.expectedEventId !== undefined) {
    return Effect.gen(function* () {
      const updated = yield* client.query(
        `UPDATE platform_accounts
           SET access_token = $3,
               refresh_token = COALESCE($4, refresh_token),
               token_expires_at = $5,
               scopes = COALESCE($6::text[], scopes),
               connection_status = 'connected', last_synced_at = now(),
               token_refresh_event_id = $8::uuid,
               token_refresh_lease_expires_at = NULL,
               token_refresh_next_attempt_at = $9::timestamptz,
               token_refresh_attempt_count = 0,
               token_refresh_last_error = NULL,
               reconnect_notified_at = NULL, updated_at = now()
           WHERE id = $1 AND token_refresh_event_id = $2::uuid
             AND token_expires_at IS NOT DISTINCT FROM $7::timestamptz`,
        [
          input.platformAccountId,
          input.expectedEventId,
          input.accessToken,
          input.refreshToken,
          input.expiresAt,
          input.scopes,
          input.expectedTokenExpiresAt,
          input.nextEventId ?? null,
          input.nextAttemptAt,
        ],
      );
      if (updated.rowCount === 0) {
        yield* client.query(
          `UPDATE platform_accounts
             SET token_refresh_event_id = NULL,
                 token_refresh_lease_expires_at = NULL, updated_at = now()
             WHERE id = $1 AND token_refresh_event_id = $2::uuid`,
          [input.platformAccountId, input.expectedEventId],
        );
        return false;
      }
      return true;
    });
  }
  return client
    .query(
      `UPDATE platform_accounts
         SET access_token = $2,
             refresh_token = COALESCE($3, refresh_token),
             token_expires_at = $4,
             scopes = COALESCE($5::text[], scopes),
             connection_status = 'connected', last_synced_at = now(),
             token_refresh_event_id = NULL,
             token_refresh_lease_expires_at = NULL,
             token_refresh_next_attempt_at = $6::timestamptz,
             token_refresh_attempt_count = 0,
             token_refresh_last_error = NULL,
             reconnect_notified_at = NULL, updated_at = now()
         WHERE id = $1
           AND connection_status <> 'revoked'
           AND token_expires_at IS NOT DISTINCT FROM $7::timestamptz`,
      [
        input.platformAccountId,
        input.accessToken,
        input.refreshToken,
        input.expiresAt,
        input.scopes,
        input.nextAttemptAt,
        input.expectedTokenExpiresAt,
      ],
    )
    .pipe(Effect.map((updated) => updated.rowCount === 1));
}
