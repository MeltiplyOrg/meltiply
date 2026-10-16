import type { SessionClaims } from "@meltiply/auth";
import { DatabaseError } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  ProviderService,
  type ProviderAdapterError,
  type ProviderRegistry,
} from "@meltiply/providers";
import type { CoreApiError } from "./core-types";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { tokenCipherFor } from "./token-credentials";

interface RevocableAccountRow extends Record<string, unknown> {
  access_token: string;
  platform: Platform;
}

/**
 * Performs upstream OAuth token revocation with the third-party social provider as an Effect.
 *
 * Resolves the platform account within an Effect tenant transaction to ensure RLS compliance,
 * then revokes exactly once when the adapter supports it — no retry, since a timed-out
 * revoke may already have committed remotely and blind retry could double-side-effect.
 * Missing accounts and adapters without revoke support succeed silently; decrypt and
 * database failures surface as typed DatabaseError failures for the caller to log.
 * Composes inside the route's single Effect program (ProviderService provided at the
 * boundary); never runs nested Effects itself.
 *
 * @param env - Worker environment bindings containing token encryption key.
 * @param session - Authenticated user session claims scoping access to the account.
 * @param accountId - Platform account UUID to revoke.
 * @param registry - Provider registry containing platform adapter instances.
 * @returns Effect resolving undefined, e.g. `Effect<void, DatabaseError, ProviderService>`.
 */
export function revokeOAuthConnectionEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  registry: ProviderRegistry,
): Effect.Effect<void, CoreApiError | DatabaseError | ProviderAdapterError, ProviderService> {
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
