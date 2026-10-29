import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const transitionScript = join(repositoryRoot, "scripts/infra/release-transition.sh");

/** Supplies an explicitly selected protected installation and a fake provider executable. */
async function fixture(environment = "staging") {
  const root = await mkdtemp(join(tmpdir(), "meltiply-release-transition-"));
  const releaseDir = join(root, "release");
  const backend = join(root, "backend.hcl");
  const tfvars = join(root, "foundation.tfvars");
  const planJson = join(root, "plan.json");
  const tofuLog = join(root, "tofu.log");
  const tofu = join(root, "tofu");
  await writeFile(backend, 'address = "https://state.invalid"\n');
  await writeFile(tfvars, `environment = "${environment}"\n`);
  await writeFile(
    planJson,
    `${JSON.stringify({
      terraform_version: "1.10.2",
      variables: {
        environment: { value: environment },
        attach_app_custom_domains: { value: false },
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
  *" output "*) printf '{"release_resources":{"value":{"environment":"${environment}"}}}\\n' ;;
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
  const input = join(root, "release-input.json");
  const example = JSON.parse(await readFile(join(repositoryRoot, "scripts/release/release-input.example.json"), "utf8"));
  await writeFile(input, JSON.stringify({
    ...example, environment, git_sha: checkoutSha.trim(),
    release_id: `${environment}-${checkoutSha.trim().slice(0, 12)}`,
    restore_point_expires_at: "2026-08-05T12:00:00.000Z",
  }));

  return {
    root,
    releaseDir,
    backend,
    tfvars,
    tofuLog,
    env: {
      ...process.env,
      MELTIPLY_RELEASE_SHA: checkoutSha.trim(),
      MELTIPLY_RELEASE_INPUT: input,
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
    attachAppCustomDomains: false,
    attachQueueConsumers: false,
    queueDeliveryPaused: true,
  });
  assert.equal(
    (await readFile(join(setup.releaseDir, "foundation-plan.sha256"), "utf8")).trim().length,
    64,
  );

  await execFileAsync(transitionScript, ["apply", "foundation"], {
    cwd: repositoryRoot,
    env: {
      ...setup.env,
      MELTIPLY_RELEASE_CONFIRM: `apply staging foundation ${setup.env.MELTIPLY_RELEASE_SHA} ${(await readFile(join(setup.releaseDir, "foundation-plan.sha256"), "utf8")).trim()}`,
    },
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

test("rejects a checkout that does not exactly match the release commit", async () => {
  const setup = await fixture();
  await assert.rejects(
    execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
      cwd: repositoryRoot,
      env: { ...setup.env, MELTIPLY_RELEASE_SHA: "0".repeat(40) },
    }),
    /checked-out commit does not match/,
  );
});

test("requires explicit reviewed-plan confirmation before applying infrastructure", async () => {
  const setup = await fixture();
  await execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot,
    env: setup.env,
  });
  await assert.rejects(
    execFileAsync(transitionScript, ["apply", "foundation"], {
      cwd: repositoryRoot,
      env: { ...setup.env, MELTIPLY_RELEASE_CONFIRM: "" },
    }),
    /MELTIPLY_RELEASE_CONFIRM/,
  );
  assert.doesNotMatch(await readFile(setup.tofuLog, "utf8"), / apply /);
});

/** Production confirmation must name production; changing protected inputs cannot retarget a saved plan. */
test("production plans require environment confirmation and the reviewed protected backend", async () => {
  const setup = await fixture("production");
  await execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], { cwd: repositoryRoot, env: setup.env });
  const digest = (await readFile(join(setup.releaseDir, "foundation-plan.sha256"), "utf8")).trim();
  await assert.rejects(execFileAsync(transitionScript, ["apply", "foundation"], {
    cwd: repositoryRoot, env: { ...setup.env, MELTIPLY_RELEASE_CONFIRM: `apply staging foundation ${setup.env.MELTIPLY_RELEASE_SHA} ${digest}` },
  }), /MELTIPLY_RELEASE_CONFIRM/);
  await execFileAsync(transitionScript, ["apply", "foundation"], {
    cwd: repositoryRoot, env: { ...setup.env, MELTIPLY_RELEASE_CONFIRM: `apply production foundation ${setup.env.MELTIPLY_RELEASE_SHA} ${digest}` },
  });
  assert.equal(JSON.parse(await readFile(join(setup.releaseDir, "iac-outputs.json"), "utf8")).release_resources.value.environment, "production");
  await writeFile(setup.backend, 'address = "https://other-state.invalid"\n');
  await assert.rejects(execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot, env: setup.env,
  }), /does not match the reviewed release context/);
});

/** The wrapper must reject missing explicit inputs and a provider plan targeting another installation. */
test("protected release selection is mandatory and mismatched plans fail before apply", async () => {
  const setup = await fixture("production");
  await assert.rejects(execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot, env: { ...setup.env, MELTIPLY_RELEASE_INPUT: "" },
  }), /MELTIPLY_RELEASE_INPUT/);
  await assert.rejects(readFile(setup.tofuLog));
  const plan = JSON.parse(await readFile(setup.env.FAKE_PLAN_JSON, "utf8"));
  plan.variables.environment.value = "staging";
  await writeFile(setup.env.FAKE_PLAN_JSON, JSON.stringify(plan));
  await assert.rejects(execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], {
    cwd: repositoryRoot, env: setup.env,
  }), /environment does not match the release input/);
  assert.doesNotMatch(await readFile(setup.tofuLog, "utf8"), / apply /);
});

/** Approval creation names the installation and refuses a confirmation borrowed from staging. */
test("production operator review requires environment-specific intent and emits scoped evidence", async () => {
  const setup = await fixture("production");
  await execFileAsync(transitionScript, ["plan", "foundation", setup.tfvars], { cwd: repositoryRoot, env: setup.env });
  const digest = (await readFile(join(setup.releaseDir, "foundation-plan.sha256"), "utf8")).trim();
  const args = [
    join(repositoryRoot, "scripts/release/approve.mjs"), "foundation", setup.env.MELTIPLY_RELEASE_INPUT,
    join(setup.releaseDir, "foundation.tfplan"), "operator",
  ];
  await assert.rejects(execFileAsync(process.execPath, [...args, `approve staging ${setup.env.MELTIPLY_RELEASE_SHA} ${digest}`], {
    cwd: repositoryRoot, env: setup.env,
  }), /Confirmation must identify the environment/);
  await execFileAsync(process.execPath, [...args, `approve production ${setup.env.MELTIPLY_RELEASE_SHA} ${digest}`], {
    cwd: repositoryRoot, env: setup.env,
  });
  const approval = JSON.parse(await readFile(join(setup.releaseDir, "approval-foundation.json"), "utf8"));
  assert.equal(approval.approval_job.name, "production-foundation-approval");
  assert.equal(approval.plan_digest, digest);
});
