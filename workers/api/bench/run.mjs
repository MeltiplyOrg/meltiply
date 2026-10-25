// Reproducible backend benchmark runner.
//
// It builds the API Worker in-process, connects to a dedicated PostgreSQL
// database prepared by `prepare-database.mjs`, seeds one deterministic
// Workspace, and times representative read, mutation, Asset, publishing, and
// bulk-deletion workflows. Every measured operation runs through the real
// service or Hono route; only fixture setup uses the privileged connection.
//
// Usage:
//   BENCHMARK_DATABASE_AUTHENTICATED_URL=... \
//   BENCHMARK_DATABASE_SYSTEM_URL=... \
//   BENCHMARK_LABEL=baseline BENCHMARK_OUTPUT_FILE=results/baseline.json \
//   bun workers/api/bench/run.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

import { configureLogSampling } from "@meltiply/observability";
import { createStorageServiceTest } from "@meltiply/storage";
import { createThreadsAdapter, ProviderRegistry } from "@meltiply/providers";
import { TokenCipher } from "@meltiply/secrets";
import { Effect } from "effect";
import pg from "pg";

import { createApiApp } from "../src/app.ts";
import { createAssetApiService } from "../src/asset-service.ts";
import { authenticatedPoolFor, systemPoolFor } from "../src/database.ts";
import { createCoreApiService } from "../src/core-service.ts";
import { createPostApiService } from "../src/post-service.ts";
import {
  cleanup,
  cleanupDeleteBatches,
  cleanupMutatedRows,
  dataset,
  ids,
  resetUsage,
  seed,
  seedDeleteBatch,
} from "./fixtures.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const authenticatedUrl = requiredEnv("BENCHMARK_DATABASE_AUTHENTICATED_URL");
const systemUrl = requiredEnv("BENCHMARK_DATABASE_SYSTEM_URL");
const outputFile = resolve(
  repositoryRoot,
  process.env.BENCHMARK_OUTPUT_FILE ?? "benchmark-results/benchmark.json",
);
const label = process.env.BENCHMARK_LABEL ?? "benchmark";
const profile = process.env.BENCHMARK_PROFILE ?? "all";
if (!["all", "read-cache", "application"].includes(profile))
  throw new TypeError("Unknown BENCHMARK_PROFILE");
const warmupSamples = integerEnv("BENCHMARK_WARMUP", 3, 0, 100);
const measuredSamples = integerEnv("BENCHMARK_SAMPLES", 20, 1, 1_000);
if (warmupSamples + measuredSamples > dataset.schedulePosts) {
  throw new TypeError(
    `BENCHMARK_WARMUP + BENCHMARK_SAMPLES (${warmupSamples + measuredSamples}) ` +
      `exceeds the ${dataset.schedulePosts} schedule fixture Posts`,
  );
}
const deleteWarmup = integerEnv("BENCHMARK_DELETE_WARMUP", 1, 0, 100);
const deleteSamples = integerEnv("BENCHMARK_DELETE_SAMPLES", 3, 1, 100);
const deleteConcurrency = integerEnv("BENCHMARK_DELETE_CONCURRENCY", 4, 1, 10);
const batchSizes = (process.env.BENCHMARK_DELETE_BATCH_SIZES ?? "1,5,10,25,50")
  .split(",")
  .map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new TypeError("BENCHMARK_DELETE_BATCH_SIZES must list integers between 1 and 100");
    }
    return parsed;
  });

/** Reads a required environment variable, failing before any fixture work. */
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Reads a bounded integer environment variable. */
function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Computes a nearest-rank percentile over unsorted samples. */
function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index];
}

/** Rounds a number to two decimals for stable JSON and report output. */
function rounded(value) {
  return Math.round(value * 100) / 100;
}

/** Summarizes a latency or size distribution without substituting estimates. */
function summarize(values) {
  return {
    count: values.length,
    max: rounded(Math.max(...values)),
    mean: rounded(values.reduce((total, value) => total + value, 0) / values.length),
    min: rounded(Math.min(...values)),
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    p99: rounded(percentile(values, 0.99)),
  };
}

/** Classifies a SQL statement the same way the existing query-budget suite does. */
function statementKind(text) {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return "transaction";
  if (normalized.includes("set_config('request.jwt.claims'")) return "context";
  return "application";
}

/** Mutable per-scenario capture shared by every pooled connection. */
const capture = { queries: [] };
const instrumentedClients = new WeakSet();

/** Wraps every pooled client's query method so statements and timings are recorded. */
function instrumentPool(pool) {
  const mutable = pool;
  const originalConnect = mutable.connect.bind(pool);
  mutable.connect = async (...args) => {
    const client = await originalConnect(...args);
    if (instrumentedClients.has(client)) return client;
    instrumentedClients.add(client);
    const originalQuery = client.query.bind(client);
    client.query = async (textOrConfig, values) => {
      const text =
        typeof textOrConfig === "string" ? textOrConfig : String(textOrConfig?.text ?? "");
      const started = performance.now();
      const result = await originalQuery(textOrConfig, values);
      capture.queries.push({
        durationMs: performance.now() - started,
        kind: statementKind(text),
        statement: text.trim().replaceAll(/\s+/g, " "),
      });
      return result;
    };
    return client;
  };
}

configureLogSampling(0);

// This key is disposable and never serialized to artifacts. The production JWT
// verifier fetches its public half over HTTP; live sessions and actor resolution
// use the benchmark database rather than injected authentication callbacks.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwks = JSON.stringify({
  keys: [
    { ...publicKey.export({ format: "jwk" }), kid: "benchmark-key", alg: "EdDSA", use: "sig" },
  ],
});
const jwksServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(jwks);
});
await new Promise((resolve, reject) => {
  jwksServer.once("error", reject);
  jwksServer.listen(0, "127.0.0.1", resolve);
});
const address = jwksServer.address();
assert.ok(address && typeof address === "object");
const authOrigin = "https://benchmark.invalid";
const nowSeconds = Math.floor(Date.now() / 1000);
const encodedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "benchmark-key" })).toString(
  "base64url",
);
const encodedClaims = Buffer.from(
  JSON.stringify({
    sub: "auth_user_benchmark",
    sid: "benchmark-session",
    email: "benchmark@meltiply.local",
    name: "Benchmark User",
    iss: authOrigin,
    aud: authOrigin,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }),
).toString("base64url");
const signingInput = `${encodedHeader}.${encodedClaims}`;
const bearer = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString: authenticatedUrl },
  DB_SYSTEM: { connectionString: systemUrl },
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "benchmark",
  PUBLIC_API_URL: authOrigin,
  BETTER_AUTH_JWKS_URL: `http://127.0.0.1:${address.port}/jwks`,
};

const claims = {
  organizationId: ids.org,
  organizationRole: "admin",
  subject: "auth_user_benchmark",
  userId: ids.user,
};

const authorization = { Authorization: `Bearer ${bearer}` };

const providerRegistry = new ProviderRegistry();
providerRegistry.register(
  "threads",
  createThreadsAdapter({
    clientId: "benchmark-threads-client",
    clientSecret: "benchmark-threads-client-secret",
    redirectUri: "https://benchmark.invalid/oauth/threads/callback",
  }),
);
const capabilities = providerRegistry.capabilities();
const providerDelayMs = 100;
const readConcurrency = 20;
const requirementAccountId = "b7000000-0000-4000-8000-000000000001";
let upstreamReads = 0;
const requirementData = {
  commentAllowed: true,
  creatorDisplayName: "Benchmark Creator",
  creatorUsername: "benchmark.creator",
  duetAllowed: false,
  maxVideoDurationSeconds: 180,
  platform: "tiktok",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  stitchAllowed: false,
};
const tiktokCapability = providerRegistry
  .capabilities()
  .find((value) => value.platform === "tiktok");
assert.ok(tiktokCapability);
providerRegistry.register("tiktok", {
  capability: {
    ...tiktokCapability,
    analytics: false,
    comments: false,
    reply: false,
    publish: false,
    connect_available: false,
  },
  transferModes: [],
  // Fixed synthetic upstream latency exposes overlapping reads equally on both
  // revisions. This is a controlled adapter, not live Provider timing.
  getPublicationRequirements: async () => {
    upstreamReads += 1;
    await delay(providerDelayMs);
    return requirementData;
  },
});

const assetService = createAssetApiService({
  storageServiceLayer: createStorageServiceTest({
    signDownload: ({ key }) => Effect.succeed(`https://r2.example/download/${key}`),
    signMultipartPart: ({ key, partNumber }) =>
      Effect.succeed(`https://r2.example/upload/${key}?partNumber=${partNumber}`),
    signUpload: ({ key }) => Effect.succeed(`https://r2.example/upload/${key}`),
  }),
});
const coreService = createCoreApiService(capabilities);
const postService = createPostApiService(capabilities);
const app = createApiApp({
  assetService,
  coreService,
  postService,
  providerRegistry,
});

instrumentPool(authenticatedPoolFor(env));
instrumentPool(systemPoolFor(env));

const admin = new pg.Client({ connectionString: systemUrl });
await admin.connect();
const databaseVersion = (await admin.query("SHOW server_version")).rows[0].server_version;

let idempotencyCounter = 0;
let deleteTagCounter = 0;

/** Executes one in-process HTTP request and records status, body, and bytes. */
async function httpRequest(path, init, expectedStatuses = [200]) {
  const started = performance.now();
  const response = await app.request(path, init, env);
  const text = await response.text();
  const durationMs = performance.now() - started;
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${init?.method ?? "GET"} ${path} returned HTTP ${response.status}: ${text}`);
  }
  return {
    body: text === "" ? null : JSON.parse(text),
    bytes: Buffer.byteLength(text),
    durationMs,
  };
}

/** Adds the JSON headers every mutation route expects. */
function mutationHeaders(key) {
  return {
    ...authorization,
    "Content-Type": "application/json",
    "Idempotency-Key": key,
    "X-Request-ID": key,
  };
}

/** Runs async work over a fixed-size worker pool. */
async function mapLimit(items, limit, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

const calendarStart = "2026-07-01T00:00:00.000Z";
const calendarEnd = "2026-08-31T23:59:59.999Z";
const analyticsStart = "2026-01-01T00:00:00.000Z";
const analyticsEnd = "2026-12-31T23:59:59.999Z";
let analyticsRangeCounter = 0;

/** Builds a unique exact range per cold sample, preserving the same fixed published cohort. */
function coldAnalyticsPath() {
  analyticsRangeCounter += 1;
  const end = new Date(Date.parse(analyticsEnd) - analyticsRangeCounter).toISOString();
  return `/api/v1/analytics?start=${encodeURIComponent(analyticsStart)}&end=${encodeURIComponent(end)}`;
}

/** Measures one fresh range or one concurrent burst, validating canonical totals in every response. */
async function analyticsRead(path, concurrency = 1) {
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => httpRequest(path, { headers: authorization })),
  );
  for (const result of results) {
    // Stored counters remain canonical even when one Platform is marked partial.
    assert.equal(result.body.totals.post_count, dataset.posts);
    assert.equal(result.body.totals.views, (dataset.posts * (dataset.posts + 1)) / 2);
  }
  return {
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    latencyMs: performance.now() - started,
    operations: concurrency,
    requestLatencies: results.map((result) => result.durationMs),
  };
}

/** Measures sequential or overlapping requirements through real account/RLS/decryption and route code. */
async function requirementReads(concurrency) {
  const before = upstreamReads;
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      httpRequest(`/api/v1/platforms/${requirementAccountId}/publishing-requirements`, {
        headers: authorization,
      }),
    ),
  );
  for (const result of results) {
    assert.deepEqual(result.body, {
      platform: "tiktok",
      comment_allowed: true,
      creator: {
        avatar_url: null,
        display_name: "Benchmark Creator",
        username: "benchmark.creator",
      },
      duet_allowed: false,
      max_video_duration_sec: 180,
      privacy_levels: ["PUBLIC_TO_EVERYONE"],
      stitch_allowed: false,
    });
  }
  return {
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    latencyMs: performance.now() - started,
    operations: concurrency,
    requestLatencies: results.map((result) => result.durationMs),
    upstreamReads: upstreamReads - before,
  };
}

/** Runs the three reads the Posts UI refetches after a successful deletion. */
async function refetchPostResources() {
  const [posts, distributions, calendar] = await Promise.all([
    httpRequest(`/api/v1/posts?limit=50&offset=0`, { headers: authorization }),
    httpRequest(`/api/v1/distributions?limit=${dataset.distributionLimit}&offset=0`, {
      headers: authorization,
    }),
    httpRequest(
      `/api/v1/calendar?start=${encodeURIComponent(calendarStart)}&end=${encodeURIComponent(calendarEnd)}`,
      { headers: authorization },
    ),
  ]);
  return posts.bytes + distributions.bytes + calendar.bytes;
}

/** Builds one measured deletion sample for a batch size and execution mode. */
function deleteScenario({ batchSize, concurrency, mode }) {
  const name = `posts.delete.${mode}.batch${batchSize}`;
  let postIds = [];
  return {
    beforeSample: async () => {
      await cleanupDeleteBatches(admin);
      deleteTagCounter += 1;
      postIds = await seedDeleteBatch(admin, `${batchSize}-${mode}-${deleteTagCounter}`, batchSize);
    },
    name,
    run: async () => {
      const requestLatencies = [];
      let bytes = 0;
      let deleted = 0;
      const deleteOne = async (postId) => {
        idempotencyCounter += 1;
        const key = `benchmark-delete-${deleteTagCounter}-${idempotencyCounter}`;
        const result = await httpRequest(
          `/api/v1/posts/${postId}`,
          {
            body: JSON.stringify({ brand_profile_id: ids.brandProfile }),
            headers: mutationHeaders(key),
            method: "DELETE",
          },
          [200],
        );
        requestLatencies.push(result.durationMs);
        bytes += result.bytes;
        deleted += 1;
        if (mode.includes("per-item")) bytes += await refetchPostResources();
      };
      const started = performance.now();
      if (concurrency === 1) {
        for (const postId of postIds) await deleteOne(postId);
      } else {
        await mapLimit(postIds, concurrency, deleteOne);
      }
      if (!mode.includes("per-item")) bytes += await refetchPostResources();
      return {
        bytes,
        latencyMs: performance.now() - started,
        operations: deleted,
        requestLatencies,
      };
    },
    samples: deleteSamples,
    warmup: deleteWarmup,
  };
}

/** Builds the read and bounded-mutation scenarios over the seeded dataset. */
function scenarios() {
  const scenarios = [
    {
      name: "posts.list.page100",
      run: async () => {
        const result = await httpRequest(`/api/v1/posts?limit=100&offset=0`, {
          headers: authorization,
        });
        if (result.body.posts.length !== 100) throw new Error("expected a full Posts page");
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "posts.detail.published",
      run: async () => {
        const result = await httpRequest(`/api/v1/posts/${ids.post(150)}`, {
          headers: authorization,
        });
        if (result.body.attachments.length !== 1) throw new Error("expected one attachment");
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "distributions.list.page100",
      run: async () => {
        const result = await httpRequest(`/api/v1/distributions?limit=100&offset=0`, {
          headers: authorization,
        });
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "calendar.range",
      run: async () => {
        const result = await httpRequest(
          `/api/v1/calendar?start=${encodeURIComponent(calendarStart)}&end=${encodeURIComponent(calendarEnd)}`,
          { headers: authorization },
        );
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "analytics.summary.year",
      run: () =>
        analyticsRead(
          `/api/v1/analytics?start=${encodeURIComponent(analyticsStart)}&end=${encodeURIComponent(analyticsEnd)}`,
        ),
    },
    {
      name: "analytics.summary.cold-exact-range",
      run: () => analyticsRead(coldAnalyticsPath()),
    },
    {
      name: "analytics.summary.concurrent-cold20",
      run: () => analyticsRead(coldAnalyticsPath(), readConcurrency),
    },
    {
      name: "requirements.sequential",
      run: () => requirementReads(1),
    },
    {
      name: "requirements.concurrent20",
      run: () => requirementReads(readConcurrency),
    },
    {
      name: "analytics.page.dashboard-and-ranking",
      run: async () => {
        const started = performance.now();
        const range = `start=${encodeURIComponent(analyticsStart)}&end=${encodeURIComponent(analyticsEnd)}`;
        const [dashboard, ranking] = await Promise.all([
          httpRequest(`/api/v1/analytics/dashboard?${range}`, { headers: authorization }),
          httpRequest(`/api/v1/analytics/posts?${range}&metric=views&limit=10&offset=0`, {
            headers: authorization,
          }),
        ]);
        assert.equal(dashboard.body.cohort.totals.post_count, dataset.posts);
        assert.equal(dashboard.body.cohort.totals.views, (dataset.posts * (dataset.posts + 1)) / 2);
        assert.equal(ranking.body.posts[0].views, dataset.posts);
        return {
          bytes: dashboard.bytes + ranking.bytes,
          latencyMs: performance.now() - started,
          operations: 2,
          requestLatencies: [dashboard.durationMs, ranking.durationMs],
        };
      },
    },
    {
      name: "inbox.list.page100",
      run: async () => {
        const result = await httpRequest(`/api/v1/inbox?limit=100&offset=0`, {
          headers: authorization,
        });
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "assets.detail",
      run: async () => {
        const result = await httpRequest(`/api/v1/assets/${ids.asset(1)}`, {
          headers: authorization,
        });
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "assets.upload-session.detail",
      run: async () => {
        const result = await httpRequest(`/api/v1/asset-upload-sessions/${ids.uploadSession}`, {
          headers: authorization,
        });
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "posts.create.draft",
      beforeSample: async () => {
        await cleanupMutatedRows(admin);
      },
      run: async () => {
        idempotencyCounter += 1;
        const key = `benchmark-create-${idempotencyCounter}`;
        const result = await httpRequest(
          `/api/v1/posts`,
          {
            body: JSON.stringify({
              brand_profile_id: ids.brandProfile,
              default_text: `Benchmark create ${idempotencyCounter}`,
              title: `benchmark-create-${idempotencyCounter}`,
            }),
            headers: mutationHeaders(key),
            method: "POST",
          },
          [201],
        );
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "posts.schedule.fanout20",
      beforeSample: async () => {
        await cleanupMutatedRows(admin);
      },
      run: async () => {
        const index = sampleIndex.schedule;
        sampleIndex.schedule += 1;
        if (index >= dataset.schedulePosts) {
          throw new Error("schedule fixture exhausted; raise dataset.schedulePosts");
        }
        idempotencyCounter += 1;
        const key = `benchmark-schedule-${idempotencyCounter}`;
        const result = await httpRequest(
          `/api/v1/posts/${ids.schedulePost(index + 1)}/schedule`,
          {
            body: JSON.stringify({ brand_profile_id: ids.brandProfile, scheduled_at: null }),
            headers: mutationHeaders(key),
            method: "POST",
          },
          [200],
        );
        if (result.body.distributions.length !== dataset.scheduleChannels) {
          throw new Error("expected one Distribution per saved target");
        }
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    // Restore the same 20-Channel schedule outside measurement before dropping
    // 19 targets. Reuse the last seeded Post only after the fan-out scenario.
    {
      name: "posts.schedule.drop19",
      beforeSample: async () => {
        await cleanupMutatedRows(admin);
        idempotencyCounter += 1;
        await httpRequest(`/api/v1/posts/${ids.schedulePost(dataset.schedulePosts)}/schedule`, {
          body: JSON.stringify({
            brand_profile_id: ids.brandProfile,
            scheduled_at: null,
            targets: Array.from({ length: dataset.scheduleChannels }, (_, index) => ({
              platform_account_id: ids.threadAccount(index + 1),
            })),
          }),
          headers: mutationHeaders(`benchmark-restore-schedule-${idempotencyCounter}`),
          method: "POST",
        });
      },
      run: async () => {
        idempotencyCounter += 1;
        const result = await httpRequest(
          `/api/v1/posts/${ids.schedulePost(dataset.schedulePosts)}/schedule`,
          {
            body: JSON.stringify({
              brand_profile_id: ids.brandProfile,
              scheduled_at: null,
              targets: [{ platform_account_id: ids.threadAccount(1) }],
            }),
            headers: mutationHeaders(`benchmark-drop-schedule-${idempotencyCounter}`),
            method: "POST",
          },
        );
        let cancelled = 0;
        let queued = 0;
        for (const row of result.body.distributions) {
          if (row.status === "cancelled") cancelled += 1;
          if (row.status === "queued") queued += 1;
        }
        if (cancelled !== dataset.scheduleChannels - 1 || queued !== 1) {
          throw new Error("expected 19 cancelled Distributions and one queued target");
        }
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
    {
      name: "assets.upload-session.create",
      beforeSample: async () => {
        await cleanupMutatedRows(admin);
        await resetUsage(admin);
      },
      run: async () => {
        idempotencyCounter += 1;
        const key = `benchmark-upload-${idempotencyCounter}`;
        const result = await httpRequest(
          `/api/v1/asset-upload-sessions`,
          {
            body: JSON.stringify({
              asset_type: "image",
              brand_profile_id: ids.brandProfile,
              content_type: "image/png",
              file_size: 1_024,
              filename: `benchmark-upload-${idempotencyCounter}.png`,
              title: `benchmark-upload-${idempotencyCounter}`,
            }),
            headers: mutationHeaders(key),
            method: "POST",
          },
          [201],
        );
        return { bytes: result.bytes, latencyMs: result.durationMs, operations: 1 };
      },
    },
  ];

  for (const batchSize of batchSizes) {
    scenarios.push(
      deleteScenario({ batchSize, concurrency: 1, mode: "sequential-per-item-refetch" }),
      deleteScenario({ batchSize, concurrency: 1, mode: "sequential-single-refetch" }),
      deleteScenario({
        batchSize,
        concurrency: deleteConcurrency,
        mode: `bounded${deleteConcurrency}-per-item-refetch`,
      }),
      deleteScenario({
        batchSize,
        concurrency: deleteConcurrency,
        mode: `bounded${deleteConcurrency}-single-refetch`,
      }),
    );
  }
  return profile === "read-cache" || profile === "application"
    ? scenarios.filter((scenario) =>
        /^(posts\.list|posts\.detail|distributions\.list|calendar\.|analytics\.|requirements\.|inbox\.list|assets\.detail|assets\.upload-session\.detail)/.test(
          scenario.name,
        ),
      )
    : scenarios;
}

const sampleIndex = { schedule: 0 };

/** Runs one scenario with warm-up, measured samples, and per-scenario DB capture. */
async function measureScenario(scenario) {
  const samplesToRun = scenario.samples ?? measuredSamples;
  const warmupsToRun = scenario.warmup ?? warmupSamples;
  for (let index = 0; index < warmupsToRun; index += 1) {
    await scenario.beforeSample?.();
    await scenario.run();
  }

  capture.queries = [];
  const measuredQueries = [];
  const sampleResults = [];
  const cpuAfter = { system: 0, user: 0 };
  let setupMs = 0;
  const rssBefore = process.memoryUsage().rss;
  for (let index = 0; index < samplesToRun; index += 1) {
    const setupStarted = performance.now();
    await scenario.beforeSample?.();
    setupMs += performance.now() - setupStarted;
    capture.queries.length = 0;
    // Fixture creation and cleanup are excluded from CPU and latency: start the
    // resource clock only around the operation being measured.
    const cpuBefore = process.cpuUsage();
    const result = await scenario.run();
    const cpuDelta = process.cpuUsage(cpuBefore);
    cpuAfter.system += cpuDelta.system;
    cpuAfter.user += cpuDelta.user;
    measuredQueries.push(...capture.queries);
    sampleResults.push(result);
  }
  const rssAfter = process.memoryUsage().rss;
  const resourceUsage = process.resourceUsage();

  const totalOperations = sampleResults.reduce(
    (total, sample) => total + (sample.operations ?? 1),
    0,
  );
  const applicationQueries = measuredQueries.filter((query) => query.kind === "application");
  const statementCounts = new Map();
  for (const query of applicationQueries) {
    statementCounts.set(query.statement, (statementCounts.get(query.statement) ?? 0) + 1);
  }
  const topStatements = [...statementCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([statement, count]) => ({ count, statement }));

  return {
    cpu_ms: {
      per_operation: rounded((cpuAfter.user + cpuAfter.system) / 1_000 / totalOperations),
      system_total: rounded(cpuAfter.system / 1_000),
      user_total: rounded(cpuAfter.user / 1_000),
    },
    db: {
      application_statements_per_operation: rounded(applicationQueries.length / totalOperations),
      context_statements: measuredQueries.length - applicationQueries.length,
      statement_ms: summarize(applicationQueries.map((query) => query.durationMs)),
      statements_total: applicationQueries.length,
      time_ms_total: rounded(
        applicationQueries.reduce((total, query) => total + query.durationMs, 0),
      ),
      top_statements: topStatements,
      aggregate_executions: applicationQueries.filter(
        (query) =>
          query.statement.includes("WITH candidates AS (") &&
          query.statement.includes("analytics_snapshots"),
      ).length,
      aggregate_time_ms_total: rounded(
        applicationQueries
          .filter(
            (query) =>
              query.statement.includes("WITH candidates AS (") &&
              query.statement.includes("analytics_snapshots"),
          )
          .reduce((total, query) => total + query.durationMs, 0),
      ),
    },
    latency_ms: summarize(sampleResults.map((sample) => sample.latencyMs)),
    operations: totalOperations,
    request_latency_ms: summarize(
      sampleResults.flatMap((sample) => sample.requestLatencies ?? [sample.latencyMs]),
    ),
    request_samples_ms: sampleResults
      .flatMap((sample) => sample.requestLatencies ?? [sample.latencyMs])
      .map(rounded),
    response_bytes: summarize(sampleResults.map((sample) => sample.bytes)),
    response_bytes_samples: sampleResults.map((sample) => Math.round(sample.bytes)),
    rss_bytes: {
      after: rssAfter,
      before: rssBefore,
      heap_used_end: process.memoryUsage().heapUsed,
      peak: resourceUsage.maxRSS * 1_024,
    },
    samples: samplesToRun,
    samples_ms: sampleResults.map((sample) => rounded(sample.latencyMs)),
    setup_ms_total: rounded(setupMs),
    throughput_rps: rounded(
      totalOperations /
        (sampleResults.reduce((total, sample) => total + sample.latencyMs, 0) / 1_000),
    ),
    warmup: warmupsToRun,
    upstream_reads: sampleResults.reduce((sum, sample) => sum + (sample.upstreamReads ?? 0), 0),
  };
}

/** Collects git revision metadata so reports identify both revisions exactly. */
function revisionMetadata() {
  const git = (...args) =>
    spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  return {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    ref: process.env.BENCHMARK_REF ?? null,
    sha: git("rev-parse", "HEAD"),
  };
}

const startedAt = new Date().toISOString();
const started = performance.now();
let failed = false;
const workflows = [];

try {
  await seed(admin);
  const cipher = new TokenCipher({
    currentKeyId: "primary",
    keys: [{ id: "primary", material: env.TOKEN_ENCRYPTION_KEY }],
  });
  await admin.query(
    `INSERT INTO platform_accounts
     (id, org_id, brand_profile_id, platform, platform_user_id, access_token, scopes, connection_status)
     VALUES ($1, $2, $3, 'tiktok', 'benchmark-requirements', $4, ARRAY['video.publish'], 'connected')`,
    [
      requirementAccountId,
      ids.org,
      ids.brandProfile,
      await cipher.encrypt("benchmark-provider-token"),
    ],
  );
  await cleanupDeleteBatches(admin);
  for (const scenario of scenarios()) {
    process.stdout.write(`running ${scenario.name}\n`);
    try {
      workflows.push({ metrics: await measureScenario(scenario), name: scenario.name });
    } catch (cause) {
      failed = true;
      workflows.push({
        error: cause instanceof Error ? cause.message : String(cause),
        name: scenario.name,
      });
    }
  }
} finally {
  await cleanup(admin).catch(() => {});
  await admin.end().catch(() => {});
  await new Promise((resolve, reject) =>
    jwksServer.close((error) => (error ? reject(error) : resolve())),
  );
}

const result = {
  completed_at: new Date().toISOString(),
  config: {
    profile,
    authentication: "signed-jwt-live-session-actor",
    batch_sizes: batchSizes,
    delete_concurrency: deleteConcurrency,
    delete_samples: deleteSamples,
    delete_warmup: deleteWarmup,
    measured_samples: measuredSamples,
    warmup_samples: warmupSamples,
    read_concurrency: readConcurrency,
    controlled_provider_delay_ms: providerDelayMs,
  },
  dataset: {
    ...dataset,
    batch_delete_posts_per_sample: batchSizes,
  },
  environment: {
    arch: process.arch,
    database: "postgres",
    database_version: databaseVersion,
    platform: process.platform,
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
  },
  label,
  revision: revisionMetadata(),
  started_at: startedAt,
  duration_ms: rounded(performance.now() - started),
  workflows,
};

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`wrote ${outputFile}\n`);
if (failed && process.env.BENCHMARK_ALLOW_ERRORS !== "1") process.exitCode = 1;
