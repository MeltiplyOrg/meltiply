import { Effect } from "effect";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import {
  cachedProviderRegistryFromEnvironment,
  createProviderServiceLive,
  type ProviderAccountAnalytics,
  type ProviderRegistry,
  type ProviderRequestContext,
} from "@meltiply/providers";

import { withSystemTransactionEffect } from "./database";
import { decryptStoredToken } from "./provider-credentials";
import { executeProviderAccountAnalyticsEffect } from "./provider-sync-provider";
import type { AutomationEnv } from "./env";

interface AccountRow extends Record<string, unknown> {
  access_token: string | null;
  connection_status: string;
  id: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  token_expires_at: Date | string | null;
}

export interface AccountAnalyticsSweepResult {
  failed: number;
  recorded: number;
  scanned: number;
}

/** Twenty-five accounts per hourly sweep keeps provider reads bounded. */
const sweepBatchSize = 25;
/** Captures and failed attempts both wait six hours before another provider read. */
const sweepIntervalHours = 6;

/**
 * Captures follower history for usable, configured accounts due for measurement.
 * Claims the oldest attempts atomically before provider I/O, so failures and crashes
 * back off for six hours instead of starving later accounts. Expiring credentials
 * wait for the token refresh path. Bounds each sweep to 25 accounts and four reads.
 *
 * @param env - Automation bindings containing the database and provider credentials.
 * @param dependencies - Optional registry override for tests.
 * @returns Effect resolving to scanned/recorded/failed counts.
 */
export function sweepAccountAnalytics(
  env: AutomationEnv,
  dependencies: { providerRegistry?: ProviderRegistry } = {},
): Effect.Effect<AccountAnalyticsSweepResult, never> {
  return Effect.gen(function* () {
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const decryptToken = decryptStoredToken(env);
    const platforms = PLATFORM_IDS.filter(
      (platform) => registry.get(platform)?.getAccountAnalytics,
    );
    if (platforms.length === 0) return { failed: 0, recorded: 0, scanned: 0 };
    const rows = yield* withSystemTransactionEffect(env, (client) =>
      Effect.map(
        client.query<AccountRow>(
          `WITH candidates AS (
             SELECT account.id
             FROM platform_accounts AS account
             JOIN brand_profiles AS profile ON profile.id = account.brand_profile_id
             WHERE account.connection_status = 'connected'
               AND account.platform = ANY($3::text[])
               AND account.access_token IS NOT NULL AND account.access_token <> ''
               AND profile.deleted_at IS NULL
               AND (account.token_expires_at IS NULL OR account.token_expires_at > now())
               AND (account.account_analytics_attempted_at IS NULL
                    OR account.account_analytics_attempted_at <= now() - ($1 * INTERVAL '1 hour'))
               AND NOT EXISTS (
                 SELECT 1
                 FROM platform_account_snapshots AS snapshot
                 WHERE snapshot.platform_account_id = account.id
                   AND snapshot.captured_at > now() - ($1 * INTERVAL '1 hour')
               )
             ORDER BY account.account_analytics_attempted_at NULLS FIRST, account.id
             LIMIT $2
             FOR UPDATE OF account SKIP LOCKED
           )
           UPDATE platform_accounts AS account
           SET account_analytics_attempted_at = now()
           FROM candidates
           WHERE account.id = candidates.id
           RETURNING account.id, account.org_id, account.platform,
                     account.platform_user_id, account.access_token,
                     account.connection_status, account.token_expires_at`,
          [sweepIntervalHours, sweepBatchSize, platforms],
        ),
        (result) => result.rows,
      ),
    );

    const results = yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          if (!row.access_token) return "failed" as const;
          const adapter = registry.get(row.platform);
          if (!adapter?.getAccountAnalytics) return "skipped" as const;
          const context: ProviderRequestContext = {
            operationId: `account-analytics:${row.id}:${Date.now()}`,
            requestId: `account-analytics:${row.id}`,
          };
          const execution = yield* executeProviderAccountAnalyticsEffect(
            registry,
            context,
            {
              connectionStatus: row.connection_status,
              platform: row.platform,
              providerAccountId: row.platform_user_id,
              storedAccessToken: row.access_token,
              tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
            },
            { decryptToken },
          ).pipe(Effect.provide(createProviderServiceLive(registry)));
          if (execution.outcome === "failure") return "failed" as const;
          const account: ProviderAccountAnalytics = execution.account;
          yield* withSystemTransactionEffect(env, (client) =>
            Effect.map(
              client.query(
                `INSERT INTO platform_account_snapshots
                   (platform_account_id, org_id, followers, following, posts,
                    captured_at, raw_data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (platform_account_id, captured_at) DO NOTHING`,
                [
                  row.id,
                  row.org_id,
                  account.followers,
                  account.following ?? null,
                  account.posts ?? null,
                  account.recordedAt,
                  JSON.stringify({ source: "account_analytics" }),
                ],
              ),
              () => "recorded" as const,
            ),
          );
          return "recorded" as const;
        }).pipe(Effect.catch(() => Effect.succeed("failed" as const))),
      { concurrency: 4 },
    );

    return {
      failed: results.filter((result) => result === "failed").length,
      recorded: results.filter((result) => result === "recorded").length,
      scanned: rows.length,
    };
  }).pipe(Effect.catch(() => Effect.succeed({ failed: 0, recorded: 0, scanned: 0 })));
}
