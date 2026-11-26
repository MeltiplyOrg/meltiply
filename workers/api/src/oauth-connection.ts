import { COMMUNITY_LIMITS, DatabaseError } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import type { OAuthConnection } from "@meltiply/providers";
import { Effect } from "effect";

import { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";
import {
  createPostgresOAuthConnectionRepository,
  type OAuthConnectionRepository,
} from "./repositories/oauth-connection-repository";
import { tokenCipherFor } from "./token-credentials";

export interface OAuthConnectionOwner {
  brandProfileId: string;
  organizationId: string;
  userId: string;
}

export interface SaveOAuthConnectionOptions {
  readonly now?: () => Date;
  readonly repository?: OAuthConnectionRepository;
}

function expiresAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("provider token expiry must be an RFC3339 timestamp");
  }
  return parsed;
}

export function saveOAuthConnectionEffect(
  env: ApiWorkerEnv,
  platform: Platform,
  owner: OAuthConnectionOwner,
  connection: OAuthConnection,
  options: SaveOAuthConnectionOptions = {},
): Effect.Effect<void, CoreApiError | DatabaseError> {
  const repository = options.repository ?? createPostgresOAuthConnectionRepository(env);
  const now = options.now ?? (() => new Date());
  return Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        const platformUserId = connection.account.id.trim();
        const accessToken = connection.accessToken.trim();
        if (!platformUserId || !accessToken) {
          throw new TypeError("provider account ID and access token are required");
        }
        return {
          accessToken,
          cipher: tokenCipherFor(env),
          platformUserId,
          refreshToken: connection.refreshToken?.trim(),
          tokenExpiresAt: expiresAt(connection.expiresAt),
        };
      },
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new DatabaseError({
              cause,
              message: "The OAuth connection could not be stored.",
            }),
    });
    const { platformUserId, accessToken, refreshToken, tokenExpiresAt, cipher } = prepared;
    const encryptedAccessToken = yield* Effect.tryPromise({
      try: () => cipher.encrypt(accessToken),
      catch: (cause) =>
        new DatabaseError({
          cause,
          message: "The OAuth connection could not be stored.",
        }),
    });
    const encryptedRefreshToken = refreshToken
      ? yield* Effect.tryPromise({
          try: () => cipher.encrypt(refreshToken),
          catch: (cause) =>
            new DatabaseError({
              cause,
              message: "The OAuth connection could not be stored.",
            }),
        })
      : null;
    const scopes = [
      ...new Set(connection.scopes.map((scope) => scope.trim()).filter(Boolean)),
    ].sort();

    yield* repository.transaction((tx) =>
      Effect.gen(function* () {
        let organizationId = yield* tx.findOrganizationId(owner.organizationId);
        if (!organizationId) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The OAuth organization is no longer available.",
            ),
          );
        }
        const isMember = yield* tx.hasOrganizationMember(organizationId, owner.userId);
        if (!isMember) {
          return yield* Effect.fail(
            new CoreApiError(
              403,
              "forbidden",
              "The OAuth organization is not accessible to this account.",
            ),
          );
        }
        organizationId = yield* tx.lockOrganization(organizationId);
        if (!organizationId) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The OAuth organization is no longer available.",
            ),
          );
        }

        yield* tx.requireActiveBrandProfile(organizationId, owner.brandProfileId);

        const existingRow = yield* tx.findPlatformAccount(platform, platformUserId);
        if (existingRow && existingRow.brand_profile_id !== owner.brandProfileId) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "This platform account is already connected. Disconnect it before connecting it to another brand profile.",
            ),
          );
        }
        if (!existingRow) {
          const hasChannel = yield* tx.hasBrandProfilePlatformChannel(
            owner.brandProfileId,
            platform,
          );
          if (hasChannel) {
            return yield* Effect.fail(
              new CoreApiError(
                409,
                "invalid_state",
                `This Brand Profile is already connected to a ${platform} Channel. Disconnect it before connecting another.`,
              ),
            );
          }
          const limit = COMMUNITY_LIMITS.max_platforms;
          if (limit !== null) {
            const current = yield* tx.countOrganizationPlatformAccounts(organizationId);
            if (current >= limit) {
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "quota_exceeded",
                  `The platform connection limit is reached (${current}/${limit}). Disconnect an account before connecting another.`,
                ),
              );
            }
          }
        }

        const tokenRefreshNextAttemptAt =
          tokenExpiresAt === null
            ? null
            : new Date(
                Math.max(now().getTime() + 3_600_000, tokenExpiresAt.getTime() - 7 * 86_400_000),
              );
        const stored = yield* tx.upsertPlatformAccount({
          avatarUrl: connection.account.avatarUrl?.trim() || null,
          brandProfileId: owner.brandProfileId,
          displayName: connection.account.displayName?.trim() || null,
          encryptedAccessToken,
          encryptedRefreshToken,
          organizationId,
          platform,
          platformUserId,
          scopes,
          tokenExpiresAt,
          tokenRefreshNextAttemptAt,
          userId: owner.userId,
          username: connection.account.username?.trim() || null,
        });
        if (!stored) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "This platform account is already connected. Disconnect it before connecting it to another brand profile.",
            ),
          );
        }
      }),
    );
  });
}
