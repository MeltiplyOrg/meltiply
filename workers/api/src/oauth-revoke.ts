import type { SessionClaims } from "@meltiply/auth";
import { DatabaseError } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  ProviderService,
  type ProviderAdapterError,
  type ProviderRegistry,
} from "@meltiply/providers";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { tokenCipherFor } from "./token-credentials";

interface RevocableAccountRow extends Record<string, unknown> {
  access_token: string;
  platform: Platform;
}

export function revokeOAuthConnectionEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  registry: ProviderRegistry,
): Effect.Effect<void, DatabaseError | ProviderAdapterError, ProviderService> {
  return Effect.gen(function* () {
    const account = yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<RevocableAccountRow>(
          `SELECT platform, access_token
               FROM platform_accounts
               WHERE id = $1
               LIMIT 1`,
          [accountId],
        );
        return result.rows[0] ?? null;
      }),
    );
    if (!account) return;
    const adapter = registry.get(account.platform);
    if (!adapter?.revoke) return;
    const accessToken = yield* Effect.tryPromise({
      catch: (cause) =>
        new DatabaseError({
          cause,
          message: "Platform credentials are temporarily unavailable.",
        }),
      try: () => tokenCipherFor(env).decrypt(account.access_token),
    });
    yield* Effect.flatMap(ProviderService, (service) =>
      service.revoke(account.platform, accessToken),
    );
  });
}
