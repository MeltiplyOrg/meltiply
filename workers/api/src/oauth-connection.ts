import { COMMUNITY_LIMITS, DatabaseError } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";
import type { OAuthConnection } from "@meltiply/providers";
import { Effect } from "effect";

import { requireActiveBrandProfileEffect } from "./brand-profile-guard";
import { CoreApiError } from "./core-types";
import { withSystemTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { lockOrganizationEffect } from "./organization-lock";
import { tokenCipherFor } from "./token-credentials";

export interface OAuthConnectionOwner {
  brandProfileId: string;
  organizationId: string;
  userId: string;
}

/**
 * Parses an optional RFC 3339 timestamp string into a JavaScript `Date`.
 *
 * @param value - Optional RFC 3339 ISO date-time string.
 * @returns Parsed `Date` object, or `null` if value is empty/undefined.
 * @throws {TypeError} If `value` is provided but represents an invalid timestamp.
 */
function expiresAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("provider token expiry must be an RFC3339 timestamp");
  }
  return parsed;
}

/**
 * Persists an authenticated OAuth provider connection into `platform_accounts` as an Effect.
 *
 * Encrypts provider access and refresh tokens using AES-GCM envelope encryption, verifies the
 * Brand Profile pinned in durable OAuth state is still active in the recorded workspace, locks the
 * organization to prevent concurrent limit oversubscription, enforces platform account limits
 * from the community resource policy, and atomically upserts the connection record.
 * Effect transactions retain locking, quota checks and the upsert in one scope.
 * Only encryption crosses Promise boundaries; validation is narrowed before writes.
 * The external (platform, platform_user_id) identity is globally unique: a reconnect to the same
 * Brand Profile refreshes tokens, while an account already attached to another profile or
 * workspace fails 409 until it is locally disconnected. A Brand Profile owns at most one
 * Channel per Provider, so a second account of an already-connected Platform is refused
 * until the existing Channel is disconnected.
 *
 * @param env - Worker environment bindings containing token encryption key.
 * @param platform - Target social provider platform identifier (e.g. `"instagram"`, `"youtube"`).
 * @param owner - Identifiers of the connecting organization, user, and chosen Brand Profile.
 * @param connection - Normalized OAuth credentials and account profile returned by the provider.
 * @returns Effect resolving undefined on upsert, e.g. `Effect<void, CoreApiError | DatabaseError>`.
 */
export function saveOAuthConnectionEffect(
  env: ApiWorkerEnv,
  platform: Platform,
  owner: OAuthConnectionOwner,
  connection: OAuthConnection,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        const platformUserId = connection.account.id.trim();
        const accessToken = connection.accessToken.trim();
        if (!platformUserId || !accessToken) {
          throw new TypeError("provider account ID and access token are required");
        }
        return {
          platformUserId,
          accessToken,
          refreshToken: connection.refreshToken?.trim(),
          tokenExpiresAt: expiresAt(connection.expiresAt),
          cipher: tokenCipherFor(env),
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

    yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const organization = yield* client.query<{
          id: string;
        }>(
          `SELECT id
         FROM organizations
         WHERE id::text = $1`,
          [owner.organizationId],
        );
        let organizationRow = organization.rows[0];
        if (!organizationRow) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The OAuth organization is no longer available.",
            ),
          );
        }
        // The OAuth state record carries the actor-resolved workspace id, but the
        // persistence path re-verifies membership so a replayed or forged state
        // cannot write a connection into a workspace the user does not belong to.
        const membership = yield* client.query<{ role: string }>(
          `SELECT om.role
         FROM org_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1
           AND (u.id::text = $2 OR u.auth_user_id = $2)
         LIMIT 1`,
          [organizationRow.id, owner.userId],
        );
        if (membership.rows.length === 0) {
          return yield* Effect.fail(
            new CoreApiError(
              403,
              "forbidden",
              "The OAuth organization is not accessible to this account.",
            ),
          );
        }
        yield* lockOrganizationEffect(client, organizationRow.id);
        const lockedOrganization = yield* client.query<{
          id: string;
        }>(
          `SELECT id
       FROM organizations WHERE id = $1 FOR UPDATE`,
          [organizationRow.id],
        );
        organizationRow = lockedOrganization.rows[0];
        if (!organizationRow) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The OAuth organization is no longer available.",
            ),
          );
        }

        // The Brand Profile chosen at assignment time must still exist and be
        // active in the workspace at persistence time: a profile deleted
        // mid-handoff must not receive the new Channel.
        yield* requireActiveBrandProfileEffect(client, organizationRow.id, owner.brandProfileId);

        // The external (platform, platform_user_id) identity is globally
        // unique: the same social account cannot attach to another Brand
        // Profile or Workspace until it is locally disconnected.
        const existing = yield* client.query<{
          brand_profile_id: string;
          id: string;
        }>(
          `SELECT id, brand_profile_id
         FROM platform_accounts
         WHERE platform = $1 AND platform_user_id = $2`,
          [platform, platformUserId],
        );
        const existingRow = existing.rows[0];
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
          // One Brand Profile owns at most one Channel per Provider: the
          // profile-scoped index from `017_one_channel_per_provider.sql` is the
          // final arbiter, and this read turns the expected conflict into the
          // same actionable 409 instead of a constraint error.
          const profileChannel = yield* client.query<{ id: string }>(
            `SELECT id
         FROM platform_accounts
         WHERE brand_profile_id = $1 AND platform = $2
         LIMIT 1`,
            [owner.brandProfileId, platform],
          );
          if (profileChannel.rows.length > 0) {
            return yield* Effect.fail(
              new CoreApiError(
                409,
                "invalid_state",
                `This Brand Profile is already connected to a ${platform} Channel. Disconnect it before connecting another.`,
              ),
            );
          }
        }
        if (!existingRow) {
          const limit = COMMUNITY_LIMITS.max_platforms;
          if (limit !== null) {
            const count = yield* client.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM platform_accounts WHERE org_id = $1",
              [organizationRow.id],
            );
            const current = Number(count.rows[0]?.count ?? 0);
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

        // Arm the background token-refresh schedule whenever the provider
        // reported an expiry: `max(now + 1h, expiresAt - 7d)` matches the
        // cadence the refresh worker arms after a successful rotation, and the
        // Due-work sweep claims the row once it enters the delivery horizon
        // (#256). A fresh grant also resets the refresh attempt state so a
        // reconnected account is not throttled by the prior grant's failures.
        const tokenRefreshNextAttemptAt =
          tokenExpiresAt === null
            ? null
            : new Date(Math.max(Date.now() + 3_600_000, tokenExpiresAt.getTime() - 7 * 86_400_000));
        const result = yield* client.query(
          `INSERT INTO platform_accounts (
         org_id, brand_profile_id, platform, platform_user_id, display_name,
         avatar_url, access_token, refresh_token, token_expires_at, scopes,
         metadata, connection_status, last_synced_at, revoked_at, updated_at,
         token_refresh_next_attempt_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         jsonb_build_object('connected_by', $11::text, 'username', $13::text),
         'connected', now(), NULL, now(), $12
       )
       ON CONFLICT (platform, platform_user_id)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, platform_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         metadata = platform_accounts.metadata || EXCLUDED.metadata,
         connection_status = 'connected',
         last_synced_at = now(),
         revoked_at = NULL,
         token_refresh_event_id = NULL,
         token_refresh_lease_expires_at = NULL,
         token_refresh_next_attempt_at = EXCLUDED.token_refresh_next_attempt_at,
         token_refresh_attempt_count = 0,
         token_refresh_last_error = NULL,
         reconnect_notified_at = NULL,
         updated_at = now()
       WHERE platform_accounts.brand_profile_id = EXCLUDED.brand_profile_id
       RETURNING id`,
          [
            organizationRow.id,
            owner.brandProfileId,
            platform,
            platformUserId,
            connection.account.displayName?.trim() || null,
            connection.account.avatarUrl?.trim() || null,
            encryptedAccessToken,
            encryptedRefreshToken,
            tokenExpiresAt,
            scopes,
            owner.userId,
            tokenRefreshNextAttemptAt,
            connection.account.username?.trim() || null,
          ],
        );
        // A raced insert on the same external identity lands here as a
        // no-row upsert when the winner belongs to another profile; the
        // conflict is the same one the pre-check reports.
        if (result.rowCount !== 1)
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "This platform account is already connected. Disconnect it before connecting it to another brand profile.",
            ),
          );
      }),
    );
  });
}
