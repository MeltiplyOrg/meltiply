import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";

import { git } from "./contract-source.mjs";

const releaseScript = resolve("packages/contracts/scripts/contract-release.mjs");
const output = resolve("artifacts/contract-preview");
await mkdir(output, { recursive: true });

/** Runs the public release CLI; negative scenarios must reject with an actionable diagnostic. */
function release(args, cwd = process.cwd(), expected = 0) {
  const result = spawnSync(process.execPath, [releaseScript, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, expected, `${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

/** Exercises actual release assets and refuses corruption, internal attachments and stale source versions. */
async function releaseSmoke() {
  release(["verify"]);
  const jsonPath = resolve("packages/contracts/dist/release/openapi.json");
  const original = await readFile(jsonPath);
  try {
    await writeFile(jsonPath, "{}\n");
    assert.match(release(["verify"], process.cwd(), 1), /Checksum mismatch/);
  } finally {
    await writeFile(jsonPath, original);
  }
  const extra = resolve("packages/contracts/dist/release/internal.json");
  try {
    await writeFile(extra, "{}\n");
    assert.match(release(["verify"], process.cwd(), 1), /Unexpected release asset/);
  } finally {
    await rm(extra, { force: true });
  }
  assert.match(
    release(["artifacts", "--tag", "contract-v0.0.0"], process.cwd(), 1),
    /tag must equal/,
  );
  release(["verify"]);

  // A disposable Git history tests automatic version decisions at the release CLI seam.
  const directory = await mkdtemp(resolve(tmpdir(), "meltiply-contract-release-"));
  try {
    const contracts = resolve(directory, "packages/contracts");
    await mkdir(contracts, { recursive: true });
    const source = {
      openapi: "3.1.0",
      info: { title: "Release probe", version: "1.2.3" },
      paths: {},
    };
    await writeFile(resolve(contracts, "openapi.yaml"), YAML.stringify(source));
    await writeFile(
      resolve(contracts, "operation-readiness.json"),
      JSON.stringify({ schemaVersion: 1, contractVersion: "1.2.3", operations: {} }),
    );
    await writeFile(
      resolve(contracts, "CHANGELOG.md"),
      "# Contract changelog\n\n## Unreleased\n\n## 1.2.3\n\n- Previous release.\n",
    );
    /** Keeps fixture commits and tags confined to this temporary release repository. */
    const commit = (tag) => {
      for (const args of [
        ["add", "."],
        [
          "-c",
          "user.name=Contract smoke",
          "-c",
          "user.email=contract-smoke@example.test",
          "commit",
          "-m",
          "fixture",
        ],
        ["tag", tag],
      ]) {
        const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
    };
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status, 0);
    commit("contract-v1.2.3");
    source.info.summary = "Corrected contract documentation";
    await writeFile(resolve(contracts, "openapi.yaml"), YAML.stringify(source));
    await writeFile(
      resolve(contracts, "CHANGELOG.md"),
      "# Contract changelog\n\n## Unreleased\n\n- **Patch:** Correct the summary.\n\n## 1.2.3\n\n- Previous release.\n",
    );
    release(["prepare"], directory);
    const prepared = YAML.parse(await readFile(resolve(contracts, "openapi.yaml"), "utf8"));
    assert.equal(prepared.info.version, "1.2.4");
    const preparedNotes = await readFile(resolve(contracts, "CHANGELOG.md"), "utf8");
    release(["prepare"], directory);
    assert.equal(await readFile(resolve(contracts, "CHANGELOG.md"), "utf8"), preparedNotes);
    prepared.info.summary = "A correction made after release preparation";
    await writeFile(resolve(contracts, "openapi.yaml"), YAML.stringify(prepared));
    release(["prepare"], directory);
    assert.equal(
      YAML.parse(await readFile(resolve(contracts, "openapi.yaml"), "utf8")).info.version,
      "1.2.4",
    );
    assert.equal(
      (await readFile(resolve(contracts, "CHANGELOG.md"), "utf8")).match(/^## 1\.2\.4 - /gm)
        ?.length,
      1,
    );
    assert.deepEqual(
      JSON.parse(await readFile(resolve(contracts, "release.json"), "utf8")).changes,
      ["**Patch:** Correct the summary."],
    );
    assert.match(
      release(["artifacts", "--tag", "contract-v1.2.3"], directory, 1),
      /tag must equal/,
    );
    commit("contract-v1.2.4");
    assert.match(release(["prepare"], directory, 1), /No contract content changed/);
    source.info.version = "1.2.4";
    source.info.summary = "Documented breaking contract change";
    await writeFile(resolve(contracts, "openapi.yaml"), YAML.stringify(source));
    await writeFile(
      resolve(contracts, "CHANGELOG.md"),
      "# Contract changelog\n\n## Unreleased\n\n- **Breaking:** Remove a previously required operation; consumers must regenerate.\n\n## 1.2.4\n\n- Previous release.\n",
    );
    assert.match(release(["artifacts"], directory, 1), /metadata is stale/);
    release(["prepare"], directory);
    assert.equal(
      YAML.parse(await readFile(resolve(contracts, "openapi.yaml"), "utf8")).info.version,
      "2.0.0",
    );
    console.log(
      "Release smoke: exact artifacts pass; corruption, internal files, tag mismatch, stale version and unchanged releases rejected; patch and breaking versions advance automatically.",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** Starts the production Worker entry with isolated local bindings and verifies unauthenticated HTTP health. */
async function healthSmoke() {
  const source = YAML.parse(await readFile("packages/contracts/openapi.yaml", "utf8"));
  const log = createWriteStream(resolve(output, "worker.log"));
  const state = await mkdtemp(resolve(tmpdir(), "meltiply-contract-preview-"));
  const child = spawn(
    "bunx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "--config",
      "workers/api/wrangler.test.jsonc",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "8798",
      "--inspector-port",
      "0",
      "--persist-to",
      state,
      "--show-interactive-dev-session=false",
      "--var",
      "VERSION:contract-smoke-app",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = once(child, "exit");
  let response;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        response = await fetch("http://127.0.0.1:8798/api/v1/health", {
          signal: AbortSignal.timeout(1500),
        });
        break;
      } catch {
        await delay(250);
      }
    }
    assert.ok(response, `Worker failed to start; see ${output}/worker.log`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      contract_version: source.info.version,
      environment: "local",
      status: "ok",
      version: "contract-smoke-app",
    });
    assert.ok(response.headers.get("X-Request-ID"));
    const validate = new Ajv({ strict: true }).compile(source.components.schemas.Health);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    const provenance = {
      schemaVersion: 1,
      result: "passed",
      operationIds: ["getHealth"],
      sourceCommit: git("rev-parse", "HEAD"),
      contractVersion: source.info.version,
      runtime:
        "isolated local workerd via Wrangler; production API entry; no authentication or dependencies",
      workflowRun: process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    };
    await writeFile(
      resolve(output, "release.json"),
      `${JSON.stringify({ ...provenance, kind: "release" }, null, 2)}\n`,
    );
    await writeFile(
      resolve(output, "conformance.json"),
      `${JSON.stringify({ ...provenance, kind: "conformance", response: body }, null, 2)}\n`,
    );
    console.log(
      `Health smoke: unauthenticated HTTP 200, contract_version=${body.contract_version}, independent application version=${body.version}; OpenAPI conformance passed.`,
    );
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await exited;
      }
    }
    log.end();
    await rm(state, { force: true, recursive: true });
  }
}

await releaseSmoke();
await healthSmoke();
