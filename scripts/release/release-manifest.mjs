import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  iacPhaseStates,
  loadApprovalMetadata,
  sha256,
  validateApprovalMetadata,
  writeEvidence,
} from "./release-guard.mjs";
import {
  containsCredentialMaterial,
  releaseInternals,
  validateIacOutputs,
} from "./release-lib.mjs";
import { validateWorkerVersionId } from "./release-worker.mjs";

const manifestName = "release-manifest.json";
const maximumFileBytes = 512 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;

// Environment variables whose values must never appear in published evidence.
// Mirrors redactError's secret set plus the raw release secret bundle variable.
const secretEnvironmentNames = [
  "CLOUDFLARE_API_TOKEN",
  "MELTIPLY_AUTHENTICATED_DATABASE_URL",
  "MELTIPLY_RELEASE_SECRETS_JSON",
  "MELTIPLY_SYSTEM_DATABASE_URL",
  "NEON_API_KEY",
  "TF_HTTP_PASSWORD",
];

// Files that may exist in the release directory but are never publishable:
// the reviewed input itself, the current post-apply outputs, plaintext phase
// markers written by CI shell steps, and a prior manifest being regenerated.
const privateAllowlist = new Set([
  "consumers-transition",
  "deployment-mode",
  "iac-outputs.json",
  "initial-phase",
  "release-input.json",
  "release-manifest.json",
  "reviewed-sha",
]);

// IaC phase proven by each transition's post-apply outputs.
const transitionStates = Object.freeze({
  domain: "domains-paused",
  foundation: "foundation",
  pause: "domains-paused",
  "paused-consumers": "consumers-paused",
  unpause: "active",
});

// Publishable evidence per deployment mode, mirroring the CI staging-manifest
// copy allowlist. Common entries are required for every release; the mode
// lists add their own artifacts and forbid the other mode's files.
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

// Holds and the transition plan digest each must bind.
const holds = Object.freeze([
  Object.freeze({ name: "staging-foundation-approval" }),
  Object.freeze({ name: "staging-traffic-approval" }),
  Object.freeze({ name: "staging-queue-resume-approval" }),
]);

/**
 * Asserts a value is a non-null, non-array object.
 *
 * @param {unknown} value - Candidate value
 * @param {string} name - Contextual label for error reporting
 * @returns {object} The validated object
 * @throws {TypeError} If the value is not a plain object
 */
function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Asserts a string matches a fixed pattern.
 *
 * @param {unknown} value - Candidate string
 * @param {RegExp} pattern - Required pattern
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated string
 * @throws {TypeError} If the value is missing or malformed
 */
function matchedString(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * Asserts that an evidence record binds the current release identity.
 *
 * @param {object} evidence - Parsed evidence record
 * @param {string} name - Evidence description for error reporting
 * @param {object} spec - Validated release specification
 * @returns {object} The validated record
 * @throws {TypeError} If schema, release ID, or Git SHA do not match the spec
 */
function assertReleaseBound(evidence, name, spec) {
  plainObject(evidence, name);
  if (
    evidence.schema_version !== 1 ||
    evidence.release_id !== spec.release_id ||
    evidence.git_sha !== spec.git_sha
  ) {
    throw new TypeError(`${name} does not match the release`);
  }
  return evidence;
}

/**
 * Asserts an evidence record's approvals equal one loaded approval hold.
 *
 * Release mutations embed the exact validated approval records used at
 * execution time, so manifest validation re-normalizes the embedded record
 * and requires deep equality rather than accepting any well-formed approval.
 *
 * @param {object} evidence - Parsed evidence record
 * @param {object} approval - Loaded approval record for the expected hold
 * @param {string} name - Contextual label for error reporting
 * @param {object} spec - Validated release specification
 * @throws {TypeError} If the embedded approvals differ from the loaded hold
 */
function assertApprovalEmbedded(evidence, approval, name, spec) {
  if (!Array.isArray(evidence.approvals) || evidence.approvals.length !== 1) {
    throw new TypeError(`${name} embeds unexpected approval records`);
  }
  const normalized = validateApprovalMetadata(evidence.approvals[0], spec);
  if (JSON.stringify(normalized) !== JSON.stringify(approval)) {
    throw new TypeError(`${name} embeds unexpected approval records`);
  }
}

/**
 * Asserts an evidence record binds the reviewed OpenTofu plan for its phase.
 *
 * @param {object} evidence - Parsed evidence record
 * @param {string} digest - Expected SHA-256 digest of the reviewed saved plan
 * @param {string} name - Contextual label for error reporting
 * @throws {TypeError} If the embedded plan digest differs from the reviewed digest
 */
function assertPlanDigest(evidence, digest, name) {
  if (evidence.plan_digest !== digest) {
    throw new TypeError(`${name} binds an unexpected plan digest`);
  }
}

/**
 * Asserts a Worker traffic array is well-formed and totals 100 percent.
 *
 * @param {unknown} traffic - Candidate traffic array
 * @param {string} name - Contextual label for error reporting
 * @returns {Array<{ percentage: number, version_id: string }>} Validated traffic entries
 * @throws {TypeError} If entries are malformed or the split does not total 100
 */
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

/**
 * Reads and validates a `<phase>-plan.sha256` digest file.
 *
 * @param {string} outDir - Release output directory
 * @param {string} phase - Transition phase name
 * @returns {Promise<string>} 64-hex plan digest
 * @throws {TypeError} If the file is missing or malformed
 */
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

/**
 * Validates a redacted `<phase>-plan-summary.json` against the phase contract.
 *
 * Requires the exact schema emitted by scripts/infra/release-plan.mjs and
 * cross-checks the recorded transition variables against the same phase
 * triples enforced on live IaC outputs, so a summary cannot drift from the
 * transition it claims to review.
 *
 * @param {object} summary - Parsed plan summary
 * @param {string} phase - Expected transition phase name
 * @throws {TypeError} If fields, phase, or transition invariants mismatch
 */
function validatePlanSummary(summary, phase) {
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
    transition.attach_app_custom_domains,
    transition.attach_queue_consumers,
    transition.queue_delivery_paused,
  ];
  if (
    transition.environment !== "staging" ||
    actual.some((value) => typeof value !== "boolean") ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(`${phase} plan summary does not prove the expected transition`);
  }
  // A bounded change list is sufficient: a no-op transition (empty plan) is a
  // legitimate outcome already proven by the phase variable triple above.
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

/**
 * Validates a post-apply `iac-outputs-<phase>.json` file.
 *
 * Re-runs the full IaC output validation against the release spec and asserts
 * the activation triple proves the exact phase state, so published outputs
 * cannot claim a different transition than the one reviewed and applied.
 *
 * @param {object} outputs - Raw parsed IaC outputs
 * @param {string} phase - Transition phase the outputs must prove
 * @param {object} spec - Validated release specification
 * @throws {TypeError} If outputs fail spec validation or phase invariants
 */
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

/**
 * Validates deployment and contract identities in the health sub-record embedded in smoke evidence.
 *
 * @param {object} evidence - Parsed smoke evidence record
 * @param {string} url - Expected probe URL (version URL or live hostname + path)
 * @param {string} name - Contextual label for error reporting
 * @param {boolean} versionPinned - Whether the served version must equal the release SHA
 * @param {object} spec - Validated release specification
 * @throws {TypeError} If the health record fails URL, status, or version checks
 */
function validateSmokeHealth(evidence, url, name, versionPinned, spec) {
  const health = plainObject(evidence.health, `${name} health`);
  matchedString(health.url, /^https:\/\/[^\s]+$/, `${name} health.url`);
  if (health.url !== url) {
    throw new TypeError(`${name} health probes the wrong URL`);
  }
  if (
    typeof health.contract_version !== "string" ||
    health.contract_version.length === 0 ||
    health.environment !== "staging" ||
    health.status !== "ok" ||
    !gitShaPattern.test(health.version)
  ) {
    throw new TypeError(`${name} health is not the staging contract`);
  }
  if (versionPinned && health.version !== spec.git_sha) {
    throw new TypeError(`${name} health version does not match the release`);
  }
}

/**
 * Builds a per-filename validator context holding digests, approvals, and
 * cross-evidence identities reused across validation branches.
 */
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

/**
 * Validates one allowlisted release-evidence JSON document.
 *
 * Enforces release binding, kind-specific field contracts, the approval hold
 * and plan digest the underlying mutation ran under, and cross-file identity
 * (rollouts and smoke records must reference the deployed secrets version).
 *
 * @param {object} params - Validation parameters
 * @param {object} params.content - Parsed JSON document
 * @param {object} params.context - Shared evidence context
 * @param {string} params.name - Evidence filename
 * @param {object} params.spec - Validated release specification
 * @throws {TypeError} If the document fails any evidence contract
 */
function validateEvidenceDocument({ content, context, name, spec }) {
  const foundation = context.approvalByName.get("staging-foundation-approval");
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
    // Version URLs are the immutable `${id8}-${hostname}` form; the update
    // alias is `--preview-alias <release_id>` rendered against the same
    // hostname. Recovery paths (`findUniqueTaggedVersion`) legitimately record
    // both URLs null — non-null values must match the exact identity.
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
    const required = releaseInternals.requiredRemoteSecrets(spec)[worker];
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
    // The activated version must be the version this release produced: the
    // state Worker deploys its code candidate directly, while api/automation
    // activate their secret-injected versions.
    const deployedIds = {
      api: context.secretsVersionId,
      automation: context.candidate.automation_secrets,
      state: context.candidate.state,
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

  if (/^api-rollout-(?:5|25|50|100)\.json$/.test(name)) {
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
    const trafficApproval = context.approvalByName.get("staging-traffic-approval");
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

  if (/^smoke-live(?:-(?:5|25|50|100))?\.json$/.test(name)) {
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
    // The live hostname legitimately serves the previous version during a
    // partial rollout; only a full (or bootstrap) deployment must serve the
    // release SHA deterministically.
    validateSmokeHealth(evidence, `${spec.app_url}/api/v1/health`, name, percentage === 100, spec);
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
      const resumeApproval = context.approvalByName.get("staging-queue-resume-approval");
      assertApprovalEmbedded(evidence, resumeApproval, name, spec);
    } else {
      assertPlanDigest(evidence, context.initialDigest, name);
      assertApprovalEmbedded(evidence, foundation, name, spec);
    }
    return;
  }

  throw new TypeError(`${name} has no release evidence contract`);
}

/**
 * Scans evidence bytes for credential material before publication.
 *
 * Two fail-closed layers: the shared release credential pattern (database
 * URLs, private keys, provider secret keys), then every populated protected
 * environment secret as a literal substring. A hit rejects the release
 * directory rather than redacting it, because published artifacts must never
 * have contained credentials in the first place.
 *
 * @param {string} content - Raw file text
 * @param {Record<string, string | undefined>} environment - Process environment
 * @param {string} name - Contextual label for error reporting
 * @throws {TypeError} If credential material is present
 */
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

/**
 * Extracts the declared contract version and digest of the canonical OpenAPI
 * document checked into the reviewed release commit.
 *
 * @param {string} repoRoot - Repository root directory path
 * @returns {Promise<{ path: string, sha256: string, version: string }>} Contract provenance record
 * @throws {TypeError} If the document is missing, oversized, or lacks info.version
 */
async function openapiContract(repoRoot) {
  const relativePath = "packages/contracts/openapi.yaml";
  const filePath = path.join(repoRoot, relativePath);
  const details = await stat(filePath);
  if (!details.isFile() || details.size > maximumFileBytes) {
    throw new TypeError("the OpenAPI contract is missing or too large");
  }
  const content = await readFile(filePath, "utf8");
  const infoBlock = content.match(/^info:\s*\n((?:[ \t]+[^\n]*\n)+)/m);
  const version = infoBlock?.[1]?.match(/^[ \t]+version:[ \t]*(.+?)[ \t]*$/m);
  const value = version?.[1]?.replace(/^["']|["']$/g, "");
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/.test(value)) {
    throw new TypeError("the OpenAPI contract lacks a valid info.version");
  }
  return { path: relativePath, sha256: sha256(content), version: value };
}

/**
 * Validates the allowlisted release evidence set and publishes the manifest.
 *
 * Classifies every file in the release directory as publishable evidence,
 * private scratch, or an illegal artifact; validates each allowlisted JSON
 * record against its contract (release binding, approval hold, plan digest,
 * cross-file version identity); binds all three operator reviews to
 * their per-phase plan digests; scans for credential material; and atomically
 * writes a deterministic redacted `release-manifest.json`.
 *
 * @param {object} params - Manifest parameters
 * @param {Array<string>} params.approvalPaths - Approval metadata file paths
 * @param {Record<string, string | undefined>} params.environment - Process environment
 * @param {object} params.iac - Validated current (final) IaC outputs
 * @param {string} params.outDir - Release output/evidence directory
 * @param {string} params.repoRoot - Repository root directory path
 * @param {object} params.spec - Validated release specification
 * @returns {Promise<object>} The written release manifest record
 * @throws {TypeError|Error} If evidence is missing, mismatched, secret-bearing, or approvals fail
 */
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

  // Every hold must bind its own reviewed plan; a later hold can never reuse
  // an earlier digest or label.
  const approvals = await loadApprovalMetadata({
    expectedNames: new Set(holds.map((hold) => hold.name)),
    paths: approvalPaths,
    planDigests: new Map([
      ["staging-foundation-approval", initialDigest],
      ["staging-traffic-approval", domainDigest],
      ["staging-queue-resume-approval", unpauseDigest],
    ]),
    spec,
  });

  // Classify the release directory. Unknown artifacts fail closed so the
  // allowlist can never silently admit an unreviewed file; a file valid for
  // the other deployment mode is rejected as stale or corrupted evidence.
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
        if (!child.isFile() || !/^(?:wrangler-)?[a-z0-9-]+\.jsonl?$/.test(child.name)) {
          throw new TypeError(`unclassified rendered artifact: wrangler/${child.name}`);
        }
        wranglerEntries.push(child.name);
      }
      continue;
    }
    if (publishable.has(entry.name)) {
      publishFiles.push(entry.name);
    } else if (/^wrangler-[a-z0-9-]+\.jsonl$/.test(entry.name)) {
      // Wrangler NDJSON output logs are private scratch: scanned for
      // credential material below but never publishable.
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

  // Approval files on the publishable list are independently re-validated
  // against the release and their bound phase digest so copied artifacts
  // cannot diverge from the metadata supplied to this command.
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
            .replace(/^(foundation|traffic|queue-resume)$/, (part) => `staging-${part}-approval`)
        ) {
          throw new TypeError(`${name} holds an unexpected approval job`);
        }
        const loaded = approvalByName.get(approval.approval_job.name);
        if (JSON.stringify(approval) !== JSON.stringify(loaded)) {
          throw new TypeError(`${name} diverges from the approved metadata`);
        }
      } else if (name.endsWith("-plan-summary.json")) {
        validatePlanSummary(parsed, name.slice(0, -"-plan-summary.json".length));
      } else if (name.startsWith("iac-outputs-")) {
        validatePhaseOutputs(parsed, name.slice(12, -5), spec);
      } else if (name === "worker-api-candidate.json") {
        candidateEvidence = assertReleaseBound(parsed, name, spec);
      } else if (name === "worker-api-secrets.json") {
        secretsEvidence = assertReleaseBound(parsed, name, spec);
      }
    }
  }

  // Cross-evidence identities the per-document validators bind against:
  // the immutable code candidate, the deployable secrets version, the
  // previous serving version, and each rollout's expected traffic split.
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

  // The final post-apply outputs must equal the unpause outputs byte-for-byte,
  // must equal the outputs supplied for validation, and must prove the fully
  // active end state.
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
  // The on-disk document is the raw OpenTofu output; the loaded `iac` input is
  // its normalized form. Revalidating the file and comparing normalized forms
  // proves the supplied outputs and the persisted outputs describe the same
  // staging state without a brittle byte-level identity requirement.
  const finalIac = validateIacOutputs(parsedFinal, spec);
  if (
    JSON.stringify(releaseInternals.stableValue(finalIac)) !==
    JSON.stringify(releaseInternals.stableValue(iac))
  ) {
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

  // Rendered configs and Wrangler output logs are scanned for credential
  // material as defense in depth; they are never publishable evidence.
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
    environment: "staging",
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
  assertSecretFree(releaseInternals.json(manifest), environment, manifestName);
  await writeEvidence(outDir, manifestName, manifest);
  return manifest;
}
