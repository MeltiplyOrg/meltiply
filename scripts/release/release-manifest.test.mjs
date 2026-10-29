import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { validateIacOutputs, validateReleaseSpec } from "./release-lib.mjs";
import { sha256 } from "./release-guard.mjs";
import { buildReleaseManifest } from "./release-manifest.mjs";

const gitSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const workflowId = "99999999-9999-4999-8999-999999999999";
const candidateVersionId = "11111111-1111-1111-1111-111111111111";
const secretsVersionId = "22222222-2222-2222-2222-222222222222";
const previousVersionId = "33333333-3333-3333-3333-333333333333";
const automationVersionId = "44444444-4444-4444-4444-444444444444";
const stateVersionId = "55555555-5555-5555-5555-555555555555";
const automationSecretsId = "66666666-6666-6666-6666-666666666666";
const repoRoot = path.resolve(import.meta.dirname, "../..");

const digests = {
  domain: "d".repeat(64),
  initial: "f".repeat(64),
  unpause: "e".repeat(64),
};

// Builds a valid reviewed release input for manifest fixture scenarios.
function releaseInput(overrides = {}) {
  return {
    schema_version: 1,
    environment: "staging",
    deployment_mode: "update",
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

// Builds the OpenTofu outputs document the release contracts require.
function iacOutput(overrides = {}) {
  const queues = {
    analytics: "meltiply-analytics-staging",
    "asset-processing": "meltiply-asset-processing-staging",
    "channel-revocation": "meltiply-channel-revocation-staging",
    comments: "meltiply-comments-staging",
    "publish-facebook": "meltiply-publish-facebook-staging",
    "publish-instagram": "meltiply-publish-instagram-staging",
    "publish-threads": "meltiply-publish-threads-staging",
    "publish-tiktok": "meltiply-publish-tiktok-staging",
    "publish-youtube": "meltiply-publish-youtube-staging",
    replies: "meltiply-replies-staging",
    "token-refresh": "meltiply-token-refresh-staging",
  };
  const resources = {
    app_custom_domains_attached: true,
    app_hostname: "staging.meltiply.com",
    assets_bucket_name: "meltiply-assets-staging",
    authenticated_hyperdrive_id: "1".repeat(32),
    environment: "staging",
    operator_access_aud: null,
    operator_hostname: null,
    queue_consumers_attached: true,
    queue_delivery_paused: false,
    queue_names: queues,
    system_hyperdrive_id: "2".repeat(32),
    ...overrides,
  };
  return {
    release_resources: {
      sensitive: false,
      type: ["object", {}],
      value: resources,
    },
    worker_bindings: {
      sensitive: false,
      type: ["object", {}],
      value: {
        ACCESS_POLICY_AUD: null,
        ACCESS_TEAM_DOMAIN: null,
        ASSETS: resources.assets_bucket_name,
        DB_AUTHENTICATED: resources.authenticated_hyperdrive_id,
        DB_SYSTEM: resources.system_hyperdrive_id,
        OPERATOR_HOSTNAME: null,
        queues,
      },
    },
  };
}

// Builds an operator review record bound to a plan digest.
function approval(name, planDigest, index = "88888888") {
  return {
    approval_job: {
      approved_by: `${index}-8888-4888-8888-888888888888`,
      id: `${index}-8888-4888-8888-888888888888`,
      name,
      status: "success",
    },
    pipeline_sha: gitSha,
    plan_digest: planDigest,
    schema_version: 1,
    workflow_id: workflowId,
  };
}

// Builds the release plan transition variable triple for a phase.
function transition(attachDomains, attachConsumers, paused) {
  return {
    attach_app_custom_domains: attachDomains,
    attach_queue_consumers: attachConsumers,
    environment: "staging",
    queue_delivery_paused: paused,
  };
}

// Builds a redacted plan summary matching scripts/infra/release-plan.mjs.
function planSummary(phase, transitionFields) {
  return {
    phase,
    resourceChanges: [
      {
        actions: ["update"],
        address: `cloudflare_queue.${phase}`,
        type: "cloudflare_queue",
      },
    ],
    schemaVersion: 1,
    terraformVersion: "1.9.0",
    transition: transitionFields,
  };
}

// Builds the health sub-record embedded in smoke evidence.
function healthEvidence(extra = {}) {
  return {
    contract_version: "1.3.0",
    environment: "staging",
    status: "ok",
    url: "https://staging.meltiply.com/api/v1/health",
    version: gitSha,
    ...extra,
  };
}

// Builds a complete, internally consistent update-mode release directory.
function updateEvidenceSet(spec) {
  const base = {
    git_sha: spec.git_sha,
    release_id: spec.release_id,
    schema_version: 1,
  };
  const foundation = approval("staging-foundation-approval", digests.initial, "88888881");
  const trafficApproval = approval("staging-traffic-approval", digests.domain, "88888882");
  const resumeApproval = approval("staging-queue-resume-approval", digests.unpause, "88888883");
  const baseWith = (planDigest, signoff) => ({
    ...base,
    approvals: [signoff],
    plan_digest: planDigest,
  });
  const hostname = "meltiply-api.example.workers.dev";
  const versionOrigin = `https://${secretsVersionId.slice(0, 8)}-${hostname}`;

  const rollout = (percentage) => {
    const traffic =
      percentage === 100
        ? [{ percentage: 100, version_id: secretsVersionId }]
        : [
            { percentage, version_id: secretsVersionId },
            { percentage: 100 - percentage, version_id: previousVersionId },
          ].sort((left, right) => left.version_id.localeCompare(right.version_id));
    return {
      ...baseWith(digests.domain, trafficApproval),
      percentage,
      traffic,
      version_id: secretsVersionId,
      worker: "api",
    };
  };
  const smokeLive = (percentage) => ({
    ...base,
    attempts: 1,
    health: healthEvidence(),
    percentage,
    phase: "live",
    status: "passed",
    traffic: rollout(percentage).traffic,
    version_id: secretsVersionId,
    worker: "api",
  });

  return {
    "approval-foundation.json": foundation,
    "approval-queue-resume.json": resumeApproval,
    "approval-traffic.json": trafficApproval,
    "automation-cron-active.json": {
      ...baseWith(digests.unpause, resumeApproval),
      phase: "cron-activate",
      schedule_set_digest: "1".repeat(64),
      status: "active",
      worker: "automation",
    },
    "automation-cron-paused.json": {
      ...baseWith(digests.initial, foundation),
      phase: "cron-pause",
      schedule_set_digest: "1".repeat(64),
      status: "empty",
      worker: "automation",
    },
    "domain-plan-summary.json": planSummary("domain", transition(true, true, true)),
    "domain-plan.sha256": `${digests.domain}\n`,
    "iac-outputs-domain.json": iacOutput({ queue_delivery_paused: true }),
    "iac-outputs-pause.json": iacOutput({ queue_delivery_paused: true }),
    "iac-outputs-unpause.json": iacOutput(),
    "migration-evidence.json": {
      ...baseWith(digests.initial, foundation),
      already_applied: [],
      applied: [{ checksum: "c".repeat(64), name: "0001_init" }],
      migration_set_digest: "2".repeat(64),
      phase: "expand",
      restore_point: {
        expires_at: spec.restore_point_expires_at,
        snapshot_digest: "3".repeat(64),
        snapshot_id: "snap-1",
      },
      status: "applied",
    },
    "pause-plan-summary.json": planSummary("pause", transition(true, true, true)),
    "pause-plan.sha256": `${digests.initial}\n`,
    "restore-point-evidence.json": {
      ...baseWith(digests.initial, foundation),
      created_at: "2026-08-01T12:00:00.000Z",
      endpoint_host_digest: "4".repeat(64),
      endpoint_id: "ep-1",
      expires_at: spec.restore_point_expires_at,
      project_id: spec.neon_project_id,
      provider: "neon",
      snapshot_digest: sha256(
        [
          "snap-1",
          `meltiply-${spec.release_id}`,
          spec.neon_branch_id,
          "2026-08-01T12:00:00.000Z",
          spec.restore_point_expires_at,
        ].join("\0"),
      ),
      snapshot_id: "snap-1",
      snapshot_name: `meltiply-${spec.release_id}`,
      source_branch_id: spec.neon_branch_id,
      status: "ready",
    },
    "api-rollout-5.json": rollout(5),
    "api-rollout-25.json": rollout(25),
    "api-rollout-50.json": rollout(50),
    "api-rollout-100.json": rollout(100),
    "smoke-live-5.json": smokeLive(5),
    "smoke-live-25.json": smokeLive(25),
    "smoke-live-50.json": smokeLive(50),
    "smoke-live-100.json": smokeLive(100),
    "smoke-version.json": {
      ...base,
      attempts: 1,
      candidate_version_id: candidateVersionId,
      health: {
        contract_version: "1.3.0",
        environment: "staging",
        status: "ok",
        url: `${versionOrigin}/api/v1/health`,
        version: gitSha,
      },
      phase: "version",
      status: "passed",
      version_id: secretsVersionId,
      worker: "api",
    },
    "unpause-plan-summary.json": planSummary("unpause", transition(true, true, false)),
    "unpause-plan.sha256": `${digests.unpause}\n`,
    "worker-api-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "update",
      previous_version_id: previousVersionId,
      preview_alias_url: `https://${spec.release_id}-${hostname}`,
      preview_url: `https://${candidateVersionId.slice(0, 8)}-${hostname}`,
      step: "upload",
      version_id: candidateVersionId,
      worker: "api",
    },
    "worker-api-secrets.json": {
      ...baseWith(digests.initial, foundation),
      based_on_version_id: candidateVersionId,
      secret_names: [
        "AUTH_SETUP_SECRET",
        "BETTER_AUTH_SECRET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "TOKEN_ENCRYPTION_KEY",
      ],
      version_id: secretsVersionId,
      worker: "api",
    },
    "worker-automation-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "update",
      previous_version_id: previousVersionId,
      preview_alias_url: null,
      preview_url: null,
      step: "upload",
      version_id: automationVersionId,
      worker: "automation",
    },
    "worker-automation-deployment.json": {
      ...baseWith(digests.initial, foundation),
      traffic: [{ percentage: 100, version_id: automationSecretsId }],
      version_id: automationSecretsId,
      worker: "automation",
    },
    "worker-automation-secrets.json": {
      ...baseWith(digests.initial, foundation),
      based_on_version_id: automationVersionId,
      secret_names: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "TOKEN_ENCRYPTION_KEY"],
      version_id: automationSecretsId,
      worker: "automation",
    },
    "worker-state-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "update",
      previous_version_id: previousVersionId,
      preview_alias_url: null,
      preview_url: null,
      step: "upload",
      version_id: stateVersionId,
      worker: "state",
    },
    "worker-state-deployment.json": {
      ...baseWith(digests.initial, foundation),
      traffic: [{ percentage: 100, version_id: stateVersionId }],
      version_id: stateVersionId,
      worker: "state",
    },
  };
}

// Writes an evidence map to a release directory with private scratch files.
async function seedReleaseDir(outDir, files, { includeFinal = true } = {}) {
  await mkdir(path.join(outDir, "wrangler"), { recursive: true });
  await writeFile(path.join(outDir, "wrangler", "api.json"), "{}", {
    mode: 0o600,
  });
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    await writeFile(path.join(outDir, name), body, { mode: 0o600 });
  }
  if (includeFinal) {
    await writeFile(
      path.join(outDir, "iac-outputs.json"),
      `${JSON.stringify(iacOutput(), null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(path.join(outDir, "release-input.json"), "{}", {
    mode: 0o600,
  });
}

// Builds buildReleaseManifest parameters for a seeded release directory.
function manifestParams(outDir, spec, overrides = {}) {
  const approvalDir = outDir;
  return {
    approvalPaths: ["foundation", "traffic", "queue-resume"].map((name) =>
      path.join(approvalDir, `approval-${name}.json`),
    ),
    environment: {},
    iac: validateIacOutputs(iacOutput(), spec),
    outDir,
    repoRoot,
    spec,
    ...overrides,
  };
}

// Creates a temporary release directory and registers its cleanup.
async function withReleaseDir(context, files, options) {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-manifest-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  await seedReleaseDir(outDir, files, options);
  return outDir;
}

test("manifest publishes deterministic redacted provenance for a complete update release", async (context) => {
  const spec = validateReleaseSpec(releaseInput());
  const files = updateEvidenceSet(spec);
  const outDir = await withReleaseDir(context, files);

  const manifest = await buildReleaseManifest(manifestParams(outDir, spec));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.deployment_mode, "update");
  assert.equal(manifest.git_sha, gitSha);
  assert.equal(manifest.environment, "staging");

  // Every publishable artifact is listed with byte size and digest.
  const names = manifest.evidence.map((entry) => entry.file);
  assert.ok(names.length >= 30, "all allowlisted evidence is published");
  for (const entry of manifest.evidence) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.bytes > 0);
  }
  assert.deepEqual(names, [...names].sort(), "evidence order is deterministic");

  // Private scratch never reaches the manifest.
  for (const name of names) {
    assert.doesNotMatch(name, /release-input|wrangler|^iac-outputs\.json$/);
  }

  // Provenance binds OpenAPI version and the three approval holds.
  assert.equal(manifest.openapi.version, "1.0.0-target.0");
  assert.equal(manifest.openapi.path, "packages/contracts/openapi.yaml");
  assert.match(manifest.openapi.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.signoffs.map((signoff) => signoff.job).sort(), [
    "staging-foundation-approval",
    "staging-queue-resume-approval",
    "staging-traffic-approval",
  ]);
  const trafficSignoff = manifest.signoffs.find(
    (signoff) => signoff.job === "staging-traffic-approval",
  );
  assert.equal(trafficSignoff.plan_digest, digests.domain);
  assert.equal(trafficSignoff.workflow_id, workflowId);

  // The persisted record is the returned record.
  const written = JSON.parse(await readFile(path.join(outDir, "release-manifest.json"), "utf8"));
  assert.deepEqual(written, manifest);

  // Re-running is byte-for-byte deterministic.
  const second = await buildReleaseManifest(manifestParams(outDir, spec));
  assert.deepEqual(second, manifest);
});

test("manifest rejects incomplete and unclassified release directories", async (context) => {
  const spec = validateReleaseSpec(releaseInput());
  const files = updateEvidenceSet(spec);

  // A missing evidence file fails closed with the name surfaced.
  const incomplete = { ...files };
  delete incomplete["smoke-version.json"];
  let outDir = await withReleaseDir(context, incomplete);
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /incomplete: .*smoke-version\.json/,
  );

  // Bootstrap-mode artifacts inside an update release are unclassified.
  outDir = await withReleaseDir(context, {
    ...files,
    "worker-api-deployment.json": {},
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /unclassified release artifact: worker-api-deployment\.json/,
  );

  // Unknown top-level artifacts fail closed.
  outDir = await withReleaseDir(context, { ...files, "notes.txt": "hi" });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /unclassified release artifact: notes\.txt/,
  );

  // Bootstrap evidence cannot satisfy an update manifest either.
  outDir = await withReleaseDir(context, {
    ...files,
    "smoke-live.json": files["smoke-live-100.json"],
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /unclassified release artifact: smoke-live\.json/,
  );
});

test("manifest rejects mismatched provenance, approvals, and secret-bearing evidence", async (context) => {
  const spec = validateReleaseSpec(releaseInput());
  const files = updateEvidenceSet(spec);

  // Evidence bound to a different commit is rejected.
  let outDir = await withReleaseDir(context, {
    ...files,
    "worker-api-candidate.json": {
      ...files["worker-api-candidate.json"],
      git_sha: previousSha,
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /worker-api-candidate\.json does not match the release/,
  );

  // An approval bound to the wrong plan digest fails its hold binding.
  const wrongApproval = approval("staging-foundation-approval", "0".repeat(64));
  outDir = await withReleaseDir(context, {
    ...files,
    "approval-foundation.json": wrongApproval,
    "worker-api-candidate.json": {
      ...files["worker-api-candidate.json"],
      approvals: [wrongApproval],
    },
  });
  await assert.rejects(buildReleaseManifest(manifestParams(outDir, spec)), /plan digest|approval/i);

  // Embedded approvals that diverge from the loaded hold are rejected.
  const diverged = {
    ...files["migration-evidence.json"],
    approvals: [approval("staging-foundation-approval", digests.unpause)],
  };
  outDir = await withReleaseDir(context, {
    ...files,
    "migration-evidence.json": diverged,
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /embeds unexpected approval records|plan digest/,
  );

  // A rollout split that contradicts its percentage is rejected.
  outDir = await withReleaseDir(context, {
    ...files,
    "api-rollout-25.json": {
      ...files["api-rollout-25.json"],
      percentage: 50,
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /does not prove the staged rollout/,
  );

  // Credential material in any evidence record rejects the whole release.
  const secretValue = "sk_live_manifest_secret_123456";
  outDir = await withReleaseDir(context, {
    ...files,
    "smoke-version.json": {
      ...files["smoke-version.json"],
      health: { ...files["smoke-version.json"].health, url: secretValue },
    },
  });
  await assert.rejects(
    buildReleaseManifest(
      manifestParams(outDir, spec, {
        environment: { NEON_API_KEY: secretValue },
      }),
    ),
    /embeds a protected secret value|credential material/,
  );

  // Secret material in private scratch (release-input.json) is not scanned
  // for publication but the manifest still covers publishable content.
  outDir = await withReleaseDir(context, {
    ...files,
    "migration-evidence.json": {
      ...files["migration-evidence.json"],
      applied: [{ checksum: "postgres://user:pass@host/db", name: "x" }],
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /credential material|embeds/,
  );
});

test("manifest verifies final outputs equal the unpause transition and are active", async (context) => {
  const spec = validateReleaseSpec(releaseInput());
  const files = updateEvidenceSet(spec);

  // Final outputs that do not match unpause byte-for-byte are rejected.
  let outDir = await withReleaseDir(context, files);
  await writeFile(
    path.join(outDir, "iac-outputs.json"),
    `${JSON.stringify(iacOutput({ queue_delivery_paused: true }), null, 2)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /do not match the unpause transition/,
  );

  // Outputs claiming the wrong phase state are rejected inside the document.
  outDir = await withReleaseDir(context, {
    ...files,
    "iac-outputs-unpause.json": iacOutput({ queue_delivery_paused: true }),
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /do not prove the unpause transition/,
  );
});

// Builds a complete, internally consistent bootstrap-mode release directory.
function bootstrapEvidenceSet(spec) {
  const base = {
    git_sha: spec.git_sha,
    release_id: spec.release_id,
    schema_version: 1,
  };
  const foundation = approval("staging-foundation-approval", digests.initial, "88888881");
  const trafficApproval = approval("staging-traffic-approval", digests.domain, "88888882");
  const resumeApproval = approval("staging-queue-resume-approval", digests.unpause, "88888883");
  const baseWith = (planDigest, signoff) => ({
    ...base,
    approvals: [signoff],
    plan_digest: planDigest,
  });
  const consumersDigest = "7".repeat(64);
  const hostname = "meltiply-api.example.workers.dev";
  const traffic100 = (versionId) => [{ percentage: 100, version_id: versionId }];

  return {
    "approval-foundation.json": foundation,
    "approval-queue-resume.json": resumeApproval,
    "approval-traffic.json": trafficApproval,
    "automation-cron-active.json": {
      ...baseWith(digests.unpause, resumeApproval),
      phase: "cron-activate",
      schedule_set_digest: "1".repeat(64),
      status: "active",
      worker: "automation",
    },
    "automation-cron-paused.json": {
      ...baseWith(digests.initial, foundation),
      phase: "cron-pause",
      schedule_set_digest: "1".repeat(64),
      status: "empty",
      worker: "automation",
    },
    "domain-plan-summary.json": planSummary("domain", transition(true, true, true)),
    "domain-plan.sha256": `${digests.domain}\n`,
    "foundation-plan-summary.json": planSummary("foundation", transition(false, false, true)),
    "foundation-plan.sha256": `${digests.initial}\n`,
    "iac-outputs-domain.json": iacOutput({ queue_delivery_paused: true }),
    "iac-outputs-foundation.json": iacOutput({
      app_custom_domains_attached: false,
      queue_consumers_attached: false,
      queue_delivery_paused: true,
    }),
    "iac-outputs-paused-consumers.json": iacOutput({
      app_custom_domains_attached: false,
      queue_consumers_attached: true,
      queue_delivery_paused: true,
    }),
    "iac-outputs-unpause.json": iacOutput(),
    "migration-evidence.json": {
      ...baseWith(digests.initial, foundation),
      already_applied: [],
      applied: [{ checksum: "c".repeat(64), name: "0001_init" }],
      migration_set_digest: "2".repeat(64),
      phase: "bootstrap",
      restore_point: {
        expires_at: spec.restore_point_expires_at,
        snapshot_digest: "3".repeat(64),
        snapshot_id: "snap-1",
      },
      status: "applied",
    },
    "paused-consumers-plan-summary.json": planSummary(
      "paused-consumers",
      transition(false, true, true),
    ),
    "paused-consumers-plan.sha256": `${consumersDigest}\n`,
    "restore-point-evidence.json": {
      ...baseWith(digests.initial, foundation),
      created_at: "2026-08-01T12:00:00.000Z",
      endpoint_host_digest: "4".repeat(64),
      endpoint_id: "ep-1",
      expires_at: spec.restore_point_expires_at,
      project_id: spec.neon_project_id,
      provider: "neon",
      snapshot_digest: sha256(
        [
          "snap-1",
          `meltiply-${spec.release_id}`,
          spec.neon_branch_id,
          "2026-08-01T12:00:00.000Z",
          spec.restore_point_expires_at,
        ].join("\0"),
      ),
      snapshot_id: "snap-1",
      snapshot_name: `meltiply-${spec.release_id}`,
      source_branch_id: spec.neon_branch_id,
      status: "ready",
    },
    "smoke-live.json": {
      ...base,
      attempts: 1,
      health: healthEvidence(),
      percentage: 100,
      phase: "live",
      status: "passed",
      traffic: traffic100(secretsVersionId),
      version_id: secretsVersionId,
      worker: "api",
    },
    "smoke-version.json": {
      ...base,
      attempts: 1,
      candidate_version_id: candidateVersionId,
      health: {
        contract_version: "1.3.0",
        environment: "staging",
        status: "ok",
        url: `https://${secretsVersionId.slice(0, 8)}-${hostname}/api/v1/health`,
        version: gitSha,
      },
      phase: "version",
      status: "passed",
      version_id: secretsVersionId,
      worker: "api",
    },
    "unpause-plan-summary.json": planSummary("unpause", transition(true, true, false)),
    "unpause-plan.sha256": `${digests.unpause}\n`,
    "worker-api-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "bootstrap",
      previous_version_id: null,
      preview_alias_url: null,
      preview_url: null,
      step: "initialize",
      version_id: candidateVersionId,
      worker: "api",
    },
    "worker-api-deployment.json": {
      ...baseWith(digests.initial, foundation),
      traffic: traffic100(secretsVersionId),
      version_id: secretsVersionId,
      worker: "api",
    },
    "worker-api-secrets.json": {
      ...baseWith(digests.initial, foundation),
      based_on_version_id: candidateVersionId,
      secret_names: [
        "AUTH_SETUP_SECRET",
        "BETTER_AUTH_SECRET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "TOKEN_ENCRYPTION_KEY",
      ],
      version_id: secretsVersionId,
      worker: "api",
    },
    "worker-automation-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "bootstrap",
      previous_version_id: null,
      preview_alias_url: null,
      preview_url: null,
      step: "initialize",
      version_id: automationVersionId,
      worker: "automation",
    },
    "worker-automation-deployment.json": {
      ...baseWith(digests.initial, foundation),
      traffic: traffic100(automationSecretsId),
      version_id: automationSecretsId,
      worker: "automation",
    },
    "worker-automation-secrets.json": {
      ...baseWith(digests.initial, foundation),
      based_on_version_id: automationVersionId,
      secret_names: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "TOKEN_ENCRYPTION_KEY"],
      version_id: automationSecretsId,
      worker: "automation",
    },
    "worker-state-candidate.json": {
      ...baseWith(digests.initial, foundation),
      config_digest: "5".repeat(64),
      deployment_mode: "bootstrap",
      previous_version_id: null,
      preview_alias_url: null,
      preview_url: null,
      step: "initialize",
      version_id: stateVersionId,
      worker: "state",
    },
    "worker-state-deployment.json": {
      ...baseWith(digests.initial, foundation),
      traffic: traffic100(stateVersionId),
      version_id: stateVersionId,
      worker: "state",
    },
  };
}

test("manifest publishes bound provenance for a complete bootstrap release", async (context) => {
  const spec = validateReleaseSpec(releaseInput({ deployment_mode: "bootstrap" }));
  const outDir = await withReleaseDir(context, bootstrapEvidenceSet(spec));

  const manifest = await buildReleaseManifest(manifestParams(outDir, spec));
  assert.equal(manifest.deployment_mode, "bootstrap");
  const names = manifest.evidence.map((entry) => entry.file);
  assert.ok(names.includes("worker-api-deployment.json"));
  assert.ok(names.includes("smoke-live.json"));
  assert.ok(names.includes("paused-consumers-plan.sha256"));
  assert.ok(!names.some((name) => name.startsWith("api-rollout-")));
  assert.equal(manifest.git_sha, gitSha);
});

test("manifest rejects bootstrap identity drift and update-only artifacts", async (context) => {
  const spec = validateReleaseSpec(releaseInput({ deployment_mode: "bootstrap" }));
  const files = bootstrapEvidenceSet(spec);

  // Update-mode rollout evidence is unclassified inside a bootstrap release.
  let outDir = await withReleaseDir(context, {
    ...files,
    "api-rollout-5.json": {},
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /unclassified release artifact: api-rollout-5\.json/,
  );

  // A bootstrap candidate recording a previous version contradicts the mode.
  outDir = await withReleaseDir(context, {
    ...files,
    "worker-api-candidate.json": {
      ...files["worker-api-candidate.json"],
      previous_version_id: previousVersionId,
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /must not record a previous version/,
  );

  // The state Worker must activate its own code candidate, not a foreign ID.
  outDir = await withReleaseDir(context, {
    ...files,
    "worker-state-deployment.json": {
      ...files["worker-state-deployment.json"],
      traffic: [{ percentage: 100, version_id: secretsVersionId }],
      version_id: secretsVersionId,
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /activated the wrong Worker version/,
  );

  // The secrets version must derive from the recorded code candidate.
  outDir = await withReleaseDir(context, {
    ...files,
    "worker-api-secrets.json": {
      ...files["worker-api-secrets.json"],
      based_on_version_id: previousVersionId,
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /not based on the candidate|not the reviewed secrets version/,
  );

  // Recovery preview URLs legitimately null out; a foreign URL is rejected.
  outDir = await withReleaseDir(context, {
    ...files,
    "worker-api-candidate.json": {
      ...files["worker-api-candidate.json"],
      preview_url: "https://attacker.example.workers.dev",
    },
  });
  await assert.rejects(
    buildReleaseManifest(manifestParams(outDir, spec)),
    /unexpected version URL/,
  );
});
