import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
} from "@meltiply/providers";

import { sweepAccountAnalytics } from "../src/account-analytics";
import { systemPoolFor } from "../src/database";
import type { AutomationEnv } from "../src/env";
import { tokenCipherFor } from "../src/provider-credentials";
import { runSystemTransaction } from "./system-transaction";

const organizationId = "9b000000-0000-4000-8000-000000000001";
const env = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "account-analytics-test",
} satisfies AutomationEnv;

/** Fixture accounts sort before seeded accounts; every profile owns one Channel. */
const accountIds = Array.from(
  { length: 32 },
  (_, index) => `01010000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

// The first 25 grants fail. Account 26 must still be captured on the next
// sweep, while expiring, tokenless, expired, deleted-profile, unsupported, and
// recently captured accounts (27–32) must never be claimed.
describe("account analytics sweep with PostgreSQL", () => {
  beforeAll(async () => {
    const encryptedToken = await tokenCipherFor(env).encrypt("account-analytics-fixture-token");
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug, plan, billing_status)
         VALUES ($1, 'Account analytics fixture', 'account-analytics-fixture', 'creator', 'free')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color, deleted_at, purge_at)
         SELECT ('9b100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
                $1, 'Account analytics ' || n, '#1d4ed8',
                CASE WHEN n = 30 THEN now() ELSE NULL END,
                CASE WHEN n = 30 THEN now() + INTERVAL '7 days' ELSE NULL END
         FROM generate_series(1, 32) AS n`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            access_token, connection_status, token_expires_at)
         SELECT ('01010000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
                $1, ('9b100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
                CASE WHEN n = 31 THEN 'youtube' ELSE 'threads' END,
                'account-analytics-review-' || n,
                CASE WHEN n = 28 THEN '' ELSE $2 END,
                CASE WHEN n = 27 THEN 'expiring' ELSE 'connected' END,
                CASE WHEN n = 29 THEN now() - INTERVAL '1 hour' ELSE NULL END
         FROM generate_series(1, 32) AS n`,
        [organizationId, encryptedToken],
      );
      await client.query(
        `INSERT INTO platform_account_snapshots
           (platform_account_id, org_id, followers, captured_at)
         VALUES ($1, $2, 100, now())`,
        [accountIds[31], organizationId],
      );
    });
  });

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
    });
    await systemPoolFor(env).end();
  });

  it("rotates past a failed full batch and backs off failures without inventing captures", async () => {
    const reads: string[] = [];
    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: null,
        max_media_count: null,
        max_video_duration_sec: null,
        min_media_count: null,
        multi_asset_types: [],
        notes: [],
        platform: "threads",
        publish: false,
        reply: false,
      },
      getAccountAnalytics: async (_context, credentials) => {
        const id = credentials.accountId ?? "";
        reads.push(id);
        if (id !== "account-analytics-review-26") {
          throw new ProviderAdapterError(
            classifyProviderFailure({ code: "permission_denied", status: 403 }),
          );
        }
        return { followers: 777, recordedAt: new Date().toISOString() };
      },
      transferModes: [],
    });
    const dependencies = { providerRegistry: registry };
    expect(await Effect.runPromise(sweepAccountAnalytics(env, dependencies))).toEqual({
      failed: 25,
      recorded: 0,
      scanned: 25,
    });
    const next = await Effect.runPromise(sweepAccountAnalytics(env, dependencies));
    expect(next.recorded).toBe(1);
    await Effect.runPromise(sweepAccountAnalytics(env, dependencies));
    // The system sweep also services seeded Workspaces; only this fixture's
    // identities belong to the assertions about its grant failures and exclusions.
    expect(reads.filter((id) => id.startsWith("account-analytics-review-")).sort()).toEqual(
      Array.from({ length: 26 }, (_, index) => `account-analytics-review-${index + 1}`).sort(),
    );
    await runSystemTransaction(env, async (client) => {
      const attempts = await client.query<{ id: string }>(
        `SELECT id FROM platform_accounts WHERE org_id = $1
           AND account_analytics_attempted_at IS NOT NULL ORDER BY id`,
        [organizationId],
      );
      expect(attempts.rows.map((row) => row.id)).toEqual(accountIds.slice(0, 26));
      const captures = await client.query<{ followers: string; following: string | null }>(
        `SELECT followers::text, following::text FROM platform_account_snapshots
         WHERE org_id = $1 AND platform_account_id = $2`,
        [organizationId, accountIds[25]],
      );
      expect(captures.rows).toEqual([{ followers: "777", following: null }]);
      const failedCaptures = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM platform_account_snapshots
         WHERE platform_account_id = ANY($1::uuid[])`,
        [accountIds.slice(0, 25)],
      );
      expect(failedCaptures.rows[0]?.count).toBe("0");
    });
  });
});
