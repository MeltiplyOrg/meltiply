import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { validateReleaseSpec } from "./release-lib.mjs";
import { fetchHealth, smokeLiveApi, smokeVersionCandidate } from "./release-smoke.mjs";

const gitSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const candidateVersionId = "11111111-1111-1111-1111-111111111111";
const secretsVersionId = "22222222-2222-2222-2222-222222222222";
const previousVersionId = "33333333-3333-3333-3333-333333333333";
const tag = `staging-${gitSha.slice(0, 12)}-api-secrets`;

/** Supplies a valid reviewed bootstrap release; overrides exercise identity and mode guards. */
function releaseInput(overrides = {}) {
  return {
    schema_version: 1,
    environment: "staging",
    deployment_mode: "bootstrap",
    git_sha: gitSha,
    neon_branch_id: "branch-staging-123",
    neon_project_id: "project-staging-123",
    release_id: `staging-${gitSha.slice(0, 12)}`,
    restore_point_expires_at: "2026-08-05T12:00:00.000Z",
    api_workers_dev_url: "https://meltiply-api.example.workers.dev",
    app_url: "https://staging.meltiply.com",
    automation_guard: { consumers_paused: true, cron_safe: true },
    provider_acceptance: {
      facebook: false,
      instagram: false,
      instagram_engagement: false,
      threads: false,
      threads_engagement: false,
      tiktok: false,
      youtube: false,
    },
    runtime: {
      mail_from_address: "auth@staging.meltiply.com",
      r2_account_id: "3".repeat(32),
    },
    ...overrides,
  };
}

// Deterministic control-plane stub: serves release-bound versions view and
// deployment status payloads without touching Cloudflare. `bindings` maps a
// version UUID to the VERSION binding SHA it reports; unknown IDs bind the
// release SHA. `releaseTag` selects the installation's reviewed candidate.
function controlPlane({ bindings = {}, traffic, releaseTag = tag } = {}) {
  return function runCommand(command, args) {
    assert.equal(command, "bun");
    assert.deepEqual(args.slice(0, 3), ["run", "--no-install", "wrangler"]);
    if (args.includes("view")) {
      const id = args[args.indexOf("view") + 1];
      return Promise.resolve({
        stderr: "",
        stdout: JSON.stringify({
          annotations: { "workers/tag": releaseTag },
          id,
          resources: {
            bindings: [
              {
                name: "VERSION",
                text: bindings[id] ?? gitSha,
                type: "plain_text",
              },
            ],
          },
        }),
      });
    }
    if (args.includes("status")) {
      return Promise.resolve({
        stderr: "",
        stdout: JSON.stringify({ versions: traffic }),
      });
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
}

/** Starts an ephemeral real HTTP endpoint and registers owned-server cleanup for each scenario. */
async function withServer(context, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

/** Redirects release HTTPS probes to a local server while preserving headers, cancellation and redirect policy. */
function healthFetch(origin) {
  return function fetchImpl(input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    const target = new URL(url);
    target.protocol = "http:";
    target.host = new URL(origin).host;
    return fetch(target, init);
  };
}

/** Writes release-bound candidate/secret evidence; overrides model corruption without remote mutations. */
async function seedCandidate(outDir, spec, overrides = {}) {
  await mkdir(path.join(outDir, "wrangler"), { recursive: true });
  const base = {
    git_sha: spec.git_sha,
    release_id: spec.release_id,
    schema_version: 1,
  };
  await writeFile(
    path.join(outDir, "worker-api-candidate.json"),
    JSON.stringify({
      ...base,
      config_digest: "c".repeat(64),
      deployment_mode: spec.deployment_mode,
      previous_version_id: spec.deployment_mode === "bootstrap" ? null : previousVersionId,
      preview_alias_url: null,
      preview_url: null,
      step: spec.deployment_mode === "bootstrap" ? "initialize" : "upload",
      version_id: candidateVersionId,
      worker: "api",
      ...overrides.candidate,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(outDir, "worker-api-secrets.json"),
    JSON.stringify({
      ...base,
      based_on_version_id: candidateVersionId,
      secret_names: ["R2_ACCESS_KEY_ID"],
      version_id: secretsVersionId,
      worker: "api",
      ...overrides.secrets,
    }),
    { mode: 0o600 },
  );
}

/** A production probe accepts production health and rejects a staging endpoint at the same origin. */
test("health probe matches the released environment rather than assuming staging", async () => {
  for (const environment of ["production", "staging"]) {
    const probe = fetchHealth({
      expectedEnvironment: "production",
      fetchImpl: async () =>
        new Response(JSON.stringify({ environment, status: "ok", version: gitSha })),
      origin: "https://app.example.com",
      requestBudgetMs: 5000,
    });
    if (environment === "production") assert.equal((await probe).environment, "production");
    else await assert.rejects(probe, /production contract/);
  }
});

/** Both immutable and live smoke compare health against the selected production installation. */
test("production version and live smoke reject a staging endpoint", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-production-smoke-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const spec = validateReleaseSpec(
    releaseInput({
      environment: "production",
      release_id: `production-${gitSha.slice(0, 12)}`,
      api_workers_dev_url: "https://meltiply-api-production.example.workers.dev",
    }),
  );
  await seedCandidate(outDir, spec);
  const traffic = [{ percentage: 100, version_id: secretsVersionId }];
  await writeFile(
    path.join(outDir, "worker-api-deployment.json"),
    JSON.stringify({
      git_sha: spec.git_sha,
      release_id: spec.release_id,
      schema_version: 1,
      traffic,
      version_id: secretsVersionId,
      worker: "api",
    }),
  );
  let servedEnvironment = "production";
  const params = {
    environment: {},
    outDir,
    spec,
    runCommand: controlPlane({ traffic, releaseTag: `${spec.release_id}-api-secrets` }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ environment: servedEnvironment, status: "ok", version: gitSha }),
      ),
  };
  assert.equal((await smokeVersionCandidate(params)).health.environment, "production");
  assert.equal((await smokeLiveApi(params)).health.environment, "production");
  servedEnvironment = "staging";
  await assert.rejects(smokeVersionCandidate(params), /production contract/);
  await assert.rejects(smokeLiveApi(params), /production contract/);
});

/** Malformed or non-staging health responses cannot authorize release promotion. */
test("health probe rejects mismatched and malformed envelopes", async (context) => {
  const spec = validateReleaseSpec(releaseInput());
  const cases = [
    [{ environment: "production", status: "ok", version: gitSha }], // wrong env
    [{ environment: "staging", status: "degraded", version: gitSha }], // not ok
    [{ environment: "staging", status: "ok", version: "not-a-sha" }], // unpinned version
    [{ environment: "staging", status: "ok", version: gitSha, debug: 1 }], // extra key
    [{ environment: "staging", version: gitSha }], // missing key
  ];
  for (const [payload] of cases) {
    const origin = await withServer(context, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    await assert.rejects(
      fetchHealth({
        expectedEnvironment: spec.environment,
        fetchImpl: healthFetch(origin),
        origin: spec.app_url,
        requestBudgetMs: 5000,
      }),
      /staging contract|outside the release traffic set/,
    );
  }
  const failing = await withServer(context, (_request, response) => {
    response.writeHead(503).end();
  });
  await assert.rejects(
    fetchHealth({
      expectedEnvironment: spec.environment,
      fetchImpl: healthFetch(failing),
      origin: spec.app_url,
      requestBudgetMs: 5000,
    }),
    /status 503/,
  );
});

/** Missing or mismatched identity evidence and foreign health SHAs fail before smoke publication. */
test("version smoke fails closed on evidence, binding, and health drift", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-smoke-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const spec = validateReleaseSpec(releaseInput());
  const origin = await withServer(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ environment: "staging", status: "ok", version: gitSha }));
  });
  const base = {
    environment: {},
    fetchImpl: healthFetch(origin),
    runCommand: controlPlane(),
    spec,
  };

  // Missing evidence files fail closed.
  await assert.rejects(
    smokeVersionCandidate({ ...base, outDir }),
    /API candidate evidence|ENOENT|must contain valid JSON/,
  );

  await seedCandidate(outDir, spec);

  // Candidate evidence from another release is rejected.
  const tamperedDir = await mkdtemp(path.join(tmpdir(), "meltiply-smoke-"));
  context.after(() => rm(tamperedDir, { force: true, recursive: true }));
  await seedCandidate(tamperedDir, spec, {
    candidate: { git_sha: previousSha },
  });
  await assert.rejects(
    smokeVersionCandidate({ ...base, outDir: tamperedDir }),
    /does not match the release/,
  );

  // A VERSION binding pinned to another SHA fails the control-plane check.
  await assert.rejects(
    smokeVersionCandidate({
      ...base,
      outDir,
      runCommand: controlPlane({
        bindings: { [secretsVersionId]: previousSha },
      }),
    }),
    /VERSION binding does not match/,
  );

  // A health payload serving the wrong release is terminal without retry.
  let hits = 0;
  const wrongOrigin = await withServer(context, (_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        environment: "staging",
        status: "ok",
        version: previousSha,
      }),
    );
  });
  await assert.rejects(
    smokeVersionCandidate({
      ...base,
      fetchImpl: healthFetch(wrongOrigin),
      outDir,
    }),
    /outside the release traffic set/,
  );
  assert.equal(hits, 1);
});

/** Partial canaries may serve the verified previous SHA without accepting an unrelated version. */
test("update live smoke binds the rollout percentage and accepts the previous version", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-smoke-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const spec = validateReleaseSpec(releaseInput({ deployment_mode: "update" }));
  await seedCandidate(outDir, spec);
  const base = {
    git_sha: spec.git_sha,
    release_id: spec.release_id,
    schema_version: 1,
  };
  const traffic = [
    { percentage: 5, version_id: secretsVersionId },
    { percentage: 95, version_id: previousVersionId },
  ].sort((left, right) => left.version_id.localeCompare(right.version_id));
  await writeFile(
    path.join(outDir, "api-rollout-5.json"),
    JSON.stringify({
      ...base,
      percentage: 5,
      traffic,
      version_id: secretsVersionId,
      worker: "api",
    }),
    { mode: 0o600 },
  );

  // During a 5% rollout the hostname may legitimately serve the previous
  // release; the control plane binds that version's SHA so a third-party
  // version still fails closed.
  const origin = await withServer(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        environment: "staging",
        status: "ok",
        version: previousSha,
      }),
    );
  });
  const evidence = await smokeLiveApi({
    environment: {},
    fetchImpl: healthFetch(origin),
    outDir,
    percentage: 5,
    runCommand: controlPlane({
      bindings: { [previousVersionId]: previousSha },
      traffic,
    }),
    spec,
  });
  assert.equal(evidence.percentage, 5);
  const written = JSON.parse(await readFile(path.join(outDir, "smoke-live-5.json"), "utf8"));
  assert.equal(written.health.version, previousSha);
});

/** Mode, traffic and serving-version guards prevent stale or foreign live deployments from passing. */
test("live smoke rejects wrong mode, stale traffic, and foreign versions", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-smoke-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const spec = validateReleaseSpec(releaseInput());
  await seedCandidate(outDir, spec);
  const base = {
    git_sha: spec.git_sha,
    release_id: spec.release_id,
    schema_version: 1,
  };
  const traffic = [{ percentage: 100, version_id: secretsVersionId }];
  await writeFile(
    path.join(outDir, "worker-api-deployment.json"),
    JSON.stringify({
      ...base,
      traffic,
      version_id: secretsVersionId,
      worker: "api",
    }),
    { mode: 0o600 },
  );

  const origin = await withServer(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ environment: "staging", status: "ok", version: gitSha }));
  });
  const params = {
    environment: {},
    fetchImpl: healthFetch(origin),
    outDir,
    runCommand: controlPlane({ traffic }),
    spec,
  };

  // Bootstrap forbids --percentage; update requires it.
  await assert.rejects(smokeLiveApi({ ...params, percentage: 25 }), /does not accept --percentage/);
  await assert.rejects(
    smokeLiveApi({
      ...params,
      spec: validateReleaseSpec(releaseInput({ deployment_mode: "update" })),
    }),
    /requires --percentage/,
  );

  // Control-plane traffic that diverges from deployment evidence fails closed.
  await assert.rejects(
    smokeLiveApi({
      ...params,
      runCommand: controlPlane({
        traffic: [
          { percentage: 90, version_id: secretsVersionId },
          { percentage: 10, version_id: previousVersionId },
        ],
      }),
    }),
    /does not match the release traffic set/,
  );

  // A hostname serving a version outside the release set is rejected.
  const foreign = await withServer(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        environment: "staging",
        status: "ok",
        version: "c".repeat(40),
      }),
    );
  });
  await assert.rejects(
    smokeLiveApi({ ...params, fetchImpl: healthFetch(foreign) }),
    /outside the release traffic set/,
  );
});

/**
 * A real TCP reset must consume one bounded retry, not become a terminal
 * health-contract violation; zero pacing keeps this transition deterministic.
 */
test("version smoke retries a transport reset before recording healthy evidence", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-smoke-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const spec = validateReleaseSpec(releaseInput());
  await seedCandidate(outDir, spec);
  let hits = 0;
  const origin = await withServer(context, (request, response) => {
    hits += 1;
    if (hits === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ environment: "staging", status: "ok", version: gitSha }));
  });
  const evidence = await smokeVersionCandidate({
    environment: {},
    fetchImpl: healthFetch(origin),
    outDir,
    pollAttempts: 2,
    pollIntervalMs: 0,
    runCommand: controlPlane(),
    spec,
  });
  assert.equal(evidence.attempts, 2);
  assert.equal(hits, 2);
});
