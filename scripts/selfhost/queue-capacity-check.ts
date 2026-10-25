// Production Queue handler + workerd + PostgreSQL. Only the Provider transport
// is controlled; timing begins after fixture setup and Worker readiness.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import pg from "pg";
import { z } from "zod";
import { TokenCipher } from "../../packages/secrets/src/index";

const bundle = process.env.QUEUE_CAPACITY_BUNDLE;
if (!bundle)
  throw new Error("QUEUE_CAPACITY_BUNDLE must name the built controlled-Provider Worker");
const scriptPath = resolve(bundle);
const database = new pg.Pool({
  connectionString:
    "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable",
});
const systemUrl =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
const key = randomBytes(32).toString("base64url");
const cipher = new TokenCipher({
  currentKeyId: "primary",
  keys: [{ id: "primary", material: key }],
});
const observations: {
  concurrency: number;
  elapsed_ms: number;
  first_independent_completion_ms: number;
  maximum_active: number;
  maximum_same_account: number;
  accepted: number;
}[] = [];
const resultSchema = z.object({
  outcome: z.literal("ok"),
  explicitAcks: z.array(z.string()),
  retryMessages: z.array(z.unknown()),
});
const providerRequest = z.object({
  account: z.string(),
  operation: z.string(),
  caption: z.string(),
});

/** Seeds five independent durable publish intents, with two Posts sharing one Provider account. */
async function sample(concurrency: 1 | 2) {
  const organizationId = randomUUID();
  const profiles = Array.from({ length: 4 }, () => randomUUID());
  const accounts = profiles.map(() => randomUUID());
  const posts = Array.from({ length: 5 }, () => randomUUID());
  const distributions = posts.map(() => randomUUID());
  const events = posts.map(() => randomUUID());
  const accountIndexes = [0, 1, 0, 2, 3];
  let runtime: Miniflare | undefined;
  let active = 0;
  let maximumActive = 0;
  let maximumSameAccount = 0;
  let started = 0;
  let firstIndependentCompletion = Number.POSITIVE_INFINITY;
  let slowCompleted = Number.POSITIVE_INFINITY;
  const activeAccounts = new Map<string, number>();
  const accepted = new Map<string, string>();
  try {
    await database.query(
      "INSERT INTO organizations (id, name, slug, plan) VALUES ($1, 'Queue capacity', $2, 'agency')",
      [organizationId, `queue-capacity-${organizationId}`],
    );
    await database.query(
      "INSERT INTO usage_records (org_id, period) VALUES ($1, to_char(now(), 'YYYY-MM'))",
      [organizationId],
    );
    const token = await cipher.encrypt("controlled-provider-token");
    for (let index = 0; index < profiles.length; index += 1) {
      await database.query(
        "INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, $3, '#1d4ed8')",
        [profiles[index], organizationId, `Capacity ${index}`],
      );
      await database.query(
        `INSERT INTO platform_accounts (id, org_id, brand_profile_id, platform, platform_user_id, access_token, connection_status)
        VALUES ($1, $2, $3, 'threads', $4, $5, 'connected')`,
        [accounts[index], organizationId, profiles[index], `capacity-${accounts[index]}`, token],
      );
    }
    for (let index = 0; index < posts.length; index += 1) {
      const owner = accountIndexes[index]!;
      await database.query(
        "INSERT INTO posts (id, org_id, brand_profile_id, default_text) VALUES ($1, $2, $3, $4)",
        [posts[index], organizationId, profiles[owner], index === 0 ? "slow" : "fast"],
      );
      await database.query(
        `INSERT INTO distributions (id, org_id, brand_profile_id, post_id, platform_account_id, platform, status)
        VALUES ($1, $2, $3, $4, $5, 'threads', 'queued')`,
        [distributions[index], organizationId, profiles[owner], posts[index], accounts[owner]],
      );
    }
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: "127.0.0.1",
        port: 0,
        rootPath: dirname(scriptPath),
        cf: {},
        telemetry: { enabled: false },
        log: new Log(LogLevel.ERROR),
        workers: [
          {
            name: "queue-capacity",
            modules: true,
            modulesRoot: dirname(scriptPath),
            scriptPath,
            compatibilityDate: "2026-07-18",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              ENVIRONMENT: "test",
              VERSION: "queue-capacity",
              TOKEN_ENCRYPTION_KEY: key,
              PUBLISH_BATCH_CONCURRENCY: String(concurrency),
              RECURRING_COMMENTS_ENABLED: "false",
              LOG_SAMPLE_RATE: "0",
            },
            hyperdrives: { DB_SYSTEM: systemUrl },
            r2Buckets: { ASSETS: "queue-capacity" },
            serviceBindings: {
              PUBLISH_UPSTREAM: async (request) => {
                const body = providerRequest.parse(await request.json());
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                const sameAccount = (activeAccounts.get(body.account) ?? 0) + 1;
                activeAccounts.set(body.account, sameAccount);
                maximumSameAccount = Math.max(maximumSameAccount, sameAccount);
                try {
                  await delay(body.caption === "slow" ? 500 : 50);
                  const id = `accepted-${randomUUID()}`;
                  assert.ok(!accepted.has(body.operation), "Provider received a duplicate write");
                  accepted.set(body.operation, id);
                  if (body.caption === "slow") slowCompleted = performance.now() - started;
                  else if (body.account !== `capacity-${accounts[0]}`)
                    firstIndependentCompletion = Math.min(
                      firstIndependentCompletion,
                      performance.now() - started,
                    );
                  return new Response(null, { status: 200, headers: { "x-publication-id": id } });
                } finally {
                  active -= 1;
                  activeAccounts.set(body.account, sameAccount - 1);
                }
              },
            },
          },
        ],
      }),
    );
    const { origin } = await runtime.ready;
    const rows = distributions.map((id, index) => ({
      id: events[index],
      content_type: "json",
      created: Date.now(),
      attempts: 1,
      body: {
        type: "outbox.event",
        version: 1,
        event_id: events[index],
        organization_id: organizationId,
        aggregate_id: id,
        topic: "distribution.publish.requested",
        payload: { distribution_id: id, version: 1 },
      },
    }));
    const request = JSON.stringify({
      action: "deliver",
      queue: "meltiply-publish-threads-staging",
      rows,
      metrics: { backlogCount: 5, backlogBytes: 1000 },
    });
    started = performance.now();
    const response = await fetch(`${origin}/deliver`, {
      method: "POST",
      body: request,
    });
    const elapsed = performance.now() - started;
    const decisions = resultSchema.parse(await response.json());
    assert.deepEqual([...decisions.explicitAcks].sort(), [...events].sort());
    assert.deepEqual(decisions.retryMessages, []);
    assert.equal(accepted.size, 5);
    assert.equal(maximumSameAccount, 1, "Same Provider account must stay serialized");
    assert.ok(maximumActive <= concurrency, "Provider fanout exceeded its bound");
    if (concurrency === 1) assert.ok(firstIndependentCompletion > slowCompleted);
    else
      assert.ok(
        firstIndependentCompletion < slowCompleted,
        "A slow account blocked another account",
      );
    const persisted = await database.query<{
      id: string;
      status: string;
      platform_post_id: string;
    }>("SELECT id, status, platform_post_id FROM distributions WHERE id = ANY($1::uuid[])", [
      distributions,
    ]);
    assert.equal(persisted.rows.length, 5);
    assert.ok(
      persisted.rows.every(
        (row) =>
          row.status === "published" && [...accepted.values()].includes(row.platform_post_id),
      ),
    );
    const replay = await fetch(`${origin}/deliver`, {
      method: "POST",
      body: request,
    });
    const replayDecisions = resultSchema.parse(await replay.json());
    assert.deepEqual([...replayDecisions.explicitAcks].sort(), [...events].sort());
    assert.equal(accepted.size, 5, "Redelivery must not republish settled outcomes");
    observations.push({
      concurrency,
      elapsed_ms: elapsed,
      first_independent_completion_ms: firstIndependentCompletion,
      maximum_active: maximumActive,
      maximum_same_account: maximumSameAccount,
      accepted: accepted.size,
    });
  } finally {
    await runtime?.dispose();
    await database.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  }
}
try {
  for (const order of [
    [1, 2],
    [2, 1],
    [1, 2],
  ] as const)
    for (const concurrency of order) await sample(concurrency);
  const report = {
    runtime: "workerd with PostgreSQL and controlled Provider latency",
    slow_provider_ms: 500,
    fast_provider_ms: 50,
    observations,
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/queue-capacity.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await database.end();
}
