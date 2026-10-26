import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ownerBrowserSession } from "../../frontend/app/e2e/selfhost-auth-smoke.mjs";
import { cacheSmoke } from "../benchmarks/backend/cache-smoke.mjs";

const composeArgs = [
  "compose",
  "--env-file",
  ".env.selfhost",
  "-f",
  "compose.selfhost.yml",
  "--profile",
  "verification",
];
/** Runs only this deployment's services, preserving command failures and binary fixture bytes. */
function compose(...args) {
  return execFileSync("docker", [...composeArgs, ...args], { maxBuffer: 8 * 1024 * 1024 });
}
/** Invokes the container-private operational socket; no diagnostics endpoint is exposed publicly. */
function admin(...args) {
  return JSON.parse(
    compose("exec", "-T", "runtime", "node", "scripts/selfhost/admin.mjs", ...args).toString(),
  );
}
const origin = "http://localhost:8080";
let token;
/** Exercises the public API and reports bounded error bodies without logging credentials or verification URLs. */
async function api(path, body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    expected,
    `${path}: ${response.status}: ${response.status === expected ? "" : (await response.text()).slice(0, 1500)}`,
  );
  return response.json();
}

await api("/api/v1/ready");
const response = await fetch(origin);
assert.equal(response.status, 200);
const html = await response.text();
assert.match(html, /<html/i);
assert.doesNotMatch(html, /\/@vite\/client/);
for (const path of ["/cdn-cgi/local/explorer", "/cdn-cgi/handler/scheduled"]) {
  assert.equal((await fetch(`${origin}${path}`)).status, 404);
}
const operatorPath = `${origin}/operator/v1/selfhost-probe`;
assert.equal((await fetch(operatorPath)).status, 403);
const operator = admin("token", "operator@example.com");
assert.equal(
  (
    await fetch(operatorPath, {
      headers: { "Cf-Access-Jwt-Assertion": `${operator.token}invalid` },
    })
  ).status,
  403,
);
assert.equal(
  (await fetch(operatorPath, { headers: { "Cf-Access-Jwt-Assertion": operator.token } })).status,
  404,
);
console.log("Production app, readiness, private routing, and operator authentication passed");

const email = `selfhost-${randomUUID()}@example.com`;
const password = `Selfhost-${randomUUID()}!`;
const setupSecret = parseEnv(await readFile(".env.selfhost", "utf8")).AUTH_SETUP_SECRET;
assert.equal(typeof setupSecret, "string");
const cookie = await ownerBrowserSession({ origin, email, password, setupSecret });
const minted = await fetch(`${origin}/api/auth/token`, { headers: { cookie, origin } });
assert.equal(minted.status, 200);
token = (await minted.json()).token;
assert.equal(typeof token, "string");
const identity = await api("/api/v1/users/me");
assert.ok(identity, "Authenticated identity must resolve from PostgreSQL");
const profile = await api(
  "/api/v1/brand-profiles",
  { name: "Selfhost smoke", description: "Production image acceptance", color: "#1d4ed8" },
  201,
);
// Test-only privileged observation runs outside workerd; the public API still authenticates normally.
await cacheSmoke({
  origin,
  cookie,
  label: `compose-${process.arch}`,
  observeMemory: async () => {
    const containerId = compose("ps", "-q", "runtime").toString().trim();
    return {
      container_working_set: execFileSync(
        "docker",
        ["stats", "--no-stream", "--format", "{{.MemUsage}}", containerId],
        { encoding: "utf8" },
      ).trim(),
    };
  },
  query: async (text, values = []) =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          ...composeArgs,
          "exec",
          "-T",
          "runtime",
          "node",
          "--input-type=module",
          "-e",
          `import pg from './scripts/selfhost/node_modules/pg/lib/index.js';
           import { readFileSync } from 'node:fs';
           const { text, values } = JSON.parse(readFileSync(0, 'utf8'));
           const pool = new pg.Pool({host:'postgres',user:'postgres',database:'meltiply',password:process.env.SELFHOST_DB_PASSWORD});
           try { const result = await pool.query(text, values); console.log(JSON.stringify({rows: result.rows})); }
           finally { await pool.end(); }`,
        ],
        { input: JSON.stringify({ text, values }), encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
    ),
});
// Run independently dispatched Provider reads inside the exact production runtime image.
// Only the disposable Worker/driver are copied to writable tmpfs; production routes stay unchanged.
execFileSync(
  "docker",
  [
    ...composeArgs,
    "exec",
    "-T",
    "runtime",
    "node",
    "--input-type=module",
    "-e",
    `import { mkdir, writeFile, symlink } from 'node:fs/promises';
     import { readFileSync } from 'node:fs';
     const payload = JSON.parse(readFileSync(0, 'utf8'));
     await mkdir('/tmp/cache-proof', {recursive:true});
     await symlink('/app/scripts/selfhost/node_modules', '/tmp/cache-proof/node_modules');
     await writeFile('/tmp/cache-proof/worker.js', payload.worker);
     await writeFile('/tmp/cache-proof/check.mjs', payload.driver);`,
  ],
  {
    input: JSON.stringify({
      worker: await readFile("artifacts/cache-provider-worker/requirements-smoke.js", "utf8"),
      driver: await readFile("scripts/selfhost/.requirements-cache-check.mjs", "utf8"),
    }),
    maxBuffer: 1024 * 1024,
  },
);
compose(
  "exec",
  "-T",
  "-e",
  "REQUIREMENTS_SMOKE_BUNDLE=/tmp/cache-proof/worker.js",
  "-e",
  "REQUIREMENTS_SMOKE_OUTPUT=/tmp/cache-proof/artifacts",
  "runtime",
  "node",
  "/tmp/cache-proof/check.mjs",
);
const requirementsEvidence = JSON.parse(
  compose(
    "exec",
    "-T",
    "runtime",
    "node",
    "--input-type=module",
    "-e",
    `import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync('/tmp/cache-proof/artifacts/compose-${process.arch}-requirements.json'));`,
  ).toString(),
);
await writeFile(
  `artifacts/cache/compose-${process.arch}-requirements.json`,
  JSON.stringify(requirementsEvidence, null, 2),
);
console.log(JSON.stringify(requirementsEvidence));
compose(
  "exec",
  "-T",
  "runtime",
  "node",
  "--input-type=module",
  "-e",
  "import {rm} from 'node:fs/promises'; await rm('/tmp/cache-proof',{recursive:true});",
);
const png = compose(
  "exec",
  "-T",
  "processor",
  "ffmpeg",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=640x640",
  "-frames:v",
  "1",
  "-f",
  "image2pipe",
  "-vcodec",
  "png",
  "pipe:1",
);
const upload = await api(
  "/api/v1/asset-upload-sessions",
  {
    asset_type: "image",
    brand_profile_id: profile.id,
    content_type: "image/png",
    file_size: png.byteLength,
    filename: "selfhost.png",
    title: "Selfhost processor smoke",
  },
  201,
);
const grant = upload.upload_session.single_upload;
assert.ok(grant, "Small images must receive a single-part upload capability");
const put = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: png });
const storageFailure = put.ok ? "" : await put.text();
assert.ok(
  put.ok,
  `Signed R2 upload failed: ${put.status}; code=${storageFailure.match(/<Code>([^<]+)<[/]Code>/)?.[1] ?? "unknown"}; canonicalHost=${storageFailure.match(/host:([^\n<]+)/)?.[1] ?? "unknown"}; expectedHost=${new URL(grant.url).host}`,
);
// Signature tampering must not permit an object overwrite.
const invalidGrant = new URL(grant.url);
invalidGrant.searchParams.set("X-Amz-Signature", "0".repeat(64));
assert.equal(
  (await fetch(invalidGrant, { method: grant.method, headers: grant.headers, body: png })).status,
  403,
);
await api(`/api/v1/asset-upload-sessions/${upload.upload_session.id}/complete`, {}, 202);
let asset;
for (let attempt = 0; attempt < 180; attempt++) {
  asset = await api(`/api/v1/assets/${upload.asset.id}`);
  if (asset.status === "ready") break;
  assert.notEqual(
    asset.status,
    "failed",
    `Media processing failed: ${JSON.stringify(asset.failure)}`,
  );
  await delay(1000);
}
assert.equal(
  asset.status,
  "ready",
  "Actual queue and native processor must finish the uploaded image",
);
assert.equal(asset.width, 640);
assert.equal(asset.height, 640);
console.log(
  "SMTP verification, production authentication, RLS database, signed storage, durable queue, and native media processing passed",
);

const probeId = randomUUID();
assert.equal(admin("probe-write", probeId, identity.active_organization.id).prepared, true);
// SIGKILL, not graceful shutdown: queued delays and workflow/OAuth state must
// survive an unexpected runtime loss. Restart the shared-network processor too.
compose("kill", "-s", "SIGKILL", "runtime", "processor");
compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "runtime", "processor");
assert.deepEqual(admin("probe-read", probeId, identity.active_organization.id), {
  storage: "recovered",
  oauth: "single-use",
  queue: "recovered",
  workflow: "complete",
});
await api("/api/v1/users/me");
assert.equal((await api(`/api/v1/assets/${upload.asset.id}`)).status, "ready");
console.log(
  "Crash recovery preserved sessions, PostgreSQL records, R2 objects, delayed queue messages, OAuth consumption, and workflow execution",
);

/**
 * Restores a consistent, stopped-runtime backup into a separate disposable
 * Compose project. PostgreSQL, runtime volume, application revision, and secret
 * environment are restored together; the source volumes are never overwritten.
 * Validates real authentication and independent R2/OAuth/Queue/Workflow state.
 * Timings describe this fixture only, not a deployed installation's RPO/RTO.
 * Protected archives are deleted after the clone has been torn down.
 */
async function verifyFullRestore() {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-restore-"));
  await chmod(directory, 0o700);
  const protectedEnv = join(directory, "environment");
  const dump = join(directory, "postgres.dump");
  const archive = join(directory, "runtime.tar");
  const project = `meltiply-restore-${randomUUID()}`;
  const args = composeArgs.map((argument) =>
    argument === ".env.selfhost" ? protectedEnv : argument,
  );
  args.push("--project-name", project);
  const options = {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SELFHOST_ENV_FILE: protectedEnv },
  };
  /** Addresses only the freshly named recovery project, never the source deployment. */
  const recover = (...command) => execFileSync("docker", [...args, ...command], options);
  const probe = randomUUID();
  assert.equal(admin("probe-write", probe, identity.active_organization.id).prepared, true);
  try {
    const backupStarted = performance.now();
    compose("stop", "runtime", "processor", "smtp-test");
    await copyFile(".env.selfhost", protectedEnv);
    await chmod(protectedEnv, 0o600);
    const source = compose("ps", "-a", "-q", "runtime").toString().trim();
    assert.match(source, /^[0-9a-f]+$/u);
    for (const [path, command] of [
      [
        dump,
        [
          ...composeArgs,
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "-U",
          "postgres",
          "-d",
          "meltiply",
          "-Fc",
        ],
      ],
      [archive, ["cp", `${source}:/data/.`, "-"]],
    ]) {
      const output = openSync(path, "wx", 0o600);
      try {
        execFileSync("docker", command, { stdio: ["ignore", output, "inherit"] });
      } finally {
        closeSync(output);
      }
    }
    const backupMs = performance.now() - backupStarted;
    const restoreStarted = performance.now();
    recover("up", "-d", "--wait", "--wait-timeout", "120", "postgres");
    recover("run", "--rm", "migrate");
    const input = openSync(dump, "r");
    try {
      execFileSync(
        "docker",
        [
          ...args,
          "exec",
          "-T",
          "postgres",
          "pg_restore",
          "-U",
          "postgres",
          "-d",
          "meltiply",
          "--clean",
          "--if-exists",
          "--exit-on-error",
        ],
        { ...options, stdio: [input, "inherit", "inherit"] },
      );
    } finally {
      closeSync(input);
    }
    recover("up", "--no-start", "--no-deps", "--no-build", "runtime");
    const target = recover("ps", "-a", "-q", "runtime").toString().trim();
    assert.match(target, /^[0-9a-f]+$/u);
    const runtimeArchive = openSync(archive, "r");
    try {
      execFileSync("docker", ["cp", "-a", "-", `${target}:/data`], {
        stdio: [runtimeArchive, "inherit", "inherit"],
      });
    } finally {
      closeSync(runtimeArchive);
    }
    recover("up", "-d", "--no-deps", "--no-build", "--wait", "--wait-timeout", "120", "smtp-test");
    recover(
      "up",
      "-d",
      "--no-deps",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "120",
      "runtime",
      "processor",
    );
    const recovered = JSON.parse(
      recover(
        "exec",
        "-T",
        "runtime",
        "node",
        "scripts/selfhost/admin.mjs",
        "probe-read",
        probe,
        identity.active_organization.id,
      ).toString(),
    );
    assert.deepEqual(recovered, {
      storage: "recovered",
      oauth: "single-use",
      queue: "recovered",
      workflow: "complete",
    });
    assert.equal(
      (await api("/api/v1/users/me")).active_organization.id,
      identity.active_organization.id,
    );
    assert.equal((await api(`/api/v1/assets/${upload.asset.id}`)).status, "ready");
    const evidence = {
      scope: "disposable full Compose restore",
      source_quiesced: true,
      backup_ms: backupMs,
      restore_to_authenticated_ready_ms: performance.now() - restoreStarted,
      postgres_backup_bytes: (await stat(dump)).size,
      runtime_backup_bytes: (await stat(archive)).size,
      recovered,
      production_rpo_rto_verified: false,
    };
    await writeFile(
      `artifacts/cache/compose-${process.arch}-restore.json`,
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence));
  } catch (error) {
    await writeFile(
      "artifacts/cache/restore-runtime.log",
      recover("logs", "--no-color", "--tail", "100", "runtime").toString(),
    );
    throw error;
  } finally {
    // These volumes were created above solely for this recovery exercise.
    try {
      recover("down", "--volumes", "--remove-orphans");
    } finally {
      await rm(directory, { recursive: true, force: true });
      compose(
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "120",
        "smtp-test",
        "runtime",
        "processor",
      );
    }
  }
}
await verifyFullRestore();
