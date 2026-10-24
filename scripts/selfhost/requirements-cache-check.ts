// Disposable network smoke: production routing/actor resolution/RLS/crypto and bounded Provider HTTP.
// The upstream is controlled and never publishes content; no cache diagnostic route is added.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import pg from "pg";
import { TokenCipher } from "../../packages/secrets/src/index";

const selfhost = process.env.SELFHOST_DB_PASSWORD !== undefined;
const adminUrl = selfhost
  ? `postgres://postgres:${encodeURIComponent(process.env.SELFHOST_DB_PASSWORD ?? "")}@postgres:5432/meltiply`
  : "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const authenticatedUrl = selfhost
  ? `postgres://meltiply_rls:${encodeURIComponent(process.env.SELFHOST_DB_AUTHENTICATED_PASSWORD ?? "")}@postgres:5432/meltiply`
  : "postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply?sslmode=disable";
const systemUrl = selfhost
  ? `postgres://meltiply_system:${encodeURIComponent(process.env.SELFHOST_DB_SYSTEM_PASSWORD ?? "")}@postgres:5432/meltiply`
  : "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
const scriptPath = process.env.REQUIREMENTS_SMOKE_BUNDLE;
if (!scriptPath) throw new Error("REQUIREMENTS_SMOKE_BUNDLE must name the built disposable Worker");
const pool = new pg.Pool({ connectionString: adminUrl });
const profileId = randomUUID();
const accountId = randomUUID();
const key = randomBytes(32).toString("base64url");
const cipher = new TokenCipher({
  currentKeyId: "primary",
  keys: [{ id: "primary", material: key }],
});
let upstreamCalls = 0;
let held = false;
const pending: (() => void)[] = [];
const observations: {
  scenario: string;
  api_requests: number;
  canceled_requests: number;
  upstream_calls: number;
  latency_ms: { count: number; mean: number; p95: number };
}[] = [];
let runtime: Miniflare | undefined;

/** Waits for observable progress, with a deadline; no fixed-duration sleep substitutes for readiness. */
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

/** Observes completed persisted account checks; this cannot prove a caller has already joined a flight. */
async function accountReads(): Promise<number> {
  const result = await pool.query<{ calls: number }>(
    `SELECT COALESCE(sum(calls), 0)::int AS calls FROM pg_stat_statements
     WHERE query LIKE 'SELECT platform, platform_user_id, access_token, connection_status%'`,
  );
  return result.rows[0]?.calls ?? 0;
}

/** Releases every controlled upstream read; the production HTTP client still enforces its normal deadline. */
function release() {
  held = false;
  for (const resolve of pending.splice(0)) resolve();
}

/** Records completed-response latency and every started request, including explicitly canceled callers; preparation is excluded. */
function record(scenario: string, before: number, samples: { ms: number }[], canceled = 0) {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  observations.push({
    scenario,
    api_requests: samples.length + canceled,
    canceled_requests: canceled,
    upstream_calls: upstreamCalls - before,
    latency_ms: {
      count: samples.length,
      mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p95: latencies[Math.ceil(latencies.length * 0.95) - 1]!,
    },
  });
}

try {
  const owner = await pool.query<{ org_id: string; auth_user_id: string; email: string }>(
    `SELECT om.org_id, u.auth_user_id, u.email FROM users u JOIN org_members om ON om.user_id = u.id
     JOIN organizations o ON o.id = om.org_id AND o.is_shared = TRUE
     WHERE u.installation_owner = TRUE AND u.suspended_at IS NULL LIMIT 1`,
  );
  const identity = owner.rows[0];
  assert.ok(identity, "Disposable database must have its real Installation Owner");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  await pool.query(
    "INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, 'Requirements smoke', '#1d4ed8')",
    [profileId, identity.org_id],
  );
  await pool.query(
    `INSERT INTO platform_accounts (id, org_id, brand_profile_id, platform, platform_user_id, access_token, scopes, connection_status)
     VALUES ($1, $2, $3, 'tiktok', $4, $5, ARRAY['user.info.basic','video.publish'], 'connected')`,
    [
      accountId,
      identity.org_id,
      profileId,
      `requirements-${accountId}`,
      await cipher.encrypt("controlled-generation-one"),
    ],
  );
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      host: "127.0.0.1",
      cf: {},
      telemetry: { enabled: false },
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "requirements-network-smoke",
          modules: true,
          scriptPath,
          compatibilityDate: "2026-07-18",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            ENVIRONMENT: "local",
            VERSION: "requirements-network-smoke",
            DATABASE_POOL_MODE: "request",
            ALLOWED_ORIGINS: "http://localhost:3000",
            FRONTEND_URL: "http://localhost:3000",
            PUBLIC_API_URL: "https://requirements-smoke.test",
            TOKEN_ENCRYPTION_KEY: key,
            SMOKE_SUBJECT: identity.auth_user_id,
            SMOKE_EMAIL: identity.email,
          },
          hyperdrives: { DB_AUTHENTICATED: authenticatedUrl, DB_SYSTEM: systemUrl },
          serviceBindings: {
            REQUIREMENTS_UPSTREAM: async () => {
              const attempt = ++upstreamCalls;
              if (held) await new Promise<void>((resolve) => pending.push(resolve));
              return Response.json({
                commentAllowed: true,
                creatorAvatarUrl: "https://example.test/avatar.png",
                creatorDisplayName: `Attempt ${attempt}`,
                creatorUsername: "controlled.creator",
                duetAllowed: false,
                maxVideoDurationSeconds: 180,
                platform: "tiktok",
                privacyLevels: ["PUBLIC_TO_EVERYONE"],
                stitchAllowed: true,
              });
            },
          },
        },
      ],
    }),
  );
  const origin = (await runtime.ready).origin;
  /** Uses a real TCP HTTP dispatch; each response must retain its own caller correlation. */
  async function request(id: string, signal?: AbortSignal, expected = 200) {
    const start = performance.now();
    const response = await fetch(
      `${origin}/api/v1/platforms/${accountId}/publishing-requirements`,
      {
        headers: { authorization: "Bearer controlled-requirements-smoke", "X-Request-ID": id },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      },
    );
    assert.equal(
      response.status,
      expected,
      `Requirements HTTP status for ${id}: ${response.status === expected ? "" : (await response.text()).slice(0, 1000)}`,
    );
    assert.equal(response.headers.get("X-Request-ID"), id);
    const body: unknown = await response.json();
    return { ms: performance.now() - start, body };
  }
  let before = upstreamCalls;
  const sequential = [];
  for (let sample = 0; sample < 20; sample++)
    sequential.push(await request(`sequential-${sample}`));
  assert.equal(upstreamCalls - before, 20, "Completed requirement reads must never be retained");
  record("sequential-cold-and-after-settlement", before, sequential);

  before = upstreamCalls;
  let reads = await accountReads();
  held = true;
  const concurrent = Array.from({ length: 20 }, (_, index) => request(`concurrent-${index}`));
  await until(async () => (await accountReads()) >= reads + 20, "twenty fresh account checks");
  release();
  const concurrentResults = await Promise.all(concurrent);
  assert.ok(
    upstreamCalls - before < concurrent.length,
    "The held network burst must demonstrate avoided upstream work",
  );
  // Transport cannot acknowledge private flight acquisition. Late callers may
  // correctly start a new read after settlement; record rather than misclassify
  // that scheduling as a cache failure. Distinct upstream attempts have distinct data.
  assert.equal(
    new Set(concurrentResults.map((result) => JSON.stringify(result.body))).size,
    upstreamCalls - before,
  );
  record("concurrent-equivalent", before, concurrentResults);

  before = upstreamCalls;
  reads = await accountReads();
  held = true;
  const abortLeader = new AbortController();
  const leader = request("disconnect-leader", abortLeader.signal).then(
    () => "completed",
    () => "aborted",
  );
  await until(() => pending.length === 1, "leader upstream fetch");
  const follower = request("disconnect-follower");
  await until(async () => (await accountReads()) >= reads + 2, "follower fresh account check");
  abortLeader.abort();
  assert.equal(await leader, "aborted");
  release();
  const survivingFollower = await follower;
  assert.ok(upstreamCalls - before <= 2);
  record("leader-network-disconnect", before, [survivingFollower], 1);

  before = upstreamCalls;
  reads = await accountReads();
  held = true;
  const survivingLeader = request("joiner-disconnect-leader");
  await until(() => pending.length === 1, "second leader upstream fetch");
  const abortJoiner = new AbortController();
  const joiner = request("joiner-disconnect", abortJoiner.signal).then(
    () => "completed",
    () => "aborted",
  );
  await until(async () => (await accountReads()) >= reads + 2, "joiner fresh account check");
  abortJoiner.abort();
  assert.equal(await joiner, "aborted");
  release();
  const survivingLeaderResult = await survivingLeader;
  assert.ok(upstreamCalls - before <= 2);
  record("joiner-network-disconnect", before, [survivingLeaderResult], 1);

  before = upstreamCalls;
  held = true;
  const priorGeneration = request("generation-before");
  await until(() => pending.length === 1, "old generation upstream fetch");
  await pool.query(
    "UPDATE platform_accounts SET access_token = $2, updated_at = clock_timestamp() WHERE id = $1",
    [accountId, await cipher.encrypt("controlled-generation-two")],
  );
  const nextGeneration = request("generation-after");
  await until(() => pending.length === 2, "new generation independent upstream fetch");
  release();
  const generationResults = await Promise.all([priorGeneration, nextGeneration]);
  assert.notDeepEqual(generationResults[0]?.body, generationResults[1]?.body);
  assert.equal(upstreamCalls - before, 2);
  record("credential-rotation", before, generationResults);

  before = upstreamCalls;
  held = true;
  const valid = request("before-revoke");
  await until(() => pending.length === 1, "pending valid upstream fetch");
  await pool.query(
    "UPDATE platform_accounts SET revoked_at = now(), connection_status = 'revoked' WHERE id = $1",
    [accountId],
  );
  const revokedResult = await request("after-revoke", undefined, 409);
  release();
  const validResult = await valid;
  assert.equal(upstreamCalls - before, 1);
  record("revoke-during-flight", before, [validResult, revokedResult]);

  const label = selfhost ? `compose-${process.arch}` : "managed-local-workerd";
  const output = {
    runtime: label,
    upstream: "disposable controlled HTTP binding, not live Provider acceptance",
    observations,
  };
  const directory = process.env.REQUIREMENTS_SMOKE_OUTPUT ?? "artifacts/cache";
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${label}-requirements.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
} finally {
  release();
  await runtime?.dispose();
  await pool.query("DELETE FROM platform_accounts WHERE id = $1", [accountId]);
  await pool.query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
  await pool.end();
}
