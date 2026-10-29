import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertIacState,
  assertMutatingIntent,
  loadApprovalMetadata,
  validateApprovalMetadata,
  writeEvidence,
} from "./release-guard.mjs";

const gitSha = "a".repeat(40);
const planDigest = "b".repeat(64);
const spec = { deployment_mode: "bootstrap", environment: "staging", git_sha: gitSha };

function approval(overrides = {}) {
  return {
    schema_version: 1,
    workflow_id: "11111111-1111-4111-8111-111111111111",
    pipeline_sha: gitSha,
    plan_digest: planDigest,
    approval_job: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "staging-release-approval",
      status: "success",
      approved_by: "33333333-3333-4333-8333-333333333333",
    },
    ...overrides,
  };
}

test("mutation guard requires explicit apply, exact SHA, and plan digest", () => {
  assert.doesNotThrow(() =>
    assertMutatingIntent({
      apply: true,
      confirm: `release staging ${gitSha}`,
      currentSha: gitSha,
      planDigest,
      spec,
    }),
  );
  for (const value of [
    { apply: false, confirm: `release staging ${gitSha}`, planDigest },
    { apply: true, confirm: "release staging wrong", planDigest },
    {
      apply: true,
      confirm: `release staging ${gitSha}`,
      planDigest: "not-a-digest",
    },
  ]) {
    assert.throws(() => assertMutatingIntent({ ...value, spec }));
  }
});

/** A valid approval or confirmation from staging cannot authorize production. */
test("production mutation intent and approvals cannot be borrowed from staging", () => {
  const production = { ...spec, environment: "production" };
  assert.throws(
    () =>
      assertMutatingIntent({
        apply: true,
        confirm: `release staging ${gitSha}`,
        currentSha: gitSha,
        planDigest,
        spec: production,
      }),
    /release production/,
  );
  assert.doesNotThrow(() =>
    assertMutatingIntent({
      apply: true,
      confirm: `release production ${gitSha}`,
      currentSha: gitSha,
      planDigest,
      spec: production,
    }),
  );
  assert.throws(() => validateApprovalMetadata(approval(), production), /environment/);
  assert.equal(
    validateApprovalMetadata(
      approval({
        approval_job: { ...approval().approval_job, name: "production-foundation-approval" },
      }),
      production,
    ).approval_job.name,
    "production-foundation-approval",
  );
});

test("approval metadata is exact, successful, and release-bound", () => {
  assert.deepEqual(validateApprovalMetadata(approval(), spec), approval());
  assert.throws(
    () => validateApprovalMetadata(approval({ pipeline_sha: "c".repeat(40) }), spec),
    /does not match the release/,
  );
  assert.throws(
    () =>
      validateApprovalMetadata(
        approval({
          approval_job: { ...approval().approval_job, status: "on_hold" },
        }),
        spec,
      ),
    /status must be success/,
  );
  assert.throws(
    () => validateApprovalMetadata({ ...approval(), operator_label: "Alice" }, spec),
    /unknown fields: operator_label/,
  );
});

test("approval loading enforces expected job and reviewed plan", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-approval-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, "approval.json");
  await writeFile(file, JSON.stringify(approval()));
  const loaded = await loadApprovalMetadata({
    expectedNames: new Set(["staging-release-approval"]),
    paths: [file],
    planDigest,
    spec,
  });
  assert.equal(loaded[0].approval_job.approved_by, approval().approval_job.approved_by);
  await assert.rejects(
    loadApprovalMetadata({
      expectedNames: new Set(["staging-traffic-approval"]),
      paths: [file],
      planDigest,
      spec,
    }),
    /is not valid for this operation/,
  );
  await assert.rejects(
    loadApprovalMetadata({
      expectedNames: new Set(["staging-release-approval"]),
      paths: [file],
      planDigest: "c".repeat(64),
      spec,
    }),
    /does not match --plan-digest/,
  );

  const trafficFile = path.join(directory, "traffic.json");
  const trafficDigest = "c".repeat(64);
  await writeFile(
    trafficFile,
    JSON.stringify(
      approval({
        approval_job: {
          ...approval().approval_job,
          id: "44444444-4444-4444-8444-444444444444",
          name: "staging-traffic-approval",
        },
        plan_digest: trafficDigest,
      }),
    ),
  );
  await assert.rejects(
    loadApprovalMetadata({
      expectedNames: new Set(["staging-release-approval", "staging-traffic-approval"]),
      paths: [file],
      planDigests: new Map([
        ["staging-release-approval", planDigest],
        ["staging-traffic-approval", trafficDigest],
      ]),
      spec,
    }),
    /missing required jobs/,
  );
  assert.equal(
    (
      await loadApprovalMetadata({
        expectedNames: new Set(["staging-release-approval", "staging-traffic-approval"]),
        paths: [file, trafficFile],
        planDigests: new Map([
          ["staging-release-approval", planDigest],
          ["staging-traffic-approval", trafficDigest],
        ]),
        spec,
      })
    ).length,
    2,
  );
  const otherWorkflowFile = path.join(directory, "other-workflow.json");
  await writeFile(
    otherWorkflowFile,
    JSON.stringify(
      approval({
        approval_job: {
          ...approval().approval_job,
          id: "44444444-4444-4444-8444-444444444444",
          name: "staging-traffic-approval",
        },
        plan_digest: trafficDigest,
        workflow_id: "55555555-5555-4555-8555-555555555555",
      }),
    ),
  );
  await assert.rejects(
    loadApprovalMetadata({
      expectedNames: new Set(["staging-release-approval", "staging-traffic-approval"]),
      paths: [file, otherWorkflowFile],
      planDigests: new Map([
        ["staging-release-approval", planDigest],
        ["staging-traffic-approval", trafficDigest],
      ]),
      spec,
    }),
    /one release session/,
  );
});

test("IaC state transitions are exact and foundation is bootstrap-only", () => {
  const iac = {
    release_resources: {
      app_custom_domains_attached: false,
      queue_consumers_attached: false,
      queue_delivery_paused: true,
    },
  };
  assert.equal(assertIacState(iac, "foundation", spec), "foundation");
  assert.throws(
    () => assertIacState(iac, "foundation", { ...spec, deployment_mode: "update" }),
    /valid only for bootstrap/,
  );
  assert.throws(() => assertIacState(iac, "active", spec), /do not prove the active release state/);
});

test("evidence writes atomically with private permissions", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-evidence-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const output = await writeEvidence(directory, "worker-api.json", {
    b: 2,
    a: 1,
  });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(await readFile(output, "utf8"), '{\n  "a": 1,\n  "b": 2\n}\n');
  await assert.rejects(writeEvidence(directory, "../escape.json", {}), /filename is invalid/);
});
