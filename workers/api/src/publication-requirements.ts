import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  ProviderAdapterError,
  ProviderService,
  type ProviderPublicationRequirements,
  type ProviderRegistry,
} from "@meltiply/providers";

import { CoreApiError } from "./core-types";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { tokenCipherFor } from "./token-credentials";

interface PublicationAccountRow extends Record<string, unknown> {
  access_token: string;
  connection_status: string;
  platform: Platform;
  platform_user_id: string;
  revoked_at: Date | string | null;
  token_expires_at: Date | string | null;
}

/**
 * Translates upstream provider adapter error classifications into standardized API error responses.
 *
 * Maps `auth` to 409 `invalid_state`, `deterministic`/`quota` to 422 `unsupported_capability`,
 * `rate_limit` to 429 `provider_rate_limited` (preserving retry-after headers), and transient/timeout errors to 502 `provider_unavailable`.
 *
 * @param cause - ProviderAdapterError thrown by the provider integration layer.
 * @returns Mapped `CoreApiError` with appropriate HTTP status and client message.
 */
function providerFailure(cause: ProviderAdapterError): CoreApiError {
  switch (cause.failure.classification) {
    case "auth":
      return new CoreApiError(409, "invalid_state", "The platform account must be reconnected.");
    case "deterministic":
    case "quota":
      return new CoreApiError(
        422,
        "unsupported_capability",
        "Publishing is not currently available for this creator.",
      );
    case "rate_limit":
      return new CoreApiError(
        429,
        "provider_rate_limited",
        "The provider rate limit has been reached.",
        cause.failure.retryAfterSeconds,
      );
    case "ambiguous":
    case "timeout":
    case "transient":
      return new CoreApiError(
        502,
        "provider_unavailable",
        "The provider is temporarily unavailable.",
      );
  }
}

/**
 * Determines whether a platform account connection is unusable or expired.
 *
 * Checks if the account has been revoked, is in an invalid connection status,
 * or possesses an access token whose expiration timestamp is in the past.
 *
 * @param account - Stored platform account database row.
 * @param now - Current reference timestamp.
 * @returns `true` if the account cannot be used without re-authenticating, otherwise `false`.
 */
function isUnavailable(account: PublicationAccountRow, now: Date): boolean {
  if (account.revoked_at || !["connected", "expiring"].includes(account.connection_status)) {
    return true;
  }
  if (!account.token_expires_at) return false;
  const expiresAt = new Date(account.token_expires_at);
  return !Number.isFinite(expiresAt.getTime()) || expiresAt <= now;
}

/**
 * Fetches dynamic publication requirements and constraints for a connected platform account as an Effect.
 *
 * Queries the platform account under tenant RLS scoping, checks credential validity, decrypts
 * the provider access token, and queries the provider adapter for platform-specific capabilities
 * (such as allowed video durations, aspect ratios, or character limits). Structured provider
 * failures map to the established CoreApiError envelopes via providerFailure().
 * Unexpected provider failures map to 502 and decrypt failures to 503; database failures remain
 * typed DatabaseError. The account lookup composes an Effect tenant transaction,
 * with ProviderService supplied at the route boundary and no nested runners.
 *
 * @param env - Worker environment bindings containing token encryption key.
 * @param session - Authenticated session claims scoping tenant access.
 * @param accountId - Platform account UUID.
 * @param requestId - Trace request ID for downstream provider calls.
 * @param registry - Provider registry containing platform adapter instances.
 * @param now - Optional reference timestamp for testing token validity.
 * @returns Effect resolving to the upstream publication requirements object.
 */
export function getPublicationRequirementsEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  requestId: string,
  registry: ProviderRegistry,
  now = new Date(),
): Effect.Effect<ProviderPublicationRequirements, CoreApiError | DatabaseError, ProviderService> {
  return Effect.gen(function* () {
    const account = yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<PublicationAccountRow>(
          `SELECT platform, platform_user_id, access_token, connection_status,
                    token_expires_at, revoked_at
               FROM platform_accounts
               WHERE id = $1
               LIMIT 1`,
          [accountId],
        );
        return result.rows[0] ?? null;
      }),
    );
    if (!account) {
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The platform account was not found."),
      );
    }
    if (isUnavailable(account, now)) {
      return yield* Effect.fail(
        new CoreApiError(409, "invalid_state", "The platform account must be reconnected."),
      );
    }
    const adapter = registry.get(account.platform);
    if (!adapter?.getPublicationRequirements) {
      return yield* Effect.fail(
        new CoreApiError(
          422,
          "unsupported_capability",
          "Publishing requirements are not available for this platform.",
        ),
      );
    }
    const accessToken = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new CoreApiError(
              503,
              "dependency_unavailable",
              "Platform credentials are temporarily unavailable.",
            ),
      try: () => tokenCipherFor(env).decrypt(account.access_token),
    });
    return yield* Effect.flatMap(ProviderService, (service) =>
      service
        .getPublicationRequirements(
          account.platform,
          {
            operationId: "getPlatformPublishingRequirements",
            requestId,
          },
          {
            accessToken,
            accountId: account.platform_user_id,
          },
        )
        .pipe(
          Effect.catch((cause) => {
            if (
              cause instanceof ProviderAdapterError &&
              cause.failure.code !== "provider_unexpected"
            ) {
              return Effect.fail(providerFailure(cause));
            }
            return Effect.fail(
              new CoreApiError(
                502,
                "provider_unavailable",
                "The provider is temporarily unavailable.",
              ),
            );
          }),
        ),
    );
  });
}
