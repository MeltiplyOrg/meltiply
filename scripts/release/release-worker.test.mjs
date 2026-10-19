import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  deployWorkerStep,
  findUniqueTaggedVersion,
  injectWorkerSecrets,
  parseDeploymentStatus,
  parseRollbackVersionOutput,
  parseSecretVersionOutput,
  parseVersionDetails,
  parseVersionList,
  parseWranglerOutput,
  resolveDeployPhase,
  validateSecretBundle,
} from "./release-worker.mjs";

const version = "11111111-1111-1111-1111-111111111111";
const otherVersion = "22222222-2222-2222-2222-222222222222";
const secretVersion = "33333333-3333-3333-3333-333333333333";

test("Wrangler machine output yields one exact Worker version ID", () => {
  const source = [
    JSON.stringify({ type: "wrangler-session", version: 1 }),
    JSON.stringify({
      type: "version-upload",
      version: 1,
      worker_name: "meltiply-api",
      version_id: version,
      preview_url: "https://preview.example.workers.dev",
      preview_alias_url: null,
    }),
  ].join("\n");
  assert.deepEqual(parseWranglerOutput(source, "version-upload", "meltiply-api"), {
    preview_alias_url: null,
    preview_url: "https://preview.example.workers.dev",
    version_id: version,
  });
  assert.throws(
    () => parseWranglerOutput(`${source}\n${source}`, "version-upload", "meltiply-api"),
    /exactly one version-upload/,
  );
  assert.throws(
    () =>
      parseWranglerOutput(
        source.replace(version, "not-a-version"),
        "version-upload",
        "meltiply-api",
      ),
    /version ID is invalid/,
  );
  assert.throws(
    () => parseWranglerOutput(source, "version-upload", "meltiply-state"),
    /Worker name does not match/,
  );
});

test("secret and rollback output parsing is strict and ANSI-safe", () => {
  assert.equal(
    parseSecretVersionOutput(
      `\u001b[32m✨ Success! Created version ${version} with 6 secrets.\u001b[0m\n`,
      6,
    ),
    version,
  );
  assert.equal(parseRollbackVersionOutput(`\nCurrent Version ID: ${version}\n`), version);
  assert.throws(
    () => parseSecretVersionOutput(`Created version ${version}`, 1),
    /exactly one created version ID/,
  );
  assert.throws(
    () => parseSecretVersionOutput(`Success! Created version ${version} with 5 secrets.`, 6),
    /count does not match/,
  );
});

test("version lists and deployment traffic reject malformed control-plane data", () => {
  assert.deepEqual(
    parseVersionList(
      JSON.stringify([
        { id: version, annotations: { "workers/tag": "candidate" } },
        { id: otherVersion, annotations: {} },
      ]),
    ),
    [
      { id: version, tag: "candidate" },
      { id: otherVersion, tag: null },
    ],
  );
  assert.deepEqual(
    parseDeploymentStatus(
      JSON.stringify({
        versions: [
          { version_id: version, percentage: 25 },
          { version_id: otherVersion, percentage: 75 },
        ],
      }),
    ),
    [
      { version_id: version, percentage: 25 },
      { version_id: otherVersion, percentage: 75 },
    ],
  );
  assert.throws(
    () =>
      parseDeploymentStatus(
        JSON.stringify({ versions: [{ version_id: version, percentage: 99 }] }),
      ),
    /must total 100 percent/,
  );
  assert.throws(
    () =>
      findUniqueTaggedVersion(
        [
          { id: version, tag: "duplicate" },
          { id: otherVersion, tag: "duplicate" },
        ],
        "duplicate",
      ),
    /duplicate versions/,
  );
});

test("version details bind API and Automation code to the release SHA", () => {
  const source = JSON.stringify({
    annotations: { "workers/tag": "release-api-secrets" },
    id: version,
    resources: {
      bindings: [{ name: "VERSION", text: "a".repeat(40), type: "plain_text" }],
    },
  });
  assert.equal(
    parseVersionDetails(source, {
      gitSha: "a".repeat(40),
      id: version,
      tag: "release-api-secrets",
      worker: "api",
    }).id,
    version,
  );
  assert.throws(
    () =>
      parseVersionDetails(source, {
        gitSha: "b".repeat(40),
        id: version,
        tag: "release-api-secrets",
        worker: "api",
      }),
    /VERSION binding does not match/,
  );
});

test("deploy phases distinguish first initialization from version updates", () => {
  assert.deepEqual(
    resolveDeployPhase("state-bootstrap", "initialize", {
      deployment_mode: "bootstrap",
    }),
    { mode: "bootstrap", step: "initialize", worker: "state" },
  );
  assert.deepEqual(resolveDeployPhase("api-update", "upload", { deployment_mode: "update" }), {
    mode: "update",
    step: "upload",
    worker: "api",
  });
  assert.throws(
    () =>
      resolveDeployPhase("api-update", "activate", {
        deployment_mode: "update",
      }),
    /not valid for api-update/,
  );
  assert.throws(
    () =>
      resolveDeployPhase("api-update", "upload", {
        deployment_mode: "bootstrap",
      }),
    /does not match deployment_mode/,
  );
});

test("stdin secret bundles require exact worker-specific names without recording values", () => {
  const spec = {
    runtime: {},
    provider_acceptance: {
      facebook: false,
      instagram: false,
      threads: false,
      tiktok: false,
      youtube: false,
    },
  };
  const common = {
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    TOKEN_ENCRYPTION_KEY: "encryption-key",
  };
  const source = JSON.stringify({
    api: {
      ...common,
      BETTER_AUTH_SECRET: "better-auth-secret",
      AUTH_SETUP_SECRET: "bootstrap-placeholder-not-a-real-secret",
    },
    automation: common,
  });
  const result = validateSecretBundle(source, spec, "api");
  assert.deepEqual(result.names, [
    "AUTH_SETUP_SECRET",
    "BETTER_AUTH_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "TOKEN_ENCRYPTION_KEY",
  ]);
  assert.throws(
    () =>
      validateSecretBundle(
        JSON.stringify({
          ...JSON.parse(source),
          api: { ...JSON.parse(source).api, UNKNOWN_SECRET: "not-allowed" },
        }),
        spec,
        "api",
      ),
    /unknown keys: UNKNOWN_SECRET/,
  );
  assert.throws(() => validateSecretBundle(source, spec, "state"), /only for API and Automation/);
});

test("Automation update uploads code, creates a stdin secret version, and activates it", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "release-worker-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  await mkdir(path.join(outDir, "wrangler"));
  await writeFile(
    path.join(outDir, "wrangler/automation.json"),
    JSON.stringify({ name: "meltiply-automation", main: "worker.ts" }),
  );

  const gitSha = "a".repeat(40);
  const spec = {
    runtime: {},
    deployment_mode: "update",
    git_sha: gitSha,
    provider_acceptance: {
      facebook: false,
      instagram: false,
      threads: false,
      tiktok: false,
      youtube: false,
    },
    release_id: `staging-${gitSha.slice(0, 12)}`,
  };
  const codeTag = `${spec.release_id}-automation-code`;
  const secretTag = `${spec.release_id}-automation-secrets`;
  let versions = [{ id: version, tag: "previous" }];
  let activeVersion = version;
  // Simulate Wrangler state transitions after Bun's local-binary command prefix.
  async function runCommand(_command, args, options = {}) {
    const wrangler = args.slice(3);
    if (wrangler[0] === "versions" && wrangler[1] === "list") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(
          versions.map((entry) => ({
            id: entry.id,
            annotations: { "workers/tag": entry.tag },
          })),
        ),
      };
    }
    if (wrangler[0] === "deployments" && wrangler[1] === "status") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          versions: [{ percentage: 100, version_id: activeVersion }],
        }),
      };
    }
    if (wrangler[0] === "versions" && wrangler[1] === "upload") {
      assert.ok(wrangler.includes("--strict"));
      versions.unshift({ id: otherVersion, tag: codeTag });
      await writeFile(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({
          type: "version-upload",
          worker_name: "meltiply-automation",
          version_id: otherVersion,
          preview_url: "https://candidate.example.workers.dev",
        })}\n`,
      );
      return { code: 0, stderr: "", stdout: "" };
    }
    if (wrangler[0] === "versions" && wrangler[1] === "view") {
      const id = wrangler[2];
      const found = versions.find((entry) => entry.id === id);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          id,
          annotations: { "workers/tag": found?.tag },
          resources: {
            bindings: [{ name: "VERSION", text: gitSha, type: "plain_text" }],
          },
        }),
      };
    }
    if (wrangler.join(" ").startsWith("versions secret bulk")) {
      assert.equal(typeof options.stdin, "string");
      assert.doesNotMatch(options.stdin, /BETTER_AUTH_SECRET/);
      versions.unshift({ id: secretVersion, tag: secretTag });
      return {
        code: 0,
        stderr: "",
        stdout: `Success! Created version ${secretVersion} with 3 secrets.\n`,
      };
    }
    if (wrangler[0] === "versions" && wrangler[1] === "deploy") {
      activeVersion = secretVersion;
      await writeFile(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        `${JSON.stringify({ type: "version-deploy", worker_name: "meltiply-automation" })}\n`,
      );
      return { code: 0, stderr: "", stdout: "" };
    }
    throw new Error(`unexpected Wrangler command: ${wrangler.join(" ")}`);
  }

  const common = {
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    TOKEN_ENCRYPTION_KEY: "encryption-key",
  };
  const approvals = [{ approval_job: { approved_by: "operator" } }];
  const planDigest = "b".repeat(64);
  await deployWorkerStep({
    approvals,
    environment: {},
    outDir,
    phase: "automation-update",
    planDigest,
    runCommand,
    spec,
    step: "upload",
  });
  await injectWorkerSecrets({
    approvals,
    environment: {},
    outDir,
    planDigest,
    runCommand,
    secretSource: JSON.stringify({
      api: {
        ...common,
        BETTER_AUTH_SECRET: "better-auth-secret",
        AUTH_SETUP_SECRET: "bootstrap-placeholder-not-a-real-secret",
      },
      automation: common,
    }),
    spec,
    worker: "automation",
  });
  const deployed = await deployWorkerStep({
    approvals,
    environment: {},
    outDir,
    phase: "automation-update",
    planDigest,
    runCommand,
    spec,
    step: "activate",
  });

  assert.equal(deployed.version_id, secretVersion);
  assert.equal(
    JSON.parse(await readFile(path.join(outDir, "worker-automation-secrets.json"), "utf8"))
      .secret_names.length,
    3,
  );
});
