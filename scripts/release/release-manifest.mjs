import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertReleaseBound,
  iacPhaseStates,
  loadApprovalMetadata,
  sha256,
  validateApprovalMetadata,
  writeEvidence,
} from "./release-guard.mjs";
import {
  containsCredentialMaterial,
  requiredRemoteSecrets,
  validateIacOutputs,
} from "./release-lib.mjs";
import { validateWorkerVersionId } from "./release-worker.mjs";
import { assertFrontendReleaseEvidence } from "./release-frontend.mjs";
import { matchedString, plainObject } from "./validation.mjs";
import { stableJson, stableValue } from "../lib/stable-json.mjs";

const httpsUrlPattern = /^https:\/\/[^\s]+$/;
const rolloutEvidencePattern = /^api-rollout-(?:5|25|50|100)\.json$/;
const smokeEvidencePattern = /^smoke-live(?:-(?:5|25|50|100))?\.json$/;
const openapiInfoPattern = /^info:\s*\n((?:[ \t]+[^\n]*\n)+)/m;
const openapiVersionPattern = /^[ \t]+version:[ \t]*(.+?)[ \t]*$/m;
const edgeQuotesPattern = /^["']|["']$/g;
const contractVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const evidenceLogPattern = /^(?:wrangler-)?[a-z0-9-]+\.jsonl?$/;
const wranglerLogPattern = /^wrangler-[a-z0-9-]+\.jsonl$/;
const deploymentPhasePattern = /^(foundation|traffic|queue-resume)$/;

const manifestName = "release-manifest.json";
const maximumFileBytes = 512 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;

const secretEnvironmentNames = [
  "CLOUDFLARE_API_TOKEN",
  "MELTIPLY_AUTHENTICATED_DATABASE_URL",
  "MELTIPLY_RELEASE_SECRETS_JSON",
  "MELTIPLY_SYSTEM_DATABASE_URL",
  "NEON_API_KEY",
  "TF_HTTP_PASSWORD",
];

const privateAllowlist = new Set([
  "consumers-transition",
  "deployment-mode",
  "iac-outputs.json",
  "initial-phase",
  "release-input.json",
  "release-manifest.json",
  "reviewed-sha",
  "reviewed-context.json",
  "approval-session.json",
]);

const transitionStates = Object.freeze({
  domain: "domains-paused",
  foundation: "foundation",
  pause: "domains-paused",
  "paused-consumers": "consumers-paused",
  unpause: "active",
});

const evidenceByMode = Object.freeze({
  common: Object.freeze([
    "approval-foundation.json",
    "approval-queue-resume.json",
    "approval-traffic.json",
    "automation-cron-active.json",
    "automation-cron-paused.json",
    "domain-plan-summary.json",
    "domain-plan.sha256",
    "iac-outputs-domain.json",
    "iac-outputs-unpause.json",
    "migration-evidence.json",
    "restore-point-evidence.json",
    "smoke-version.json",
    "unpause-plan-summary.json",
    "unpause-plan.sha256",
    "worker-api-candidate.json",
    "worker-api-secrets.json",
    "worker-automation-candidate.json",
    "worker-automation-deployment.json",
    "worker-automation-secrets.json",
    "worker-state-candidate.json",
    "worker-state-deployment.json",
    "worker-frontend-candidate.json",
    "worker-frontend-deployment.json",
  ]),
  bootstrap: Object.freeze([
    "foundation-plan-summary.json",
    "foundation-plan.sha256",
    "iac-outputs-foundation.json",
    "iac-outputs-paused-consumers.json",
    "paused-consumers-plan-summary.json",
    "paused-consumers-plan.sha256",
    "smoke-live.json",
    "worker-api-deployment.json",
  ]),
  update: Object.freeze([
    "api-rollout-100.json",
    "api-rollout-25.json",
    "api-rollout-5.json",
    "api-rollout-50.json",
    "iac-outputs-pause.json",
    "pause-plan-summary.json",
    "pause-plan.sha256",
    "smoke-live-100.json",
    "smoke-live-25.json",
    "smoke-live-5.json",
    "smoke-live-50.json",
  ]),
});

const approvalScopes = Object.freeze(["foundation", "traffic", "queue-resume"]);

function assertApprovalEmbedded(evidence, approval, name, spec) {
  if (!Array.isArray(evidence.approvals) || evidence.approvals.length !== 1) {
    throw new TypeError(`${name} embeds unexpected approval records`);
  }
  const normalized = validateApprovalMetadata(evidence.approvals[0], spec);
  if (JSON.stringify(normalized) !== JSON.stringify(approval)) {
    throw new TypeError(`${name} embeds unexpected approval records`);
  }
}

function assertPlanDigest(evidence, digest, name) {
  if (evidence.plan_digest !== digest) {
    throw new TypeError(`${name} binds an unexpected plan digest`);
  }
}

function validTraffic(traffic, name) {
  if (!Array.isArray(traffic) || traffic.length === 0 || traffic.length > 4) {
    throw new TypeError(`${name} traffic is invalid`);
  }
  const entries = traffic.map((entry, index) => {
    plainObject(entry, `${name} traffic[${index}]`);
    const percentage = entry.percentage;
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new TypeError(`${name} traffic[${index}].percentage is invalid`);
    }
    return {
      percentage,
      version_id: validateWorkerVersionId(entry.version_id, `${name} traffic[${index}].version_id`),
    };
  });
  const total = entries.reduce((sum, entry) => sum + entry.percentage, 0);
  if (Math.abs(total - 100) > 0.0001) {
    throw new TypeError(`${name} traffic must total 100 percent`);
  }
  if (new Set(entries.map((entry) => entry.version_id)).size !== entries.length) {
    throw new TypeError(`${name} traffic lists a version twice`);
  }
  return entries;
}

async function readPlanDigest(outDir, phase) {
  let content;
  try {
    content = await readFile(path.join(outDir, `${phase}-plan.sha256`), "utf8");
  } catch {
    throw new TypeError(`${phase}-plan.sha256 is required`);
  }
  const digest = content.trim();
  if (!sha256Pattern.test(digest) || content.trimEnd() !== digest) {
    throw new TypeError(`${phase}-plan.sha256 is invalid`);
  }
  return digest;
}

function validatePlanSummary(summary, phase, spec) {
  plainObject(summary, `${phase} plan summary`);
  if (summary.schemaVersion !== 1 || summary.phase !== phase) {
    throw new TypeError(`${phase} plan summary does not match the phase`);
  }
  if (summary.terraformVersion !== null && typeof summary.terraformVersion !== "string") {
    throw new TypeError(`${phase} plan summary terraformVersion is invalid`);
  }
  const transition = plainObject(summary.transition, `${phase} plan summary transition`);
  const expected = iacPhaseStates[transitionStates[phase]];
  const actual = [
    transition.attachAppCustomDomains,
    transition.attachQueueConsumers,
    transition.queueDeliveryPaused,
  ];
  if (
    transition.environment !== spec.environment ||
    actual.some((value) => typeof value !== "boolean") ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(`${phase} plan summary does not prove the expected transition`);
  }
  if (!Array.isArray(summary.resourceChanges) || summary.resourceChanges.length > 512) {
    throw new TypeError(`${phase} plan summary resourceChanges is invalid`);
  }
  for (const [index, change] of summary.resourceChanges.entries()) {
    plainObject(change, `${phase} plan summary resourceChanges[${index}]`);
    if (
      typeof change.address !== "string" ||
      change.address.length === 0 ||
      typeof change.type !== "string" ||
      !Array.isArray(change.actions) ||
      change.actions.length === 0 ||
      change.actions.some((action) => typeof action !== "string")
    ) {
      throw new TypeError(`${phase} plan summary resourceChanges[${index}] is invalid`);
    }
  }
}

function validatePhaseOutputs(outputs, phase, spec) {
  const iac = validateIacOutputs(outputs, spec);
  const resources = plainObject(iac.release_resources, `${phase} IaC outputs`);
  const actual = [
    resources.app_custom_domains_attached,
    resources.queue_consumers_attached,
    resources.queue_delivery_paused,
  ];
  const expected = iacPhaseStates[transitionStates[phase]];
  if (actual.some((value, index) => value !== expected[index])) {
    throw new TypeError(`IaC outputs do not prove the ${phase} transition`);
  }
}

function validateSmokeHealth(evidence, url, name, versionPinned, spec, previousVersionId) {
  const health = plainObject(evidence.health, `${name} health`);
  matchedString(health.url, httpsUrlPattern, `${name} health.url`);
  if (health.url !== url) {
    throw new TypeError(`${name} health probes the wrong URL`);
  }
  const previous = evidence.previous_version;
  const legacy =
    !versionPinned &&
    spec.deployment_mode === "update" &&
    health.contract_version === null &&
    previousVersionId !== undefined &&
    previous?.version_id === previousVersionId &&
    typeof previous.git_sha === "string" &&
    gitShaPattern.test(previous.git_sha) &&
    previous.git_sha !== spec.git_sha &&
    health.version === previous.git_sha;
  if (
    (!legacy &&
      (typeof health.contract_version !== "string" || health.contract_version.length === 0)) ||
    health.environment !== spec.environment ||
    health.status !== "ok" ||
    !gitShaPattern.test(health.version)
  ) {
    throw new TypeError(`${name} health is not the ${spec.environment} contract`);
  }
  if (versionPinned && health.version !== spec.git_sha) {
    throw new TypeError(`${name} health version does not match the release`);
  }
}

function evidenceContext({
  approvals,
  candidate,
  domainDigest,
  expectedTraffic,
  initialDigest,
  secretsVersionId,
  unpauseDigest,
}) {
  const approvalByName = new Map(
    approvals.map((approval) => [approval.approval_job.name, approval]),
  );
  return {
    approvals,
    approvalByName,
    candidate,
    domainDigest,
    expectedTraffic,
    initialDigest,
    secretsVersionId,
    unpauseDigest,
  };
}

function validateEvidenceDocument({ content, context, name, spec }) {
  const foundation = context.approvalByName.get(`${spec.environment}-foundation-approval`);
  const evidence = assertReleaseBound(content, name, spec);

  if (name === "migration-evidence.json") {
    if (
      evidence.status !== "applied" ||
      evidence.phase !== (spec.deployment_mode === "bootstrap" ? "bootstrap" : "expand") ||
      !sha256Pattern.test(evidence.migration_set_digest) ||
      !Array.isArray(evidence.applied) ||
      !Array.isArray(evidence.already_applied) ||
      !sha256Pattern.test(evidence.restore_point?.snapshot_digest) ||
      typeof evidence.restore_point?.snapshot_id !== "string"
    ) {
      throw new TypeError(`${name} is not a completed migration record`);
    }
    assertPlanDigest(evidence, context.initialDigest, name);
    assertApprovalEmbedded(evidence, foundation, name, spec);
    return;
  }

  if (name === "restore-point-evidence.json") {
    if (
      evidence.provider !== "neon" ||
      evidence.status !== "ready" ||
      evidence.project_id !== spec.neon_project_id ||
      evidence.source_branch_id !== spec.neon_branch_id ||
      evidence.snapshot_name !== `meltiply-${spec.release_id}` ||
      Date.parse(evidence.expires_at) !== Date.parse(spec.restore_point_expires_at) ||
      evidence.snapshot_digest !==
        sha256(
          [
            evidence.snapshot_id,
            evidence.snapshot_name,
            evidence.source_branch_id,
            evidence.created_at,
            evidence.expires_at,
          ].join("\0"),
        )
    ) {
      throw new TypeError(`${name} is not the reviewed restore point`);
    }
    assertPlanDigest(evidence, context.initialDigest, name);
    assertApprovalEmbedded(evidence, foundation, name, spec);
    return;
  }

  if (name.startsWith("worker-") && name.endsWith("-candidate.json")) {
    const worker = name.slice("worker-".length, -"-candidate.json".length);
    if (
      evidence.worker !== worker ||
      evidence.step !== (spec.deployment_mode === "bootstrap" ? "initialize" : "upload") ||
      evidence.deployment_mode !== spec.deployment_mode ||
      !sha256Pattern.test(evidence.config_digest) ||
      !uuidPattern.test(evidence.version_id)
    ) {
      throw new TypeError(`${name} is not the reviewed worker candidate`);
    }
    if (spec.deployment_mode === "bootstrap") {
      if (evidence.previous_version_id !== null) {
        throw new TypeError(`${name} must not record a previous version`);
      }
    } else {
      validateWorkerVersionId(evidence.previous_version_id);
    }
    // Cloudflare version URLs take the `${id8}-${hostname}` form.
    const hostname = new URL(spec.api_workers_dev_url).hostname;
    const expectedAlias =
      worker === "api" && spec.deployment_mode === "update"
        ? `https://${spec.release_id}-${hostname}`
        : null;
    const expectedPreview =
      worker === "api" ? `https://${evidence.version_id.slice(0, 8)}-${hostname}` : null;
    const urls = [evidence.preview_alias_url, evidence.preview_url];
    if (urls.some((value) => value !== null)) {
      if (
        evidence.preview_alias_url !== expectedAlias ||
        evidence.preview_url !== expectedPreview
      ) {
        throw new TypeError(`${name} records an unexpected version URL`);
      }
    }
    assertPlanDigest(evidence, context.initialDigest, name);
    assertApprovalEmbedded(evidence, foundation, name, spec);
    return;
  }

  if (name.startsWith("worker-") && name.endsWith("-secrets.json")) {
    const worker = name.slice("worker-".length, -"-secrets.json".length);
    const required = requiredRemoteSecrets(spec)[worker];
    if (
      evidence.worker !== worker ||
      JSON.stringify(evidence.secret_names) !== JSON.stringify(required) ||
      !uuidPattern.test(evidence.version_id) ||
      evidence.based_on_version_id !== context.candidate[worker]
    ) {
      throw new TypeError(`${name} is not the reviewed secrets version`);
    }
    assertPlanDigest(evidence, context.initialDigest, name);
    assertApprovalEmbedded(evidence, foundation, name, spec);
    return;
  }

  if (name.startsWith("worker-") && name.endsWith("-deployment.json")) {
    const worker = name.slice("worker-".length, -"-deployment.json".length);
    const traffic = validTraffic(evidence.traffic, name);
    if (evidence.worker !== worker || traffic.length !== 1 || traffic[0].percentage !== 100) {
      throw new TypeError(`${name} does not prove full activation`);
    }
    const deployedIds = {
      api: context.secretsVersionId,
      automation: context.candidate.automation_secrets,
      state: context.candidate.state,
      frontend: context.candidate.frontend,
    };
    if (evidence.version_id !== deployedIds[worker]) {
      throw new TypeError(`${name} activated the wrong Worker version`);
    }
    if (evidence.version_id !== traffic[0].version_id) {
      throw new TypeError(`${name} traffic does not match its version`);
    }
    assertPlanDigest(evidence, context.initialDigest, name);
    assertApprovalEmbedded(evidence, foundation, name, spec);
    return;
  }

  if (rolloutEvidencePattern.test(name)) {
    const percentage = Number(name.slice(12, -5));
    const traffic = validTraffic(evidence.traffic, name);
    const candidateEntry = traffic.find((entry) => entry.version_id === context.secretsVersionId);
    if (
      evidence.worker !== "api" ||
      evidence.percentage !== percentage ||
      !candidateEntry ||
      candidateEntry.percentage !== percentage ||
      evidence.version_id !== context.secretsVersionId ||
      (percentage === 100 && traffic.length !== 1) ||
      (percentage !== 100 &&
        (traffic.length !== 2 ||
          traffic.find((entry) => entry !== candidateEntry)?.version_id !==
            context.candidate.api_previous ||
          traffic.find((entry) => entry !== candidateEntry)?.percentage !== 100 - percentage))
    ) {
      throw new TypeError(`${name} does not prove the staged rollout`);
    }
    assertPlanDigest(evidence, context.domainDigest, name);
    const trafficApproval = context.approvalByName.get(`${spec.environment}-traffic-approval`);
    assertApprovalEmbedded(evidence, trafficApproval, name, spec);
    return;
  }

  if (name === "smoke-version.json") {
    const hostname = new URL(spec.api_workers_dev_url).hostname;
    if (
      evidence.phase !== "version" ||
      evidence.status !== "passed" ||
      evidence.worker !== "api" ||
      evidence.version_id !== context.secretsVersionId ||
      evidence.candidate_version_id !== context.candidate.api
    ) {
      throw new TypeError(`${name} is not the immutable candidate smoke`);
    }
    validateSmokeHealth(
      evidence,
      `https://${context.secretsVersionId.slice(0, 8)}-${hostname}/api/v1/health`,
      name,
      true,
      spec,
    );
    return;
  }

  if (smokeEvidencePattern.test(name)) {
    const suffix = name === "smoke-live.json" ? null : name.slice(11, -5);
    const percentage = suffix === null ? 100 : Number(suffix);
    if (
      evidence.phase !== "live" ||
      evidence.status !== "passed" ||
      evidence.worker !== "api" ||
      evidence.percentage !== percentage ||
      evidence.version_id !== context.secretsVersionId
    ) {
      throw new TypeError(`${name} is not the live smoke proof`);
    }
    const traffic = validTraffic(evidence.traffic, name);
    if (JSON.stringify(traffic) !== JSON.stringify(context.expectedTraffic[percentage])) {
      throw new TypeError(`${name} traffic does not match the rollout proof`);
    }
    validateSmokeHealth(
      evidence,
      `${spec.app_url}/api/v1/health`,
      name,
      percentage === 100,
      spec,
      percentage !== 100 ? context.candidate.api_previous : undefined,
    );
    return;
  }

  if (name === "automation-cron-paused.json" || name === "automation-cron-active.json") {
    const activating = name === "automation-cron-active.json";
    if (
      evidence.worker !== "automation" ||
      evidence.phase !== (activating ? "cron-activate" : "cron-pause") ||
      evidence.status !== (activating ? "active" : "empty") ||
      !sha256Pattern.test(evidence.schedule_set_digest)
    ) {
      throw new TypeError(`${name} is not a proven Cron transition`);
    }
    if (activating) {
      assertPlanDigest(evidence, context.unpauseDigest, name);
      const resumeApproval = context.approvalByName.get(
        `${spec.environment}-queue-resume-approval`,
      );
      assertApprovalEmbedded(evidence, resumeApproval, name, spec);
    } else {
      assertPlanDigest(evidence, context.initialDigest, name);
      assertApprovalEmbedded(evidence, foundation, name, spec);
    }
    return;
  }

  throw new TypeError(`${name} has no release evidence contract`);
}

function assertSecretFree(content, environment, name) {
  if (containsCredentialMaterial(content)) {
    throw new TypeError(`${name} embeds credential material`);
  }
  for (const variable of secretEnvironmentNames) {
    const value = environment[variable];
    if (typeof value === "string" && value.length >= 8 && content.includes(value)) {
      throw new TypeError(`${name} embeds a protected secret value`);
    }
  }
}

async function openapiContract(repoRoot) {
  const relativePath = "packages/contracts/openapi.yaml";
  const filePath = path.join(repoRoot, relativePath);
  const details = await stat(filePath);
  if (!details.isFile() || details.size > maximumFileBytes) {
    throw new TypeError("the OpenAPI contract is missing or too large");
  }
  const content = await readFile(filePath, "utf8");
  const infoBlock = content.match(openapiInfoPattern);
  const version = infoBlock?.[1]?.match(openapiVersionPattern);
  const value = version?.[1]?.replace(edgeQuotesPattern, "");
  if (typeof value !== "string" || !contractVersionPattern.test(value)) {
    throw new TypeError("the OpenAPI contract lacks a valid info.version");
  }
  return { path: relativePath, sha256: sha256(content), version: value };
}

export async function buildReleaseManifest({
  approvalPaths,
  environment,
  iac,
  outDir,
  repoRoot,
  spec,
}) {
  const mode = spec.deployment_mode;
  const initialPhase = mode === "bootstrap" ? "foundation" : "pause";
  const publishable = new Set([...evidenceByMode.common, ...evidenceByMode[mode]]);

  const [initialDigest, domainDigest, unpauseDigest] = await Promise.all([
    readPlanDigest(outDir, initialPhase),
    readPlanDigest(outDir, "domain"),
    readPlanDigest(outDir, "unpause"),
  ]);

  const approvals = await loadApprovalMetadata({
    expectedNames: new Set(approvalScopes.map((scope) => `${spec.environment}-${scope}-approval`)),
    paths: approvalPaths,
    planDigests: new Map([
      [`${spec.environment}-foundation-approval`, initialDigest],
      [`${spec.environment}-traffic-approval`, domainDigest],
      [`${spec.environment}-queue-resume-approval`, unpauseDigest],
    ]),
    spec,
  });

  const entries = await readdir(outDir, { withFileTypes: true });
  const wranglerEntries = [];
  const wranglerLogFiles = [];
  const publishFiles = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name !== "wrangler") {
        throw new TypeError(`unclassified release artifact: ${entry.name}`);
      }
      const children = await readdir(path.join(outDir, "wrangler"), {
        withFileTypes: true,
      });
      for (const child of children) {
        if (!child.isFile() || !evidenceLogPattern.test(child.name)) {
          throw new TypeError(`unclassified rendered artifact: wrangler/${child.name}`);
        }
        wranglerEntries.push(child.name);
      }
      continue;
    }
    if (publishable.has(entry.name)) {
      publishFiles.push(entry.name);
    } else if (wranglerLogPattern.test(entry.name)) {
      wranglerLogFiles.push(entry.name);
    } else if (!privateAllowlist.has(entry.name)) {
      throw new TypeError(`unclassified release artifact: ${entry.name}`);
    }
  }

  const required = [...publishable].sort();
  const missing = required.filter((name) => !publishFiles.includes(name) && name !== manifestName);
  if (missing.length > 0) {
    throw new TypeError(`release evidence is incomplete: ${missing.join(", ")}`);
  }

  const approvalByName = new Map(
    approvals.map((approval) => [approval.approval_job.name, approval]),
  );

  const files = [];
  let candidateEvidence;
  let secretsEvidence;
  const documents = new Map();
  for (const name of publishFiles) {
    const filePath = path.join(outDir, name);
    const details = await stat(filePath);
    if (!details.isFile() || details.size === 0 || details.size > maximumFileBytes) {
      throw new TypeError(`${name} is empty or too large`);
    }
    const content = await readFile(filePath, "utf8");
    assertSecretFree(content, environment, name);
    const digest = sha256(content);
    files.push({ bytes: details.size, file: name, sha256: digest });

    if (name.endsWith(".sha256")) continue;
    if (name.endsWith(".json")) {
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new TypeError(`${name} must contain valid JSON`);
      }
      documents.set(name, parsed);
      if (name.startsWith("approval-")) {
        const approval = validateApprovalMetadata(parsed, spec);
        if (
          approval.approval_job.name !==
          name
            .slice(9, -5)
            .replace(deploymentPhasePattern, (part) => `${spec.environment}-${part}-approval`)
        ) {
          throw new TypeError(`${name} holds an unexpected approval job`);
        }
        const loaded = approvalByName.get(approval.approval_job.name);
        if (JSON.stringify(approval) !== JSON.stringify(loaded)) {
          throw new TypeError(`${name} diverges from the approved metadata`);
        }
      } else if (name.endsWith("-plan-summary.json")) {
        validatePlanSummary(parsed, name.slice(0, -"-plan-summary.json".length), spec);
      } else if (name.startsWith("iac-outputs-")) {
        validatePhaseOutputs(parsed, name.slice(12, -5), spec);
      } else if (name === "worker-api-candidate.json") {
        candidateEvidence = assertReleaseBound(parsed, name, spec);
      } else if (name === "worker-api-secrets.json") {
        secretsEvidence = assertReleaseBound(parsed, name, spec);
      }
    }
  }

  if (!candidateEvidence || !secretsEvidence) {
    throw new TypeError("API candidate evidence is incomplete");
  }
  const secretsVersionId = validateWorkerVersionId(secretsEvidence.version_id);
  if (secretsEvidence.based_on_version_id !== candidateEvidence.version_id) {
    throw new TypeError("API secrets evidence is not based on the candidate");
  }
  const expectedTraffic = {
    100: [{ percentage: 100, version_id: secretsVersionId }],
  };
  for (const percentage of [5, 25, 50]) {
    const previous = candidateEvidence.previous_version_id;
    if (typeof previous === "string") {
      expectedTraffic[percentage] = [
        { percentage, version_id: secretsVersionId },
        { percentage: 100 - percentage, version_id: previous },
      ].sort((left, right) => left.version_id.localeCompare(right.version_id));
    }
  }
  const context = evidenceContext({
    approvals,
    candidate: {
      api: candidateEvidence.version_id,
      api_previous: candidateEvidence.previous_version_id,
      automation: documents.get("worker-automation-candidate.json")?.version_id,
      automation_secrets: documents.get("worker-automation-secrets.json")?.version_id,
      state: documents.get("worker-state-candidate.json")?.version_id,
      frontend: documents.get("worker-frontend-candidate.json")?.version_id,
    },
    domainDigest,
    expectedTraffic,
    initialDigest,
    secretsVersionId,
    unpauseDigest,
  });

  for (const [name, parsed] of documents) {
    if (
      name.startsWith("approval-") ||
      name.endsWith("-plan-summary.json") ||
      name.startsWith("iac-outputs-")
    ) {
      continue;
    }
    validateEvidenceDocument({ content: parsed, context, name, spec });
  }
  await assertFrontendReleaseEvidence({ iac, outDir, spec });

  const finalContent = await readFile(path.join(outDir, "iac-outputs.json"), "utf8");
  assertSecretFree(finalContent, environment, "iac-outputs.json");
  const unpauseOutputsHash = files.find((entry) => entry.file === "iac-outputs-unpause.json");
  if (!unpauseOutputsHash || sha256(finalContent) !== unpauseOutputsHash.sha256) {
    throw new TypeError("current IaC outputs do not match the unpause transition");
  }
  let parsedFinal;
  try {
    parsedFinal = JSON.parse(finalContent);
  } catch {
    throw new TypeError("current IaC outputs must contain valid JSON");
  }
  const finalIac = validateIacOutputs(parsedFinal, spec);
  if (JSON.stringify(stableValue(finalIac)) !== JSON.stringify(stableValue(iac))) {
    throw new TypeError("current IaC outputs diverge from the loaded outputs");
  }
  const resources = iac.release_resources;
  const active = iacPhaseStates.active;
  if (
    [
      resources.app_custom_domains_attached,
      resources.queue_consumers_attached,
      resources.queue_delivery_paused,
    ].some((value, index) => value !== active[index])
  ) {
    throw new TypeError("final IaC outputs do not prove the active release");
  }

  for (const name of wranglerEntries) {
    const content = await readFile(path.join(outDir, "wrangler", name), "utf8");
    assertSecretFree(content, environment, `wrangler/${name}`);
  }
  for (const name of wranglerLogFiles) {
    const content = await readFile(path.join(outDir, name), "utf8");
    assertSecretFree(content, environment, name);
  }

  const contract = await openapiContract(repoRoot);

  const manifest = {
    deployment_mode: mode,
    environment: spec.environment,
    evidence: files.sort((left, right) => left.file.localeCompare(right.file)),
    git_sha: spec.git_sha,
    openapi: contract,
    release_id: spec.release_id,
    schema_version: 1,
    signoffs: approvals.map((approval) => ({
      approved_by: approval.approval_job.approved_by,
      job: approval.approval_job.name,
      job_id: approval.approval_job.id,
      plan_digest: approval.plan_digest,
      workflow_id: approval.workflow_id,
    })),
    status: "complete",
  };
  assertSecretFree(stableJson(manifest), environment, manifestName);
  await writeEvidence(outDir, manifestName, manifest);
  return manifest;
}
