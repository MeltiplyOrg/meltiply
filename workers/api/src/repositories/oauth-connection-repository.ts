import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { requireActiveBrandProfileEffect } from "../brand-profile-guard";
import { CoreApiError } from "../api-errors";
import { withSystemTransactionEffect } from "../database";
import type { ApiWorkerEnv } from "../env";
import { lockOrganizationEffect } from "../organization-lock";

interface OAuthConnectionUpsert {
  readonly avatarUrl: string | null;
  readonly brandProfileId: string;
  readonly displayName: string | null;
  readonly encryptedAccessToken: string;
  readonly encryptedRefreshToken: string | null;
  readonly organizationId: string;
  readonly platform: Platform;
  readonly platformUserId: string;
  readonly scopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
  readonly tokenRefreshNextAttemptAt: Date | null;
  readonly userId: string;
  readonly username: string | null;
}

interface OAuthConnectionTransaction {
  readonly findOrganizationId: (
    organizationId: string,
  ) => Effect.Effect<string | null, DatabaseError>;
  readonly hasOrganizationMember: (
    organizationId: string,
    userId: string,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly lockOrganization: (
    organizationId: string,
  ) => Effect.Effect<string | null, DatabaseError>;
  readonly requireActiveBrandProfile: (
    organizationId: string,
    brandProfileId: string,
  ) => Effect.Effect<void, CoreApiError | DatabaseError>;
  readonly findPlatformAccount: (
    platform: Platform,
    platformUserId: string,
  ) => Effect.Effect<
    { readonly brand_profile_id: string; readonly id: string } | null,
    DatabaseError
  >;
  readonly hasBrandProfilePlatformChannel: (
    brandProfileId: string,
    platform: Platform,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly countOrganizationPlatformAccounts: (
    organizationId: string,
  ) => Effect.Effect<number, DatabaseError>;
  readonly upsertPlatformAccount: (
    input: OAuthConnectionUpsert,
  ) => Effect.Effect<boolean, DatabaseError>;
}

export interface OAuthConnectionRepository {
  readonly transaction: <A, E>(
    operation: (tx: OAuthConnectionTransaction) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DatabaseError>;
}

export function createPostgresOAuthConnectionRepository(
  env: ApiWorkerEnv,
): OAuthConnectionRepository {
  return {
    transaction: (operation) =>
      withSystemTransactionEffect(env, (client) =>
        operation({
          findOrganizationId: (organizationId) =>
            Effect.map(
              client.query<{ id: string }>(
                `SELECT id
                 FROM organizations
                 WHERE id::text = $1`,
                [organizationId],
              ),
              (result) => result.rows[0]?.id ?? null,
            ),

          hasOrganizationMember: (organizationId, userId) =>
            Effect.map(
              client.query<{ role: string }>(
                `SELECT om.role
                 FROM org_members om
                 JOIN users u ON u.id = om.user_id
                 WHERE om.org_id = $1
                   AND (u.id::text = $2 OR u.auth_user_id = $2)
                 LIMIT 1`,
                [organizationId, userId],
              ),
              (result) => result.rows.length > 0,
            ),

          lockOrganization: (organizationId) =>
            Effect.gen(function* () {
              yield* lockOrganizationEffect(client, organizationId);
              const locked = yield* client.query<{ id: string }>(
                "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
                [organizationId],
              );
              return locked.rows[0]?.id ?? null;
            }),

          requireActiveBrandProfile: (organizationId, brandProfileId) =>
            requireActiveBrandProfileEffect(client, organizationId, brandProfileId),

          findPlatformAccount: (platform, platformUserId) =>
            Effect.map(
              client.query<{ brand_profile_id: string; id: string }>(
                `SELECT id, brand_profile_id
                 FROM platform_accounts
                 WHERE platform = $1 AND platform_user_id = $2`,
                [platform, platformUserId],
              ),
              (result) => result.rows[0] ?? null,
            ),

          hasBrandProfilePlatformChannel: (brandProfileId, platform) =>
            Effect.map(
              client.query<{ id: string }>(
                `SELECT id
                 FROM platform_accounts
                 WHERE brand_profile_id = $1 AND platform = $2
                 LIMIT 1`,
                [brandProfileId, platform],
              ),
              (result) => result.rows.length > 0,
            ),

          countOrganizationPlatformAccounts: (organizationId) =>
            Effect.map(
              client.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM platform_accounts WHERE org_id = $1",
                [organizationId],
              ),
              (result) => Number(result.rows[0]?.count ?? 0),
            ),

          upsertPlatformAccount: (input) =>
            Effect.map(
              client.query(
                `INSERT INTO platform_accounts (
                   org_id, brand_profile_id, platform, platform_user_id, display_name,
                   avatar_url, access_token, refresh_token, token_expires_at, scopes,
                   metadata, connection_status, last_synced_at, revoked_at, updated_at,
                   token_refresh_next_attempt_at, username
                 )
                 VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   jsonb_build_object('connected_by', $11::text),
                   'connected', now(), NULL, now(), $12, $13
                 )
                 ON CONFLICT (platform, platform_user_id)
                 DO UPDATE SET
                   display_name = EXCLUDED.display_name,
                   avatar_url = EXCLUDED.avatar_url,
                   username = EXCLUDED.username,
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
                  input.organizationId,
                  input.brandProfileId,
                  input.platform,
                  input.platformUserId,
                  input.displayName,
                  input.avatarUrl,
                  input.encryptedAccessToken,
                  input.encryptedRefreshToken,
                  input.tokenExpiresAt,
                  input.scopes,
                  input.userId,
                  input.tokenRefreshNextAttemptAt,
                  input.username,
                ],
              ),
              (result) => result.rowCount === 1,
            ),
        }),
      ),
  };
}

export interface FakeOAuthPlatformAccount extends OAuthConnectionUpsert {
  id: string;
}

export class FakeOAuthConnectionStore {
  readonly organizations = new Set<string>();
  readonly members = new Set<string>();
  readonly brandProfiles = new Map<string, { deletedAt: string | null; organizationId: string }>();
  accounts: FakeOAuthPlatformAccount[] = [];
  nextCommitFailure: DatabaseError | null = null;
  private sequence = 0;

  memberKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  nextAccountId(): string {
    this.sequence += 1;
    return `account-${this.sequence}`;
  }
}

export function createFakeOAuthConnectionRepository(
  store: FakeOAuthConnectionStore,
): OAuthConnectionRepository {
  const tx: OAuthConnectionTransaction = {
    findOrganizationId: (organizationId) =>
      Effect.sync(() => (store.organizations.has(organizationId) ? organizationId : null)),

    hasOrganizationMember: (organizationId, userId) =>
      Effect.sync(() => store.members.has(store.memberKey(organizationId, userId))),

    lockOrganization: (organizationId) =>
      Effect.sync(() => (store.organizations.has(organizationId) ? organizationId : null)),

    requireActiveBrandProfile: (organizationId, brandProfileId) =>
      Effect.gen(function* () {
        const profile = store.brandProfiles.get(brandProfileId);
        if (!profile || profile.organizationId !== organizationId) {
          return yield* Effect.fail(
            new CoreApiError(404, "brand_profile_not_found", "The brand profile was not found."),
          );
        }
        if (profile.deletedAt !== null) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "brand_profile_deleted",
              "The brand profile is deleted and cannot accept new data.",
            ),
          );
        }
      }),

    findPlatformAccount: (platform, platformUserId) =>
      Effect.sync(() => {
        const match = store.accounts.find(
          (row) => row.platform === platform && row.platformUserId === platformUserId,
        );
        return match ? { brand_profile_id: match.brandProfileId, id: match.id } : null;
      }),

    hasBrandProfilePlatformChannel: (brandProfileId, platform) =>
      Effect.sync(() =>
        store.accounts.some(
          (row) => row.brandProfileId === brandProfileId && row.platform === platform,
        ),
      ),

    countOrganizationPlatformAccounts: (organizationId) =>
      Effect.sync(
        () => store.accounts.filter((row) => row.organizationId === organizationId).length,
      ),

    upsertPlatformAccount: (input) =>
      Effect.sync(() => {
        const existingIndex = store.accounts.findIndex(
          (row) => row.platform === input.platform && row.platformUserId === input.platformUserId,
        );
        if (existingIndex >= 0) {
          const existing = store.accounts[existingIndex]!;
          if (existing.brandProfileId !== input.brandProfileId) return false;
          store.accounts[existingIndex] = {
            ...input,
            encryptedRefreshToken: input.encryptedRefreshToken ?? existing.encryptedRefreshToken,
            id: existing.id,
          };
          return true;
        }
        store.accounts.push({ ...input, id: store.nextAccountId() });
        return true;
      }),
  };

  return {
    transaction: (operation) =>
      Effect.gen(function* () {
        const saved = structuredClone(store.accounts);
        const result = yield* operation(tx).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              store.accounts = saved;
            }),
          ),
        );
        if (store.nextCommitFailure) {
          const failure = store.nextCommitFailure;
          store.nextCommitFailure = null;
          store.accounts = saved;
          return yield* Effect.fail(failure);
        }
        return result;
      }),
  };
}
