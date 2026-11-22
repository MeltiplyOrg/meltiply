import { randomUUID } from "node:crypto";
import { createHyperdrivePool } from "@meltiply/database";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";
import { createOperatorReconciliationService } from "../src/operator-reconciliation";
import type { OperatorResolutionInput } from "../src/operator-resolution";

const connectionString =
  process.env.MELTIPLY_DATABASE_TEST_URL ??
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";

const adminConnectionString =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const adminPool = createHyperdrivePool({ connectionString: adminConnectionString });

const organizationId = "20000000-0000-4000-8000-0000000000b1";
const profileId = "30000000-0000-4000-8000-0000000000b1";
const channelId = "40000000-0000-4000-8000-0000000000b1";
const postId = "50000000-0000-4000-8000-0000000000b1";
const distributionId = "60000000-0000-4000-8000-0000000000b1";
const installationReportingId = "3a5b7c1d-0e22-4f4b-8f11-2a5b7c1d0e33";

const env = {
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  DEPLOYMENT_CATEGORY: "selfhosted",
  ENVIRONMENT: "test",
  REPORTING_FORCED_OFF: undefined,
  REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
  REPORTING_POSTHOG_PROJECT_TOKEN: "phc_operatorUsageIntegration",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} as ApiWorkerEnv;

async function seedDomain(): Promise<void> {
  const database = adminPool;
  await database.query("DELETE FROM reporting_publication_daily WHERE TRUE");
  await database.query("DELETE FROM reporting_distribution_marks WHERE TRUE");
  await database.query("DELETE FROM reporting_post_marks WHERE TRUE");
  await database.query("DELETE FROM reporting_preferences WHERE TRUE");
  await database.query("DELETE FROM operator_actions WHERE target_id = $1", [distributionId]);
  await database.query("DELETE FROM distributions WHERE id = $1", [distributionId]);
  await database.query("DELETE FROM posts WHERE id = $1", [postId]);
  await database.query("DELETE FROM platform_accounts WHERE id = $1", [channelId]);
  await database.query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
  await database.query("DELETE FROM organizations WHERE id = $1", [organizationId]);

  await database.query(
    `INSERT INTO organizations (id, name, slug, is_shared) VALUES ($1, 'Ops Usage', 'ops-usage', FALSE)`,
    [organizationId],
  );
  await database.query(
    `INSERT INTO brand_profiles (id, org_id, name, color)
     VALUES ($1, $2, 'Ops Usage Profile', '#1d4ed8')`,
    [profileId, organizationId],
  );
  await database.query(
    `INSERT INTO platform_accounts
       (id, org_id, brand_profile_id, platform, platform_user_id, display_name,
        access_token, scopes, connection_status)
     VALUES ($1, $2, $3, 'threads', 'ops-usage-threads', 'Ops Threads',
             'local-only-not-a-provider-credential', ARRAY['threads_basic'], 'connected')`,
    [channelId, organizationId, profileId],
  );
  await database.query(
    `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
     VALUES ($1, $2, $3, 'Ops usage post', 'Caption', 'active')`,
    [postId, organizationId, profileId],
  );
  await database.query(
    `INSERT INTO distributions
       (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
        status, attachment_ids)
     VALUES ($1, $2, $3, $4, $5, 'threads', 'needs_reconciliation', ARRAY[]::uuid[])`,
    [distributionId, organizationId, profileId, postId, channelId],
  );
}

async function enableUsage(intervalStartedAt: Date): Promise<void> {
  await systemPoolFor(env).query(
    `INSERT INTO reporting_preferences (
       id, schema_version,
       usage_requested, usage_disclosure_version, usage_decided_at, usage_interval_started_at,
       diagnostics_requested, diagnostics_disclosure_version, diagnostics_decided_at,
       diagnostics_interval_started_at, installation_reporting_id
     ) VALUES (TRUE, 1, TRUE, 1, now(), $1, FALSE, NULL, NULL, NULL, $2)
     ON CONFLICT (id) DO UPDATE SET
       usage_requested = TRUE,
       usage_disclosure_version = 1,
       usage_interval_started_at = EXCLUDED.usage_interval_started_at,
       installation_reporting_id = EXCLUDED.installation_reporting_id`,
    [intervalStartedAt, installationReportingId],
  );
}

function resolvePublished() {
  const service = createOperatorReconciliationService();
  const input: OperatorResolutionInput = {
    failureCode: null,
    providerPostId: "ops-provider-post-1",
    providerUrl: "https://www.threads.net/@ops/post/1",
    reason: "Operator confirmed the Provider published the Post.",
    resolution: "published",
    retryable: false,
  };
  return Effect.runPromise(
    service.resolveDistribution(
      env,
      { email: "operator@example.test", subject: "operator-subject" },
      distributionId,
      input,
      randomUUID(),
      randomUUID(),
    ),
  );
}

async function dailyDistributions(): Promise<number> {
  const result = await systemPoolFor(env).query<{ distributions: number }>(
    `SELECT distributions FROM reporting_publication_daily
     WHERE platform = 'threads' ORDER BY report_date DESC LIMIT 1`,
  );
  return result.rows[0]?.distributions ?? 0;
}

beforeAll(async () => {
  const url = new URL(connectionString);
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Operator usage tests require the isolated local database.");
  }
  await seedDomain();
});

beforeEach(async () => {
  await seedDomain();
});

afterAll(async () => {
  await systemPoolFor(env).end();
  await adminPool.end();
});

describe("operator-confirmed publication measurement", () => {
  it("counts an operator-confirmed success exactly once", async () => {
    await enableUsage(new Date(Date.now() - 60 * 60 * 1_000));

    const result = await resolvePublished();
    expect(result.status).toBe("published");

    expect(await dailyDistributions()).toBe(1);
    const marks = await systemPoolFor(env).query<{ counted: boolean; post_id: string }>(
      "SELECT post_id, counted FROM reporting_post_marks",
    );
    expect(marks.rows).toEqual([{ counted: true, post_id: postId }]);
  });

  it("counts nothing while usage is not enabled, and never backfills later", async () => {
    const result = await resolvePublished();
    expect(result.status).toBe("published");
    expect(await dailyDistributions()).toBe(0);

    const marks = await systemPoolFor(env).query<{ counted: boolean }>(
      "SELECT counted FROM reporting_post_marks",
    );
    expect(marks.rows).toEqual([{ counted: false }]);
  });

  it("keeps the domain resolution committed when reporting is unavailable", async () => {
    await enableUsage(new Date(Date.now() - 60 * 60 * 1_000));
    await adminPool.query(
      "ALTER TABLE reporting_publication_daily RENAME TO reporting_publication_daily_hidden",
    );
    try {
      const result = await resolvePublished();
      expect(result.status).toBe("published");
      const distribution = await systemPoolFor(env).query<{ status: string }>(
        "SELECT status FROM distributions WHERE id = $1",
        [distributionId],
      );
      expect(distribution.rows[0]!.status).toBe("published");
    } finally {
      await adminPool.query(
        "ALTER TABLE reporting_publication_daily_hidden RENAME TO reporting_publication_daily",
      );
    }
  });
});
