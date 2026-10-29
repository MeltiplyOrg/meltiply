import type { JwtIdentity } from "@meltiply/auth";
import type { TransactionClient } from "@meltiply/database";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createStorageServiceTest } from "@meltiply/storage";
import { Effect } from "effect";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { createAssetApiService } from "../src/asset-service";
import { createCoreApiService } from "../src/core-service";
import { createPostApiService } from "../src/post-service";
import { loadCurrentUser } from "../src/current-user";
import { createThreadsAdapter, createYouTubeAdapter, ProviderRegistry } from "@meltiply/providers";
import { authenticatedPoolFor, systemPoolFor, withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const fixturePrefix = "query-budget-";
const fixtureCount = 120;
const samplesPerRoute = 20;

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Claims mirror the ResolvedActor contract: subject is the Better Auth "user".id
// backing users.auth_user_id, userId the internal users.id UUID, and
// organizationId the internal workspace UUID with its org_members role.
const alpha = {
  organizationId: "20000000-0000-4000-8000-000000000001",
  organizationRole: "admin",
  subject: "auth_user_local_alpha",
  userId: "10000000-0000-4000-8000-000000000001",
};

const queryBudgetClaims = {
  organizationId: "b2000000-0000-4000-8000-000000000001",
  organizationRole: "admin",
  subject: "auth_user_query_budget",
  userId: "b1000000-0000-4000-8000-000000000001",
};

const queryBudgetActor: ResolvedActor = {
  authUserId: queryBudgetClaims.subject,
  claims: queryBudgetClaims,
  displayName: "Query Budget User",
  email: "query-budget@meltiply.local",
  isInstallationOwner: false,
  role: "admin",
  userId: queryBudgetClaims.userId,
  workspace: {
    id: queryBudgetClaims.organizationId,
    name: "Query Budget Studio",
    slug: "query-budget-studio",
  },
};

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "query-budget@meltiply.local",
  name: "Query Budget User",
  subject: queryBudgetClaims.subject,
};

const bearerAuthorization = { Authorization: "Bearer query-budget.jwt" };

interface RouteResult {
  body: unknown;
  rows: number;
}

interface RouteCase {
  maxRows: number;
  maxStatements: number;
  minRows: number;
  name: string;
  prepare?: () => Promise<void>;
  run: () => Promise<RouteResult>;
}

interface QuerySample {
  durationMs: number;
  kind: "application" | "context" | "transaction";
  statement: string;
}

interface Measurement {
  acquireMs: number;
  applicationStatements: number;
  contextMs: number;
  queries: QuerySample[];
  responseBytes: number;
  result: RouteResult;
  routeMs: number;
  transactionMs: number;
}

interface RouteReport {
  acquire_p95_ms: number;
  application_queries_max: number;
  response_bytes_max: number;
  route: string;
  route_p50_ms: number;
  route_p95_ms: number;
  route_p99_ms: number;
  rows_max: number;
  set_config_p95_ms: number;
  statement_p95_ms: number;
  transaction_p95_ms: number;
  throughput_rps: number;
}

const reports: RouteReport[] = [];

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function statementKind(text: string): QuerySample["kind"] {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return "transaction";
  if (normalized.includes("set_config('request.jwt.claims'")) return "context";
  return "application";
}

async function measure(operation: () => Promise<RouteResult>): Promise<Measurement> {
  const pool = authenticatedPoolFor(env);
  const mutablePool = pool as unknown as {
    connect: () => Promise<TransactionClient>;
  };
  const originalConnect = mutablePool.connect;
  const connect = originalConnect.bind(pool);
  const queries: QuerySample[] = [];
  let acquireMs = 0;
  let transactionStartedAt = 0;
  let transactionMs = 0;

  mutablePool.connect = async () => {
    const acquireStartedAt = performance.now();
    const client = await connect();
    acquireMs = performance.now() - acquireStartedAt;
    const measuredQuery: TransactionClient["query"] = async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(
      text: string,
      values?: readonly unknown[],
    ) => {
      const startedAt = performance.now();
      const kind = statementKind(text);
      if (/^BEGIN$/i.test(text.trim())) transactionStartedAt = startedAt;
      const result = await client.query<Row>(text, values);
      const completedAt = performance.now();
      queries.push({
        durationMs: completedAt - startedAt,
        kind,
        statement: text.trim().replaceAll(/\s+/g, " "),
      });
      if (/^COMMIT$/i.test(text.trim())) {
        transactionMs = completedAt - transactionStartedAt;
      }
      return result;
    };
    return {
      query: measuredQuery,
      release: () => client.release(),
    };
  };

  const startedAt = performance.now();
  try {
    const result = await operation();
    const routeMs = performance.now() - startedAt;
    return {
      acquireMs,
      applicationStatements: queries.filter((query) => query.kind === "application").length,
      contextMs: queries.find((query) => query.kind === "context")?.durationMs ?? 0,
      queries,
      responseBytes: Buffer.byteLength(JSON.stringify(result.body)),
      result,
      routeMs,
      transactionMs,
    };
  } finally {
    mutablePool.connect = originalConnect;
  }
}

/**
 * Removes the scaled query-budget fixture inside a system transaction.
 *
 * Deleting the Better Auth "user" row cascades to the internal users row; the
 * organizations row cascades to members, assets, distributions, and fixtures.
 */
async function deleteFixture(): Promise<void> {
  await Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          "DELETE FROM organizations WHERE id = 'b2000000-0000-4000-8000-000000000001'",
        );
        yield* client.query("DELETE FROM users WHERE id = 'b1000000-0000-4000-8000-000000000001'");
        yield* client.query(`DELETE FROM "user" WHERE id = 'auth_user_query_budget'`);
      }),
    ),
  );
}

/**
 * Removes the maximum-range analytics fixture inside a system transaction.
 */
async function deleteRangeFixture(): Promise<void> {
  await Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          "DELETE FROM organizations WHERE id = 'f2000000-0000-4000-8000-000000000001'",
        );
        yield* client.query("DELETE FROM users WHERE id = 'f1000000-0000-4000-8000-000000000001'");
        yield* client.query(`DELETE FROM "user" WHERE id = 'auth_user_analytics_range'`);
      }),
    ),
  );
}

describeIntegration("core API PostgreSQL query budgets", () => {
  const assetService = createAssetApiService({
    storageServiceLayer: createStorageServiceTest({
      signDownload: ({ key }) => Effect.succeed(`https://r2.example/download/${key}`),
      signMultipartPart: ({ key, partNumber }) =>
        Effect.succeed(`https://r2.example/upload/${key}?partNumber=${partNumber}`),
      signUpload: ({ key }) => Effect.succeed(`https://r2.example/upload/${key}`),
    }),
  });
  // Both scheduling targets use real adapter capabilities. A ready vertical
  // video satisfies YouTube and Threads without weakening either media contract.
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    "threads",
    createThreadsAdapter({
      clientId: "query-budget-threads-client",
      clientSecret: "query-budget-threads-client-secret",
      redirectUri: "https://query-budget.invalid/oauth/threads/callback",
    }),
  );
  providerRegistry.register(
    "youtube",
    createYouTubeAdapter({
      clientId: "query-budget-youtube-client",
      clientSecret: "query-budget-youtube-client-secret",
      redirectUri: "https://query-budget.invalid/oauth/youtube/callback",
    }),
  );
  // Keep unsupported coverage inside the measured analytics summary path.
  const configuredCapabilities = providerRegistry
    .capabilities()
    .map((capability) =>
      capability.platform === "tiktok" ? { ...capability, analytics: false } : capability,
    );
  const coreService = createCoreApiService(configuredCapabilities);
  const postService = createPostApiService(configuredCapabilities);
  const app = createApiApp({
    assetService,
    coreService,
    postService,
    resolveActor: async () => queryBudgetActor,
    verifyJwtToken: async () => jwtIdentity,
  });
  const start = new Date("2026-07-01T00:00:00.000Z");
  // Keep the scaled read fixture independent from distributions created by the
  // mutation budget cases later in the same run.
  const end = new Date("2026-07-19T23:59:59.999Z");
  // Bounded sub-window over the scaled fixture: published_at/event_at values
  // span 12:00:01Z..12:02:00Z, so [12:00:30Z, 12:01:30Z] selects exactly the
  // 61 fixtures seeded with item offsets 30 through 90 inclusive.
  const windowStart = new Date("2026-07-18T12:00:30.000Z");
  const windowEnd = new Date("2026-07-18T12:01:30.000Z");
  const assetId = "a1000000-0000-4000-8000-000000000001";
  const postId = "c0000000-0000-4000-8000-000000000001";
  const distributionId = "d1000000-0000-4000-8000-000000000001";
  // First Brand Profile in the query-budget workspace; owner of the scaled read
  // fixture (assets, distributions, and their Posts). Profiles
  // b4000…002–020 own the remaining scheduling pairs.
  const brandProfileId = "b4000000-0000-4000-8000-000000000001";
  let batchCreateSample = 0;
  let createSample = 0;
  let scheduledBatchCreateSample = 0;
  let uploadSample = 0;
  // Forty-two saved video Posts each target their Profile's YouTube and Threads
  // Channels. The immediate/deferred cases use disjoint Posts (0–20 and 21–41),
  // so every sample measures creation, not rescheduling an earlier outcome.
  const scheduledPostIds = Array.from(
    { length: 42 },
    (_, index) => `c1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  // Posts cycle through the twenty Profiles in insertion order; both target
  // Channels and the video attachment belong to the same owning Profile.
  const scheduledPostProfileId = (index: number) =>
    `b4000000-0000-4000-8000-${String((index % 20) + 1).padStart(12, "0")}`;

  /**
   * Gives each mutation sample independent monthly headroom outside measurement.
   * Removes only uncompleted upload fixtures from previous samples; seeded read
   * rows and real quota admission remain intact throughout the benchmark.
   */
  async function prepareMutationSample(): Promise<void> {
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            "DELETE FROM assets WHERE org_id = $1 AND title LIKE 'Query budget upload %'",
            [queryBudgetClaims.organizationId],
          );
          yield* client.query(
            `UPDATE usage_records SET uploads = 0, distributions = 0
             WHERE org_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
            [queryBudgetClaims.organizationId],
          );
        }),
      ),
    );
  }

  beforeAll(async () => {
    await deleteFixture();
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO "user" (id, name, email, "emailVerified")
             VALUES (
               'auth_user_query_budget', 'Query Budget User',
               'query-budget@meltiply.local', TRUE
             )`,
          );
          yield* client.query(
            `INSERT INTO users (id, auth_user_id, email, display_name)
             VALUES (
               'b1000000-0000-4000-8000-000000000001',
               'auth_user_query_budget', 'query-budget@meltiply.local',
               'Query Budget User'
             )`,
          );
          yield* client.query(
            `INSERT INTO organizations
               (id, name, slug, plan, billing_status)
             VALUES (
               'b2000000-0000-4000-8000-000000000001',
               'Query Budget Studio', 'query-budget-studio',
               'agency', 'active'
             )`,
          );
          yield* client.query(
            `INSERT INTO org_members (id, org_id, user_id, role)
             VALUES (
               'b3000000-0000-4000-8000-000000000001',
               'b2000000-0000-4000-8000-000000000001',
               'b1000000-0000-4000-8000-000000000001', 'admin'
             )`,
          );
          // Each of the twenty Profiles owns one Channel per Provider: YouTube
          // and Threads. Saved video Posts exercise both targets together.
          yield* client.query(
            `INSERT INTO brand_profiles (id, org_id, name, color)
             SELECT
               ('b4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               'Query Budget Brand ' || item, '#1d4ed8'
             FROM generate_series(1, 20) AS item`,
          );
          yield* client.query(
            `INSERT INTO platform_accounts
               (id, org_id, brand_profile_id, platform, platform_user_id,
                display_name, access_token, scopes, metadata)
             SELECT
               ('b5000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               ('b4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'youtube',
               'query-budget-youtube-' || item,
               'Query Budget Channel ' || item,
               'local-query-budget-token-' || item,
               ARRAY['upload'],
               '{"fixture": true}'::jsonb
             FROM generate_series(1, 20) AS item`,
          );
          // Threads and YouTube share each Profile's verified video attachment.
          yield* client.query(
            `INSERT INTO platform_accounts
               (id, org_id, brand_profile_id, platform, platform_user_id,
                display_name, access_token, scopes, metadata)
             SELECT
               ('b6000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               ('b4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'threads',
               'query-budget-threads-' || item,
               'Query Budget Threads Channel ' || item,
               'local-query-budget-token-threads-' || item,
               ARRAY['upload'],
               '{"fixture": true}'::jsonb
             FROM generate_series(1, 20) AS item`,
          );
          yield* client.query(
            `INSERT INTO usage_records
               (id, org_id, period, uploads, distributions, api_calls,
                storage_bytes)
             VALUES (
               'b9000000-0000-4000-8000-000000000001',
               'b2000000-0000-4000-8000-000000000001', '2026-07', 0, 120, 240,
               491520
             )`,
          );
          yield* client.query(
            `INSERT INTO assets
               (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
                status, created_at, finalized_at)
             SELECT
               ('a1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               'b4000000-0000-4000-8000-000000000001'::uuid,
               'b1000000-0000-4000-8000-000000000001'::uuid,
               'image', $1::text || item::text, 'ready',
               '2026-07-18T10:00:00Z'::timestamptz + item * INTERVAL '1 second',
               '2026-07-18T10:00:00Z'::timestamptz + item * INTERVAL '1 second'
            FROM generate_series(1, $2::integer) AS item`,
            [fixturePrefix, fixtureCount],
          );
          // One Post per fixture publication: the scaled read surface is
          // exercised through stable Post identity, and each Post owns exactly
          // one ordered attachment just as a media Post would.
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status,
                created_at)
             SELECT
               ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               'b4000000-0000-4000-8000-000000000001'::uuid,
               'Query budget post ' || item, $1::text || item::text, 'active',
               '2026-07-18T11:00:00Z'::timestamptz + item * INTERVAL '1 second'
            FROM generate_series(1, $2::integer) AS item`,
            [fixturePrefix, fixtureCount],
          );
          // One attachment per seeded Post. Bound values are positional:
          // PostgreSQL numbers placeholders by the `$n` written in the SQL, so
          // this statement carries exactly one placeholder and one value. The
          // cast fixes the type PostgreSQL infers for the `generate_series`
          // bound; a second placeholder would leave it expecting a second,
          // unbound value.
          yield* client.query(
            `INSERT INTO post_attachments
               (post_id, asset_id, org_id, brand_profile_id, position)
             SELECT
               ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               ('a1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               'b4000000-0000-4000-8000-000000000001'::uuid,
               0
             FROM generate_series(1, $1::integer) AS item`,
            [fixtureCount],
          );
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform_account_id,
                platform, status, published_at, platform_post_id, platform_url,
                title_override, created_at)
             SELECT
               ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               'b4000000-0000-4000-8000-000000000001'::uuid,
               ('c0000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b5000000-0000-4000-8000-000000000001'::uuid,
               'youtube', 'published',
               '2026-07-18T12:00:00Z'::timestamptz + item * INTERVAL '1 second',
               $1::text || item::text,
               'https://example.invalid/query-budget/' || item::text,
               'Query budget distribution ' || item::text,
               '2026-07-18T11:00:00Z'::timestamptz + item * INTERVAL '1 second'
            FROM generate_series(1, $2::integer) AS item`,
            [fixturePrefix, fixtureCount],
          );
          // Ready media is owned separately by each Profile. The benchmark never
          // fetches object bytes: these verified inventory facts are the scheduler's
          // real validation input, not a replacement capability or HTTP adapter.
          yield* client.query(
            `INSERT INTO assets
               (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
                status, mime_type, file_size, duration_sec, width, height, finalized_at)
             SELECT
               ('ab100000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               $1::uuid,
               ('b4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               $2::uuid, 'video', 'Query budget scheduling video ' || item,
               'ready', 'video/mp4', 1024, 30, 1080, 1920, now()
             FROM generate_series(1, 20) AS item`,
            [queryBudgetClaims.organizationId, queryBudgetClaims.userId],
          );
          yield* client.query(
            `INSERT INTO asset_objects
               (id, org_id, brand_profile_id, asset_id, kind, profile, r2_key,
                bytes, content_type, duration_sec, width, height, status)
             SELECT
               ('ab200000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               $1::uuid,
               ('b4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               ('ab100000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'rendition', 'query_budget_video',
               $1::text || '/query-budget/video-' || item || '.mp4',
               1024, 'video/mp4', 30, 1080, 1920, 'ready'
             FROM generate_series(1, 20) AS item`,
            [queryBudgetClaims.organizationId],
          );
          yield* client.query(
            `INSERT INTO asset_renditions
               (org_id, brand_profile_id, asset_id, profile, object_id, status)
             SELECT org_id, brand_profile_id, asset_id, profile, id, 'ready'
             FROM asset_objects
             WHERE org_id = $1 AND profile = 'query_budget_video'`,
            [queryBudgetClaims.organizationId],
          );
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status)
             SELECT
               ('c1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               ('b4000000-0000-4000-8000-'
                 || lpad((((item - 1) % 20) + 1)::text, 12, '0'))::uuid,
               'Query budget scheduled post ' || item,
               $1::text || item::text, 'draft'
            FROM generate_series(1, 42) AS item`,
            [fixturePrefix],
          );
          yield* client.query(
            `INSERT INTO post_attachments
               (post_id, asset_id, org_id, brand_profile_id, position)
             SELECT id,
                    ('ab100000-0000-4000-8000-'
                      || right(brand_profile_id::text, 12))::uuid,
                    org_id, brand_profile_id, 0
             FROM posts
             WHERE org_id = $1 AND id::text LIKE 'c1000000-%'`,
            [queryBudgetClaims.organizationId],
          );
          yield* client.query(
            `INSERT INTO post_targets
               (post_id, platform_account_id, org_id, brand_profile_id,
                title_override, provider_options)
             SELECT
               ('c1000000-0000-4000-8000-' || lpad(post_item::text, 12, '0'))::uuid,
               (channel.prefix || '-0000-4000-8000-'
                 || lpad((((post_item - 1) % 20) + 1)::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               ('b4000000-0000-4000-8000-'
                 || lpad((((post_item - 1) % 20) + 1)::text, 12, '0'))::uuid,
               'Query budget target',
               CASE WHEN channel.prefix = 'b5000000'
                 THEN '{"youtube":{"madeForKids":false}}'::jsonb
                 ELSE '{}'::jsonb END
            FROM generate_series(1, 42) AS post_item
            CROSS JOIN (VALUES ('b5000000'), ('b6000000')) AS channel(prefix)`,
          );
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (id, distribution_id, org_id, views, likes, comments, shares,
                snapshot_at)
             SELECT
               ('e1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               item, item, item, item,
               '2026-07-18T13:00:00Z'::timestamptz
            FROM generate_series(1, $1::integer) AS item`,
            [fixtureCount],
          );
          yield* client.query(
            `INSERT INTO comments
               (id, distribution_id, org_id, platform_comment_id, author_name,
                body, replied, reply_status, commented_at)
             SELECT
               ('c1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               ('d1000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'b2000000-0000-4000-8000-000000000001'::uuid,
               $1::text || item::text, 'Query Budget Viewer',
               'Scaled comment ' || item::text,
               false, 'none',
               '2026-07-18T12:30:00Z'::timestamptz
                 + item * INTERVAL '1 second'
            FROM generate_series(1, $2::integer) AS item`,
            [fixturePrefix, fixtureCount],
          );
        }),
      ),
    );
  });

  afterAll(async () => {
    for (const report of reports) {
      process.stdout.write(`query_budget_route ${JSON.stringify(report)}\n`);
    }
    await deleteFixture();
    await authenticatedPoolFor(env).end();
    await systemPoolFor(env).end();
  });

  it("reuses an idle PostgreSQL connection across released managed-pool queries", async () => {
    const pool = authenticatedPoolFor(env);
    const first = await pool.query<{ backend_pid: number }>(
      "SELECT pg_backend_pid() AS backend_pid",
    );
    const second = await pool.query<{ backend_pid: number }>(
      "SELECT pg_backend_pid() AS backend_pid",
    );

    expect(second.rows[0]?.backend_pid).toBe(first.rows[0]?.backend_pid);
  });

  it("resolves only the verified user's active organization identity", async () => {
    await expect(loadCurrentUser(env, alpha)).resolves.toMatchObject({
      active_organization: {
        id: "20000000-0000-4000-8000-000000000001",
        role: "admin",
      },
      email: "alpha@meltiply.local",
      id: "10000000-0000-4000-8000-000000000001",
    });
    await expect(
      loadCurrentUser(env, {
        organizationId: "20000000-0000-4000-8000-000000000002",
        organizationRole: "admin",
        subject: "auth_user_local_beta",
        userId: "10000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toMatchObject({
      active_organization: {
        id: "20000000-0000-4000-8000-000000000002",
        role: "admin",
      },
      email: "beta@meltiply.local",
      id: "10000000-0000-4000-8000-000000000002",
    });
    await expect(
      loadCurrentUser(env, {
        organizationId: "20000000-0000-4000-8000-000000000002",
        organizationRole: "admin",
        subject: "auth_user_local_alpha",
        userId: "10000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBeNull();
  });

  it("serves tenant distribution reads from bounded stable-order windows", async () => {
    const expectedIds = Array.from(
      { length: 61 },
      (_, index) => `d1000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
    );

    const listed = await Effect.runPromise(
      coreService.listDistributions(env, queryBudgetClaims, {
        end: windowEnd,
        limit: 100,
        offset: 0,
        start: windowStart,
        status: "published",
      }),
    );
    expect(listed.distributions).toHaveLength(61);
    expect(listed.has_more).toBe(false);
    // Tenant reads order by event_at DESC, id DESC over the RLS org scope.
    expect(listed.distributions.map((distribution) => distribution.id)).toEqual(
      [...expectedIds].reverse(),
    );

    const calendarRows = await Effect.runPromise(
      coreService.calendar(env, queryBudgetClaims, windowStart, windowEnd),
    );
    // The calendar window orders by event_at ASC, id ASC.
    expect(calendarRows.map((row) => row.id)).toEqual(expectedIds);
  });

  it("holds statement and row counts constant for scaled core routes", async () => {
    const routes: RouteCase[] = [
      {
        maxRows: 100,
        maxStatements: 3,
        minRows: 1,
        name: "current user",
        run: async () => {
          const body = await loadCurrentUser(env, queryBudgetClaims);
          return { body, rows: body ? 1 : 0 };
        },
      },
      {
        maxRows: 100,
        maxStatements: 3,
        minRows: 1,
        name: "platform accounts",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.listPlatformAccounts(env, queryBudgetClaims),
          );
          return { body, rows: body.length };
        },
      },
      {
        maxRows: 100,
        // Paged Posts plus grouped attachments, targets, distributions, and
        // latest analytics: five statements independent of page size. A
        // per-Post or per-Channel analytics request still exceeds this bound.
        maxStatements: 5,
        minRows: 100,
        name: "post list",
        run: async () => {
          const body = await Effect.runPromise(
            postService.listPosts(env, queryBudgetClaims, {
              limit: 100,
              offset: 0,
            }),
          );
          expect(body.posts).toHaveLength(100);
          expect(body.has_more).toBe(true);
          expect(body).not.toHaveProperty("total");
          return { body, rows: body.posts.length };
        },
      },
      {
        maxRows: 100,
        // Same fixed projection as the list, including batched latest analytics.
        maxStatements: 5,
        minRows: 1,
        name: "post detail",
        run: async () => {
          const body = await Effect.runPromise(postService.getPost(env, queryBudgetClaims, postId));
          expect(body.attachments[0]?.asset_id).toBe(assetId);
          return { body, rows: 1 };
        },
      },
      {
        maxRows: 100,
        maxStatements: 3,
        minRows: 1,
        name: "asset detail",
        run: async () => {
          const body = await Effect.runPromise(
            assetService.getAsset(env, queryBudgetClaims, assetId),
          );
          return { body, rows: 1 };
        },
      },
      {
        maxRows: 500,
        maxStatements: 1,
        minRows: 100,
        name: "distribution list",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.listDistributions(env, queryBudgetClaims, {
              limit: 100,
              offset: 0,
            }),
          );
          expect(body.distributions).toHaveLength(100);
          expect(body.has_more).toBe(true);
          expect(body).not.toHaveProperty("total");
          return { body, rows: body.distributions.length };
        },
      },
      {
        maxRows: 61,
        maxStatements: 3,
        minRows: 61,
        name: "distribution list window",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.listDistributions(env, queryBudgetClaims, {
              end: windowEnd,
              limit: 100,
              offset: 0,
              start: windowStart,
              status: "published",
            }),
          );
          return { body, rows: body.distributions.length };
        },
      },
      {
        maxRows: 500,
        maxStatements: 3,
        minRows: 1,
        name: "distribution detail",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.getDistribution(env, queryBudgetClaims, distributionId),
          );
          return { body, rows: 1 };
        },
      },
      {
        maxRows: 1,
        // A text-only draft needs only the tenant check, idempotency reserve,
        // Workspace lock, Brand Profile guard, Post insert, and idempotency
        // completion; all response collections are known empty.
        maxStatements: 6,
        minRows: 1,
        name: "post draft create",
        run: async () => {
          const sample = createSample;
          createSample += 1;
          const body = await Effect.runPromise(
            postService.createPost(
              env,
              queryBudgetClaims,
              {
                brandProfileId,
                defaultText: `Query budget draft ${sample}`,
              },
              `query-budget-post-${sample}`,
            ),
          );
          return { body, rows: body.value ? 1 : 0 };
        },
      },
      {
        maxRows: 20,
        // One rendition lookup and one attachment projection extend the text-only
        // budget by two statements. Both Channels must produce outcomes while the
        // insert/outbox work stays set-based rather than growing per target.
        maxStatements: 17,
        minRows: 2,
        name: "post schedule create",
        prepare: prepareMutationSample,
        run: async () => {
          const sample = batchCreateSample;
          batchCreateSample += 1;
          const body = await Effect.runPromise(
            postService.schedulePost(
              env,
              queryBudgetClaims,
              scheduledPostIds[sample]!,
              {
                brandProfileId: scheduledPostProfileId(sample),
                scheduledAt: null,
              },
              `query-budget-schedule-${sample}`,
            ),
          );
          return { body, rows: body.value.distributions.length };
        },
      },
      {
        maxRows: 20,
        // Deferred work omits only the immediate outbox insert.
        maxStatements: 16,
        minRows: 2,
        name: "scheduled post schedule create",
        prepare: prepareMutationSample,
        run: async () => {
          const sample = scheduledBatchCreateSample;
          scheduledBatchCreateSample += 1;
          const body = await Effect.runPromise(
            postService.schedulePost(
              env,
              queryBudgetClaims,
              scheduledPostIds[21 + sample]!,
              {
                brandProfileId: scheduledPostProfileId(21 + sample),
                scheduledAt: new Date("2099-01-01T00:00:00.000Z"),
              },
              `query-budget-scheduled-schedule-${sample}`,
            ),
          );
          return { body, rows: body.value.distributions.length };
        },
      },
      {
        maxRows: 1,
        // Reuse the inserted session for grant planning: creation retains the
        // quota checks and persisted staging write hold without a session read.
        maxStatements: 11,
        minRows: 1,
        name: "upload session create",
        prepare: prepareMutationSample,
        run: async () => {
          const sample = uploadSample;
          uploadSample += 1;
          const response = await app.request(
            "/api/v1/asset-upload-sessions",
            {
              body: JSON.stringify({
                asset_type: "image",
                brand_profile_id: brandProfileId,
                content_type: "image/png",
                file_size: 1_024,
                filename: `query-budget-upload-${sample}.png`,
                title: `Query budget upload ${sample}`,
              }),
              headers: {
                ...bearerAuthorization,
                "Content-Type": "application/json",
                "Idempotency-Key": `query-budget-upload-${sample}`,
                "X-Request-ID": `query-budget-upload-${sample}`,
              },
              method: "POST",
            },
            env,
          );
          const body = await response.json();
          return { body, rows: response.status === 201 ? 1 : 0 };
        },
      },
      {
        maxRows: 500,
        maxStatements: 3,
        minRows: 100,
        name: "calendar",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.calendar(env, queryBudgetClaims, start, end),
          );
          return { body, rows: body.length };
        },
      },
      {
        maxRows: 500,
        maxStatements: 2,
        minRows: 1,
        name: "analytics summary",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.summaryAnalytics(env, queryBudgetClaims, {
              end,
              start,
            }),
          );
          return { body, rows: body.by_platform.length };
        },
      },
      {
        maxRows: 5,
        // series, combined breakdowns, follower baseline/daily, accumulation
        maxStatements: 4,
        minRows: 1,
        name: "analytics dashboard",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.dashboardAnalytics(env, queryBudgetClaims, {
              end,
              start,
            }),
          );
          return { body, rows: body.platforms.length };
        },
      },
      {
        maxRows: 100,
        maxStatements: 1,
        minRows: 1,
        name: "distribution analytics",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.distributionAnalytics(env, queryBudgetClaims, distributionId, {
              limit: 100,
            }),
          );
          return { body, rows: body.length };
        },
      },
      {
        maxRows: 100,
        maxStatements: 1,
        minRows: 100,
        name: "inbox list",
        run: async () => {
          const body = await Effect.runPromise(
            coreService.inbox(env, queryBudgetClaims, {
              limit: 100,
              offset: 0,
            }),
          );
          expect(body.comments).toHaveLength(100);
          expect(body.has_more).toBe(true);
          expect(body).not.toHaveProperty("total");
          return { body, rows: body.comments.length };
        },
      },
    ];

    for (const route of routes) {
      await route.prepare?.();
      await route.run();
      const measurements: Measurement[] = [];
      for (let sample = 0; sample < samplesPerRoute; sample += 1) {
        await route.prepare?.();
        measurements.push(await measure(route.run));
      }

      for (const measurement of measurements) {
        expect(measurement.applicationStatements, route.name).toBeLessThanOrEqual(
          route.maxStatements,
        );
        expect(
          measurement.queries.filter((query) => query.kind === "context"),
          route.name,
        ).toHaveLength(1);
        expect(measurement.result.rows, route.name).toBeGreaterThanOrEqual(route.minRows);
        expect(measurement.result.rows, route.name).toBeLessThanOrEqual(route.maxRows);
      }

      const statementDurations = measurements.flatMap((measurement) =>
        measurement.queries
          .filter((query) => query.kind === "application")
          .map((query) => query.durationMs),
      );
      reports.push({
        acquire_p95_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.acquireMs),
            0.95,
          ),
        ),
        application_queries_max: Math.max(
          ...measurements.map((measurement) => measurement.applicationStatements),
        ),
        response_bytes_max: Math.max(
          ...measurements.map((measurement) => measurement.responseBytes),
        ),
        route: route.name,
        route_p50_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.routeMs),
            0.5,
          ),
        ),
        route_p95_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.routeMs),
            0.95,
          ),
        ),
        route_p99_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.routeMs),
            0.99,
          ),
        ),
        rows_max: Math.max(...measurements.map((measurement) => measurement.result.rows)),
        set_config_p95_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.contextMs),
            0.95,
          ),
        ),
        statement_p95_ms: rounded(percentile(statementDurations, 0.95)),
        transaction_p95_ms: rounded(
          percentile(
            measurements.map((measurement) => measurement.transactionMs),
            0.95,
          ),
        ),
        throughput_rps: rounded(
          samplesPerRoute /
            (measurements.reduce((total, measurement) => total + measurement.routeMs, 0) / 1_000),
        ),
      });
    }
  }, 60_000);

  it("keeps maximum-range analytics bounded and inside the statement timeout", async () => {
    const rangeClaims = {
      organizationId: "f2000000-0000-4000-8000-000000000001",
      organizationRole: "admin",
      subject: "auth_user_analytics_range",
      userId: "f1000000-0000-4000-8000-000000000001",
    };
    const rangeStart = new Date("2026-01-01T00:00:00.000Z");
    // Maximum permitted span: exactly 366 days.
    const rangeEnd = new Date(rangeStart.getTime() + 366 * 24 * 60 * 60 * 1_000);
    const publishedCount = 400;
    /** Per-platform analytics bucket plus its latest snapshot instant. */
    interface AnalyticsBucket {
      comments: number;
      impressions: number;
      last_synced_at: string | null;
      likes: number;
      post_count: number;
      reach: number;
      shares: number;
      views: number;
      watch_time_sec: number;
    }
    type MetricTotals = Omit<AnalyticsBucket, "last_synced_at">;
    const zeroBucket = (): AnalyticsBucket => ({
      comments: 0,
      impressions: 0,
      last_synced_at: null as string | null,
      likes: 0,
      post_count: 0,
      reach: 0,
      shares: 0,
      views: 0,
      watch_time_sec: 0,
    });

    await deleteRangeFixture();
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO "user" (id, name, email, "emailVerified")
             VALUES (
               'auth_user_analytics_range', 'Analytics Range User',
               'analytics-range@meltiply.local', TRUE
             )`,
          );
          yield* client.query(
            `INSERT INTO users (id, auth_user_id, email, display_name)
             VALUES (
               'f1000000-0000-4000-8000-000000000001',
               'auth_user_analytics_range', 'analytics-range@meltiply.local',
               'Analytics Range User'
             )`,
          );
          yield* client.query(
            `INSERT INTO organizations
               (id, name, slug, plan, billing_status)
             VALUES (
               'f2000000-0000-4000-8000-000000000001',
               'Analytics Range Studio',
               'analytics-range-studio', 'agency', 'active'
             )`,
          );
          yield* client.query(
            `INSERT INTO org_members (id, org_id, user_id, role)
             VALUES (
               'f3000000-0000-4000-8000-000000000001',
               'f2000000-0000-4000-8000-000000000001',
               'f1000000-0000-4000-8000-000000000001', 'admin'
             )`,
          );
          yield* client.query(
            `INSERT INTO brand_profiles (id, org_id, name, color)
             VALUES (
               'f4000000-0000-4000-8000-000000000001',
               'f2000000-0000-4000-8000-000000000001',
               'Analytics Range Brand', '#15803d'
             )`,
          );
          yield* client.query(
            `INSERT INTO assets
               (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
                status)
             VALUES (
               'a2000000-0000-4000-8000-000000000001',
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               'f1000000-0000-4000-8000-000000000001'::uuid,
               'image', 'Analytics range fixture', 'ready'
             )`,
          );
          // Every publication row in this fixture belongs to its own Post, so
          // the maximum-range analytics summary counts Post publications
          // through stable identity rather than Asset identity.
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status,
                created_at)
             SELECT
               ('c2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               'Analytics range ' || item, 'Range body', 'active',
               TIMESTAMP '2026-01-01 00:00:00+00'
             FROM generate_series(1, $1::integer) AS item`,
            [publishedCount],
          );
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status,
                created_at)
             SELECT
               ('c3000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               'Analytics range scheduled ' || item, 'Scheduled body', 'active',
               TIMESTAMP '2026-06-01 00:00:00+00'
             FROM generate_series(1, 10) AS item`,
          );
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status,
                created_at)
             SELECT
               ('c4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               'Analytics range early ' || item, 'Early body', 'active',
               TIMESTAMP '2026-01-01 00:00:00+00'
             FROM generate_series(1, 10) AS item`,
          );
          yield* client.query(
            `INSERT INTO posts
               (id, org_id, brand_profile_id, title, default_text, status,
                created_at)
             SELECT
               ('c5000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               'Analytics range late ' || item, 'Late body', 'active',
               TIMESTAMP '2027-01-02 00:00:00+00'
             FROM generate_series(1, 10) AS item`,
          );
          // Published posts spread across the whole window on both analytics
          // platforms; item * 21 hours keeps every post inside the range.
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                published_at,
                platform_post_id, platform_url, title_override)
             SELECT
               ('d2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               ('c2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               CASE WHEN item % 2 = 0 THEN 'youtube' ELSE 'tiktok' END,
               'published',
               TIMESTAMP '2026-01-01 00:00:00+00' + item * INTERVAL '21 hours',
               'range-fixture-' || item,
               'https://example.invalid/analytics-range/' || item,
               'Analytics range ' || item
             FROM generate_series(1, $1::integer) AS item`,
            [publishedCount],
          );
          // In range but scheduled, and published but outside the range on both
          // sides: all three groups must stay out of the summary.
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                scheduled_at,
                platform_post_id, platform_url)
             SELECT
               ('d3000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               ('c3000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'youtube', 'scheduled',
               TIMESTAMP '2026-06-01 00:00:00+00' + item * INTERVAL '1 hour',
               'range-scheduled-' || item,
               'https://example.invalid/analytics-range/scheduled/' || item
             FROM generate_series(1, 10) AS item`,
          );
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                published_at,
                  platform_post_id, platform_url)
             SELECT
               ('d4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               ('c4000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'youtube', 'published',
               TIMESTAMP '2026-01-01 00:00:00+00' - item * INTERVAL '10 days',
               'range-early-' || item,
               'https://example.invalid/analytics-range/early/' || item
             FROM generate_series(1, 10) AS item`,
          );
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                published_at,
                platform_post_id, platform_url)
             SELECT
               ('d5000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               'f4000000-0000-4000-8000-000000000001'::uuid,
               ('c5000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'youtube', 'published',
               TIMESTAMP '2027-01-02 00:00:00+00' + item * INTERVAL '10 days',
               'range-late-' || item,
               'https://example.invalid/analytics-range/late/' || item
             FROM generate_series(1, 10) AS item`,
          );
          // Two in-window snapshots per post except the last one, which keeps
          // none; only the newest as of the range end may be summarized.
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (id, distribution_id, org_id, views, likes, comments, shares,
                watch_time_sec, reach, impressions, snapshot_at)
             SELECT
               ('e2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               ('d2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               item, item, item, item, item, item, item,
               TIMESTAMP '2026-01-01 00:00:00+00'
                 + item * INTERVAL '21 hours' - INTERVAL '3 hours'
             FROM generate_series(1, $1::integer - 1) AS item`,
            [publishedCount],
          );
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (id, distribution_id, org_id, views, likes, comments, shares,
                watch_time_sec, reach, impressions, snapshot_at)
             SELECT
               ('e2000000-0000-4000-8000-'
                 || lpad((1000 + item)::text, 12, '0'))::uuid,
               ('d2000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
               'f2000000-0000-4000-8000-000000000001'::uuid,
               item * 2, item * 2, item * 2, item * 2,
               item * 2, item * 2, item * 2,
               TIMESTAMP '2026-01-01 00:00:00+00'
                 + item * INTERVAL '21 hours' - INTERVAL '1 hour'
             FROM generate_series(1, $1::integer - 1) AS item`,
            [publishedCount],
          );
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (id, distribution_id, org_id, views, likes, comments, shares,
                watch_time_sec, reach, impressions, snapshot_at)
             VALUES (
               'e2000000-0000-4000-8000-000000090001',
               'd2000000-0000-4000-8000-000000000001',
               'f2000000-0000-4000-8000-000000000001'::uuid,
               999999, 999999, 999999, 999999, 999999, 999999, 999999,
               TIMESTAMP '2027-01-03 00:00:00+00'
             )`,
          );
        }),
      ),
    );

    try {
      // Mirror of the seed rules above: the latest as-of-end snapshot wins,
      // and the last published post contributes to post_count only.
      const expected = new Map<string, ReturnType<typeof zeroBucket>>();
      for (let item = 1; item <= publishedCount; item += 1) {
        const platform = item % 2 === 0 ? "youtube" : "tiktok";
        const bucket = expected.get(platform) ?? zeroBucket();
        bucket.post_count += 1;
        if (item < publishedCount) {
          bucket.comments += item * 2;
          bucket.impressions += item * 2;
          bucket.likes += item * 2;
          bucket.reach += item * 2;
          bucket.shares += item * 2;
          bucket.views += item * 2;
          bucket.watch_time_sec += item * 2;
          const snapshotAt = new Date(
            rangeStart.getTime() + item * 21 * 60 * 60 * 1_000 - 60 * 60 * 1_000,
          ).toISOString();
          if (bucket.last_synced_at === null || snapshotAt > bucket.last_synced_at) {
            bucket.last_synced_at = snapshotAt;
          }
        }
        expected.set(platform, bucket);
      }

      const summarize = async () => {
        const body = await Effect.runPromise(
          coreService.summaryAnalytics(env, rangeClaims, {
            end: rangeEnd,
            start: rangeStart,
          }),
        );
        return { body, rows: body.by_platform.length };
      };
      const summary = (await summarize()).body;
      expect(summary.range).toEqual({
        end: rangeEnd.toISOString(),
        start: rangeStart.toISOString(),
      });
      expect(summary.unsupported_platforms).toContain("tiktok");
      expect(summary.by_platform.map((row) => row.platform)).toEqual(["tiktok", "youtube"]);
      for (const row of summary.by_platform) {
        expect(row).toEqual({
          platform: row.platform,
          ...expected.get(row.platform),
        });
      }
      const totals = [...expected.values()].reduce<MetricTotals>(
        (left, right) => ({
          comments: left.comments + right.comments,
          impressions: left.impressions + right.impressions,
          likes: left.likes + right.likes,
          post_count: left.post_count + right.post_count,
          reach: left.reach + right.reach,
          shares: left.shares + right.shares,
          views: left.views + right.views,
          watch_time_sec: left.watch_time_sec + right.watch_time_sec,
        }),
        {
          comments: 0,
          impressions: 0,
          likes: 0,
          post_count: 0,
          reach: 0,
          shares: 0,
          views: 0,
          watch_time_sec: 0,
        },
      );
      expect(summary.totals).toEqual(totals);
      expect(summary.last_synced_at).toBe(
        new Date(rangeStart.getTime() + 8_378 * 60 * 60 * 1_000).toISOString(),
      );

      // One statement per read, every sample comfortably inside the 10s
      // authenticated statement timeout, and a row bound independent of
      // the seeded history size.
      await summarize();
      for (let sample = 0; sample < 5; sample += 1) {
        const measurement = await measure(summarize);
        expect(measurement.applicationStatements).toBeLessThanOrEqual(1);
        expect(measurement.result.rows).toBe(2);
        const slowest = Math.max(
          0,
          ...measurement.queries
            .filter((query) => query.kind === "application")
            .map((query) => query.durationMs),
        );
        expect(slowest, "statement timeout").toBeLessThan(10_000);
        expect(measurement.routeMs, "route budget").toBeLessThan(10_000);
      }
    } finally {
      await deleteRangeFixture();
    }
  }, 60_000);
  it("walks scaled list pages within a constant per-page statement count and correct page flags", async () => {
    const pageSize = 50;
    // Each surface declares its fixed statements-per-page ceiling: the bound
    // must not scale with the page, so a per-row lookup still trips the walk.
    const measuredListPage = async <Body>(
      name: string,
      run: () => Promise<Body>,
      itemCount: (body: Body) => number,
      maxPageStatements: number,
    ): Promise<Body> => {
      const measurement = await measure(async () => {
        const body = await run();
        return { body, rows: itemCount(body) };
      });
      expect(measurement.applicationStatements, name).toBeLessThanOrEqual(maxPageStatements);
      return measurement.result.body as Body;
    };

    // Seeded Posts and the draft Post mutation case share this workspace, so
    // the walk pages until exhausted rather than assuming a fixed total.
    const postIds = new Set<string>();
    let postOffset = 0;
    let postPageCount = 0;
    let sawFinalPostPage = false;
    // Bounded ceiling: the seeded fixture plus one row per draft save sample.
    const maxPostPages =
      Math.ceil((fixtureCount + scheduledPostIds.length + samplesPerRoute + 100) / pageSize) + 5;
    while (!sawFinalPostPage) {
      expect(postPageCount).toBeLessThan(maxPostPages);
      postPageCount += 1;
      const body = await measuredListPage(
        `post page at offset ${postOffset}`,
        () =>
          Effect.runPromise(
            postService.listPosts(env, queryBudgetClaims, {
              limit: pageSize,
              offset: postOffset,
            }),
          ),
        (page) => page.posts.length,
        // Page plus grouped attachments, targets, distributions, and latest
        // analytics: five statements at every offset, independent of page size.
        5,
      );
      expect(body.limit).toBe(pageSize);
      expect(body.offset).toBe(postOffset);
      expect(body.posts.length).toBeLessThanOrEqual(pageSize);
      for (const post of body.posts) {
        // Stable identity: no Post is served twice across the walk.
        expect(postIds.has(post.id)).toBe(false);
        postIds.add(post.id);
      }
      if (body.has_more) {
        expect(body.posts).toHaveLength(pageSize);
      } else {
        sawFinalPostPage = true;
      }
      postOffset += pageSize;
    }
    expect(postIds.size).toBeGreaterThanOrEqual(fixtureCount);

    const distributionIds = new Set<string>();
    let distributionOffset = 0;
    let sawFinalDistributionPage = false;
    let distributionPageCount = 0;
    // Bounded safety ceiling derived from seeded fixture plus batch/single mutation sample volume
    const maxDistributionPages =
      Math.ceil((fixtureCount + samplesPerRoute * (1 + 20 + 20) + 100) / pageSize) + 5;
    while (!sawFinalDistributionPage) {
      expect(distributionPageCount).toBeLessThan(maxDistributionPages);
      distributionPageCount += 1;
      const body = await measuredListPage(
        `distribution page at offset ${distributionOffset}`,
        () =>
          Effect.runPromise(
            coreService.listDistributions(env, queryBudgetClaims, {
              limit: pageSize,
              offset: distributionOffset,
            }),
          ),
        (page) => page.distributions.length,
        1,
      );
      expect(body.distributions.length).toBeLessThanOrEqual(pageSize);
      for (const distribution of body.distributions) {
        expect(distributionIds.has(distribution.id)).toBe(false);
        distributionIds.add(distribution.id);
      }
      if (body.has_more) {
        expect(body.distributions).toHaveLength(pageSize);
      } else {
        sawFinalDistributionPage = true;
      }
      distributionOffset += pageSize;
    }
    expect(sawFinalDistributionPage).toBe(true);
    expect(distributionIds.size).toBeGreaterThanOrEqual(fixtureCount);

    const inboxIds: string[] = [];
    for (const offset of [0, pageSize, 2 * pageSize, 3 * pageSize]) {
      const body = await measuredListPage(
        `inbox page at offset ${offset}`,
        () =>
          Effect.runPromise(
            coreService.inbox(env, queryBudgetClaims, {
              limit: pageSize,
              offset,
            }),
          ),
        (page) => page.comments.length,
        1,
      );
      expect(body.limit).toBe(pageSize);
      expect(body.offset).toBe(offset);
      if (offset === 3 * pageSize) {
        expect(body.comments).toEqual([]);
        expect(body.has_more).toBe(false);
      } else {
        expect(body.comments).toHaveLength(
          offset === 2 * pageSize ? fixtureCount - 2 * pageSize : pageSize,
        );
        expect(body.has_more).toBe(offset !== 2 * pageSize);
      }
      for (const comment of body.comments) {
        inboxIds.push(comment.id);
      }
    }
    expect(new Set(inboxIds).size).toBe(fixtureCount);
  }, 30_000);
});
