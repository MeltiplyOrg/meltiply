import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const setupConfigPath = resolve(root, ".circleci/config.yml");
const continuationConfigPath = resolve(root, ".circleci/continue-config.yml");
const cancelSiblingsPath = resolve(root, "scripts/ci/cancel-siblings-on-failure.sh");

async function readRoutingRules() {
  const source = await readFile(setupConfigPath, "utf8");
  const lines = source.split("\n");
  const mappingIndex = lines.findIndex((line) => line.trim() === "mapping: |");
  assert.notEqual(mappingIndex, -1, "CircleCI path-filter mapping is missing");

  const mappingIndent = lines[mappingIndex].search(/\S/);
  const rules = [];
  for (const line of lines.slice(mappingIndex + 1)) {
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= mappingIndent) break;
    const [pattern, parameter, value, ...extra] = line.trim().split(/\s+/);
    assert.equal(extra.length, 0, `invalid path-filter rule: ${line.trim()}`);
    assert.equal(value, "true", `unsupported path-filter value: ${value}`);
    rules.push({ parameter, pattern: new RegExp(pattern) });
  }
  return rules;
}

async function routedParameters(path) {
  const rules = await readRoutingRules();
  return new Set(rules.filter((rule) => rule.pattern.test(path)).map((rule) => rule.parameter));
}

function jobBlock(source, name) {
  const start = source.indexOf(`  ${name}:\n`, source.indexOf("jobs:\n"));
  assert.notEqual(start, -1, `${name} job is missing`);
  const remainder = source.slice(start + 1);
  const nextJob = remainder.match(/\n  [a-z][a-z0-9-]*:\n/);
  const end = nextJob ? start + 1 + nextJob.index : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

// Shared lock/config changes must schedule both lanes; application-only edits stay scoped.
test("path filtering schedules only relevant fast application lanes", async () => {
  assert.deepEqual(
    await routedParameters("frontend/app/src/app-router.tsx"),
    new Set(["run-frontend"]),
  );
  for (const path of [
    "packages/database/migrations/027_billing_provider_request.sql",
    "packages/contracts/openapi.yaml",
    "scripts/cloudflare-local/k6-run.sh",
    "scripts/infra/check.sh",
    "workers/api/src/app.ts",
  ]) {
    assert.deepEqual(await routedParameters(path), new Set(["run-cloudflare"]));
  }
  for (const path of [
    ".circleci/continue-config.yml",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "vite.config.ts",
    "patches/@shadcn%2Flint@0.1.0.patch",
    "lint/boundaries-plugin.mjs",
  ]) {
    assert.deepEqual(await routedParameters(path), new Set(["run-frontend", "run-cloudflare"]));
  }
});

test("routine documentation and secret-scan changes do not trigger application lanes", async () => {
  for (const path of [".gitleaks.toml", "scripts/ci/docs-links.mjs"]) {
    assert.deepEqual(await routedParameters(path), new Set());
  }
});

test("manual trigger parameters are declared in both configs and sent only once", async () => {
  const setup = await readFile(setupConfigPath, "utf8");
  const continuation = await readFile(continuationConfigPath, "utf8");
  // Comments carry an example API payload, so payload checks read only config.
  const setupConfigOnly = setup
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  for (const name of [
    "frontend-full",
    "cloudflare-integration",
    "cloudflare-extended",
    "staging-release",
  ]) {
    assert.match(setup, new RegExp(`  ${name}:\\n    type: boolean`));
    // CircleCI forwards trigger-time pipeline parameters to the continuation
    // pipeline, so it must declare them under the same names or compilation
    // fails with "Unexpected argument(s)".
    assert.match(continuation, new RegExp(`  ${name}:\\n    type: boolean`));
    // Re-sending a trigger-time parameter through the continuation payload
    // makes CircleCI report conflicting pipeline parameters.
    assert.doesNotMatch(setupConfigOnly, new RegExp(`\\"${name}\\"`));
  }
  assert.doesNotMatch(
    continuation,
    /run-frontend-full|run-cloudflare-integration|run-cloudflare-extended|run-staging-release/,
  );
  assert.doesNotMatch(setupConfigOnly, /run-staging-release/);
});

test("every setup pipeline parameter is declared in the continuation config", async () => {
  const declaredParameters = async (path) => {
    const lines = (await readFile(path, "utf8")).split("\n");
    const start = lines.indexOf("parameters:");
    assert.notEqual(start, -1, `${path} declares no pipeline parameters`);
    const names = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(/^ {2}([a-z][a-z0-9-]*):$/);
      if (match) names.push(match[1]);
    }
    return names;
  };

  const setup = await declaredParameters(setupConfigPath);
  const continuation = await declaredParameters(continuationConfigPath);
  assert.ok(setup.length > 0, "setup config declares no trigger parameters");
  for (const name of setup) {
    assert.ok(
      continuation.includes(name),
      `continuation config must declare "${name}"; CircleCI forwards trigger-time parameters to it`,
    );
  }
});

test("continuation uses explicit Cloud-hosted resource classes", async () => {
  const source = await readFile(continuationConfigPath, "utf8");
  assert.match(source, /image: cimg\/node:24\.18\.0/);
  assert.match(source, /resource_class: small/);
  assert.match(source, /resource_class: medium/);
  assert.match(source, /retention:\n  caches: 7d/);
  assert.match(source, /machine:\n      image: ubuntu-2404:current/);
  assert.doesNotMatch(source, /meltiply-runner|machine: true|ci-workspaces|setup-docker/);
  assert.doesNotMatch(source, /ci-metrics|circleci-summary|github-ci-summary/);
});

test("staging release is explicitly requested on master and waits for fast quality", async () => {
  const source = await readFile(continuationConfigPath, "utf8");
  const workflow = source.slice(source.lastIndexOf("  staging-release:\n"));
  assert.match(workflow, /equal: \[master, << pipeline\.git\.branch >>\]/);
  assert.match(workflow, /<< pipeline\.parameters\.staging-release >>/);
  assert.match(
    workflow,
    /cloudflare-fast:[\s\S]*staging-quality-gate:[\s\S]*requires:[\s\S]*- cloudflare-fast/,
  );
  assert.match(workflow, /staging-foundation-approval:[\s\S]*type: approval/);
  assert.match(workflow, /staging-traffic-approval:[\s\S]*type: approval/);
  assert.match(workflow, /staging-queue-resume-approval:[\s\S]*type: approval/);
});

test("the aggregate gate is the lightweight automatic status only", async () => {
  const source = await readFile(continuationConfigPath, "utf8");
  assert.match(
    source,
    /automatic-both:[\s\S]*ci-gate:[\s\S]*requires:[\s\S]*- baseline[\s\S]*- frontend-fast[\s\S]*- cloudflare-fast/,
  );
  assert.match(
    source,
    /automatic-frontend:[\s\S]*ci-gate:[\s\S]*requires:[\s\S]*- baseline[\s\S]*- frontend-fast/,
  );
  assert.match(
    source,
    /automatic-cloudflare:[\s\S]*ci-gate:[\s\S]*requires:[\s\S]*- baseline[\s\S]*- cloudflare-fast/,
  );
  assert.match(source, /automatic-baseline:[\s\S]*ci-gate:[\s\S]*requires:[\s\S]*- baseline/);
  assert.doesNotMatch(jobBlock(source, "ci-gate"), /aggregate-gate\.sh/);
});

test("quality roots install gitleaks and cancel active sibling workflows on failure", async () => {
  const source = await readFile(continuationConfigPath, "utf8");
  assert.match(jobBlock(source, "baseline"), /install-gitleaks/);
  for (const name of [
    "baseline",
    "ci-gate",
    "frontend-fast",
    "cloudflare-fast",
    "cloudflare-extended",
    "frontend-full",
    "cloudflare-integration",
    "staging-quality-gate",
  ]) {
    assert.match(jobBlock(source, name), /cancel-sibling-workflows/);
  }
  const failureHook = await readFile(cancelSiblingsPath, "utf8");
  assert.match(failureHook, /CIRCLE_PIPELINE_ID/);
  assert.match(failureHook, /CIRCLE_WORKFLOW_ID/);
  assert.match(failureHook, /workflow\/\$\{workflow_id\}\/cancel/);
});

// Vite+ writes content-addressed task results into node_modules/.vite; the job
// must archive that store, and the deleted turbo.json must stay out of routes.
test("CI uses granular task and pinned tool caches", async () => {
  const source = await readFile(continuationConfigPath, "utf8");
  const cloudflareFast = jobBlock(source, "cloudflare-fast");
  assert.match(cloudflareFast, /v2-vite-task-\{\{ arch \}\}/);
  assert.match(cloudflareFast, /node_modules\/\.vite\/task-cache/);
  assert.match(cloudflareFast, /vp run --cache --filter/);
  assert.doesNotMatch(cloudflareFast, /turbo|with_tool_cache/);
  assert.match(
    source,
    /install-opentofu:[\s\S]*restore_cache:[\s\S]*install-opentofu\.sh[\s\S]*\.bin\/tofu/,
  );
  for (const name of [
    "cloudflare-extended",
    "staging-initial-plan",
    "staging-initial-apply",
    "staging-consumers-plan",
    "staging-consumers-apply",
    "staging-domain-plan",
    "staging-domain-apply-rollout",
    "staging-unpause-plan",
    "staging-unpause-apply",
  ]) {
    const job = jobBlock(source, name);
    assert.match(job, /install-opentofu/);
    assert.doesNotMatch(job, /scripts\/infra\/install-opentofu\.sh/);
  }
});

test("detailed reporting bridge and its implementation are removed", async () => {
  for (const path of [
    ".github/workflows/ci-summary.yml",
    "scripts/ci/ci-metrics.mjs",
    "scripts/ci/ci-metrics.test.mjs",
    "scripts/ci/circleci-summary.mjs",
    "scripts/ci/circleci-summary.test.mjs",
    "scripts/ci/github-ci-summary.mjs",
    "scripts/ci/github-ci-summary.test.mjs",
  ]) {
    await assert.rejects(access(resolve(root, path), constants.F_OK));
  }
});
