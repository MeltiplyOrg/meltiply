import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const transitionScript = join(repositoryRoot, "scripts/infra/staging-transition.sh");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "meltiply-staging-transition-"));
  const releaseDir = join(root, "release");
  const backend = join(root, "backend.hcl");
  const tfvars = join(root, "foundation.tfvars");
  const planJson = join(root, "plan.json");
  const tofuLog = join(root, "tofu.log");
  const tofu = join(root, "tofu");
  await writeFile(backend, 'address = "https://state.invalid"\n');
  await writeFile(tfvars, 'environment = "staging"\n');
  await writeFile(
    planJson,
    `${JSON.stringify({
      terraform_version: "1.10.2",
      variables: {
        environment: { value: "staging" },
        attach_api_custom_domains: { value: false },
        attach_queue_consumers: { value: false },
        queue_delivery_paused: { value: true },
      },
      resource_changes: [],
    })}\n`,
  );
  await writeFile(
    tofu,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_TOFU_LOG"
case " $* " in
  *" plan "*)
    for argument in "$@"; do
      case "$argument" in -out=*) printf 'immutable-plan' >"\${argument#-out=}" ;; esac
    done
    ;;
  *" show "*) cat "$FAKE_PLAN_JSON" ;;
  *" output "*) printf '{"release_resources":{"value":{"environment":"staging"}}}\\n' ;;
esac
`,
  );
  await chmod(tofu, 0o755);
  const { stdout: checkoutSha } = await execFileAsync("git", [
    "-C",
    repositoryRoot,
    "rev-parse",
    "HEAD",
  ]);

  return {
    root,
    releaseDir,
    backend,
    tfvars,
    tofuLog,
    env: {
      ...process.env,
      CIRCLE_SHA1: checkoutSha.trim(),
      FAKE_PLAN_JSON: planJson,
      FAKE_TOFU_LOG: tofuLog,
      MELTIPLY_RELEASE_DIR: releaseDir,
      MELTIPLY_TF_BACKEND_CONFIG: backend,
      MELTIPLY_TOFU_BIN: tofu,
    },
  };
}

test("plans, verifies, applies, records outputs, and removes raw plan data", async () => {
  const setup = await fixture();
  await execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot,
    env: setup.env,
  });

  const summary = JSON.parse(
    await readFile(join(setup.releaseDir, "foundation-plan-summary.json")),
  );
  assert.deepEqual(summary.transition, {
    environment: "staging",
    attachApiCustomDomains: false,
    attachQueueConsumers: false,
    queueDeliveryPaused: true,
  });
  assert.equal(
    (await readFile(join(setup.releaseDir, "foundation-plan.sha256"), "utf8")).trim().length,
    64,
  );

  await execFileAsync(transitionScript, ["apply", "foundation"], {
    cwd: repositoryRoot,
    env: setup.env,
  });
  const outputs = JSON.parse(await readFile(join(setup.releaseDir, "iac-outputs.json"), "utf8"));
  assert.equal(outputs.release_resources.value.environment, "staging");
  await assert.rejects(readFile(join(setup.releaseDir, "foundation.tfplan")));
  await assert.rejects(readFile(join(setup.releaseDir, "foundation-plan.json")));
  assert.match(await readFile(setup.tofuLog, "utf8"), / apply /);
});

test("rejects plan tampering before OpenTofu apply", async () => {
  const setup = await fixture();
  await execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot,
    env: setup.env,
  });
  await writeFile(join(setup.releaseDir, "foundation.tfplan"), "tampered");

  await assert.rejects(
    execFileAsync(transitionScript, ["apply", "foundation"], {
      cwd: repositoryRoot,
      env: setup.env,
    }),
    /saved plan digest does not match approval evidence/,
  );
  assert.doesNotMatch(await readFile(setup.tofuLog, "utf8"), / apply /);
});

test("rejects a checkout that does not exactly match the pipeline SHA", async () => {
  const setup = await fixture();
  await assert.rejects(
    execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
      cwd: repositoryRoot,
      env: { ...setup.env, CIRCLE_SHA1: "0".repeat(40) },
    }),
    /checked-out commit does not match CIRCLE_SHA1/,
  );
});
