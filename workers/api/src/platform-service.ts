import { Effect } from "effect";
import type { components } from "@meltiply/contracts/schema";
import type { SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  accountStatus,
  type DatabaseError,
  isoDateTime,
  isoDateTimeOrNull,
  PLATFORM_IDS,
  rateLimitBudgetFreshSeconds,
} from "@meltiply/domain";

import { CoreApiError } from "./api-errors";
import { activeBrandProfilePredicate } from "./brand-profile-guard";
import type { CoreServiceError, IdempotentResult } from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect as defaultTenantTransaction,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { withIdempotentMutation } from "./idempotent-mutation";

type Schemas = components["schemas"];
type Platform = Schemas["Platform"];
type PlatformAccount = Schemas["PlatformAccount"];
type PlatformCapability = Schemas["PlatformCapability"];

export interface DisconnectableAccountRow extends Record<string, unknown> {
  access_token: string;
  brand_profile_id: string;
  id: string;
  platform: string;
}

interface PlatformAccountRow extends Record<string, unknown> {
  avatar_url: string | null;
  brand_profile_id: string;
  connection_status: Schemas["ConnectionStatus"];
  created_at: Date | string;
  display_name: string | null;
  id: string;
  last_synced_at: Date | string | null;
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  rate_limit_percent_used: number | null;
  rate_limit_remaining: number | null;
  rate_limit_resets_at: Date | string | null;
  revoked_at: Date | string | null;
  scopes: string[] | null;
  token_expires_at: Date | string | null;
  updated_at: Date | string;
  username?: string | null;
}

function mapPlatformAccount(
  row: PlatformAccountRow,
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
): PlatformAccount {
  const budget =
    row.rate_limit_remaining !== null || row.rate_limit_percent_used !== null
      ? {
          percent_used: row.rate_limit_percent_used,
          remaining: row.rate_limit_remaining,
          resets_at: isoDateTimeOrNull(row.rate_limit_resets_at),
        }
      : null;
  return {
    avatar_url: row.avatar_url,
    brand_profile_id: row.brand_profile_id,
    capabilities: structuredClone(capabilities.get(row.platform)!),
    connection_status: accountStatus(row),
    created_at: isoDateTime(row.created_at),
    display_name: row.display_name,
    id: row.id,
    last_synced_at: isoDateTimeOrNull(row.last_synced_at),
    org_id: row.org_id,
    platform: row.platform,
    platform_user_id: row.platform_user_id,
    rate_limit_budget: budget,
    scopes: row.scopes ?? [],
    token_expires_at: isoDateTimeOrNull(row.token_expires_at),
    username: (row.username as string | null) ?? null,
    updated_at: isoDateTime(row.updated_at),
  };
}

export function disconnectPlatformAccountsEffect(
  client: EffectTransactionClient,
  organizationId: string,
  accounts: readonly DisconnectableAccountRow[],
): Effect.Effect<void, DatabaseError> {
  if (accounts.length === 0) return Effect.void;
  const accountIds = accounts.map((account) => account.id);
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE distributions
       SET status = 'cancelled',
           error_message = 'Platform account disconnected before publication.',
           updated_at = now()
       WHERE platform_account_id = ANY($1::uuid[])
         AND status IN ('scheduled', 'queued')`,
      [accountIds],
    );
    yield* client.query("DELETE FROM platform_accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    yield* client.query(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       SELECT $1::uuid,
              'channel.revocation.requested',
              'platform_account',
              selected.id,
              'channel-revocation:' || selected.id::text,
              jsonb_build_object(
                'access_token', selected.access_token,
                'brand_profile_id', selected.brand_profile_id,
                'platform', selected.platform,
                'platform_account_id', selected.id,
                'version', 1
              )
         FROM jsonb_to_recordset($2::jsonb) AS selected(
                id uuid,
                brand_profile_id uuid,
                platform text,
                access_token text
              )
       ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING`,
      [organizationId, JSON.stringify(accounts)],
    );
  });
}

export function createPlatformMethods(
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
  withTenantTransactionEffect = defaultTenantTransaction,
) {
  return {
    platformCapabilities(): PlatformCapability[] {
      return PLATFORM_IDS.map((platform) => structuredClone(capabilities.get(platform)!));
    },

    listPlatformAccounts(
      env: ApiWorkerEnv,
      session: SessionClaims,
      brandProfileId?: string,
    ): Effect.Effect<PlatformAccount[], CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<PlatformAccountRow>(
            `SELECT
               pa.id, pa.org_id, pa.brand_profile_id, pa.platform,
               pa.platform_user_id, pa.display_name, pa.avatar_url,
               pa.username,
               pa.connection_status, pa.token_expires_at, pa.last_synced_at,
               pa.revoked_at,
               COALESCE(pa.scopes, ARRAY[]::text[]) AS scopes,
               pa.created_at, pa.updated_at,
               rlb.remaining AS rate_limit_remaining,
               rlb.percent_used AS rate_limit_percent_used,
               rlb.resets_at AS rate_limit_resets_at
             FROM platform_accounts pa
             LEFT JOIN rate_limit_budgets rlb
               ON rlb.platform = pa.platform
               AND rlb.account_id = pa.platform_user_id
               AND rlb.updated_at > now() - ($1 * INTERVAL '1 second')
             WHERE ($2::uuid IS NULL OR pa.brand_profile_id = $2)
               AND ${activeBrandProfilePredicate("pa.brand_profile_id")}
             ORDER BY pa.created_at ASC, pa.id ASC`,
            [rateLimitBudgetFreshSeconds, brandProfileId ?? null],
          );
          return result.rows.map((row) => mapPlatformAccount(row, capabilities));
        }),
      );
    },

    disconnectPlatform(
      env: ApiWorkerEnv,
      session: SessionClaims,
      accountId: string,
      idempotencyKey: string,
    ): Effect.Effect<IdempotentResult<undefined>, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(accountId);
        const result = yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            return yield* withIdempotentMutation<null, CoreServiceError>(
              client,
              organizationId,
              "disconnect-platform",
              idempotencyKey,
              requestHash,
              204,
              (tx) =>
                Effect.gen(function* () {
                  const account = yield* tx.query<DisconnectableAccountRow>(
                    `SELECT id, brand_profile_id, platform, access_token
                     FROM platform_accounts
                     WHERE id = $1`,
                    [accountId],
                  );
                  const accountRow = account.rows[0];
                  if (!accountRow) {
                    return yield* Effect.fail(
                      new CoreApiError(404, "not_found", "The platform account was not found."),
                    );
                  }
                  yield* disconnectPlatformAccountsEffect(tx, organizationId, [accountRow]);
                  return null;
                }),
            );
          }),
        );
        return { replayed: result.replayed, value: undefined };
      });
    },
  };
}
