import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "../database";
import type { AutomationEnv } from "../env";

export interface AccountAnalyticsCandidate extends Record<string, unknown> {
  access_token: string | null;
  connection_status: string;
  id: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  token_expires_at: Date | string | null;
}

export interface AccountAnalyticsSnapshotInsert {
  readonly capturedAt: string;
  readonly followers: number | null;
  readonly following: number | null;
  readonly orgId: string;
  readonly platformAccountId: string;
  readonly posts: number | null;
}

export interface AccountAnalyticsRepository {
  readonly claimCandidates: (
    intervalHours: number,
    batchSize: number,
    platforms: readonly Platform[],
  ) => Effect.Effect<AccountAnalyticsCandidate[], DatabaseError>;
  readonly recordSnapshot: (
    snapshot: AccountAnalyticsSnapshotInsert,
  ) => Effect.Effect<void, DatabaseError>;
}

export function createPostgresAccountAnalyticsRepository(
  env: AutomationEnv,
): AccountAnalyticsRepository {
  return {
    claimCandidates: (intervalHours, batchSize, platforms) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.map(
          client.query<AccountAnalyticsCandidate>(
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
            [intervalHours, batchSize, platforms],
          ),
          (result) => result.rows,
        ),
      ),

    recordSnapshot: (snapshot) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.asVoid(
          client.query(
            `INSERT INTO platform_account_snapshots
               (platform_account_id, org_id, followers, following, posts,
                captured_at, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (platform_account_id, captured_at) DO NOTHING`,
            [
              snapshot.platformAccountId,
              snapshot.orgId,
              snapshot.followers,
              snapshot.following,
              snapshot.posts,
              snapshot.capturedAt,
              JSON.stringify({ source: "account_analytics" }),
            ],
          ),
        ),
      ),
  };
}

export class FakeAccountAnalyticsStore {
  candidates: AccountAnalyticsCandidate[] = [];
  readonly snapshots: AccountAnalyticsSnapshotInsert[] = [];
  claimError: DatabaseError | null = null;
}

export function createFakeAccountAnalyticsRepository(
  store: FakeAccountAnalyticsStore,
): AccountAnalyticsRepository {
  return {
    claimCandidates: (_intervalHours, batchSize, platforms) =>
      store.claimError
        ? Effect.fail(store.claimError)
        : Effect.sync(() =>
            store.candidates
              .filter((row) => platforms.includes(row.platform))
              .slice(0, batchSize)
              .map((row) => structuredClone(row)),
          ),

    recordSnapshot: (snapshot) =>
      Effect.sync(() => {
        store.snapshots.push(snapshot);
      }),
  };
}
