import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { releaseInternals } from "./release-lib.mjs";

const gitShaPattern = /^[0-9a-f]{40}$/;
const planDigestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const approvalKeys = new Set([
  "approval_job",
  "pipeline_sha",
  "plan_digest",
  "schema_version",
  "workflow_id",
]);
const approvalJobKeys = new Set(["approved_by", "id", "name", "status"]);

/**
 * Validates that a value is a non-null, non-array object record.
 *
 * @param {unknown} value - Value to test
 * @param {string} name - Contextual label for error reporting
 * @returns {object} The validated object
 * @throws {TypeError} If value is null, array, or not an object
 */
function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Asserts that an object contains exactly the expected set of keys, with no extra or missing keys.
 *
 * @param {object} value - Object to inspect
 * @param {Set<string>} expected - Set of required key names
 * @param {string} name - Contextual label for error reporting
 * @returns {void}
 * @throws {TypeError} If any unknown or missing keys are detected
 */
function exactKeys(value, expected, name) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !(key in value));
  if (unknown.length > 0) {
    throw new TypeError(`${name} contains unknown fields: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new TypeError(`${name} is missing fields: ${missing.join(", ")}`);
  }
}

/**
 * Validates that a value is a string satisfying a specified regular expression pattern.
 *
 * @param {unknown} value - Value to validate
 * @param {RegExp} pattern - Regular expression to match
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated string value
 * @throws {TypeError} If value is not a string or fails regex match
 */
function matchedString(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * Computes a hexadecimal SHA-256 hash of a string or Buffer payload.
 *
 * @param {string | Buffer} value - Data to hash
 * @returns {string} 64-character lowercase hexadecimal hash
 */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Reads a JSON file from disk with strict size bounds and format validation.
 *
 * @param {string} filePath - Absolute or relative path to file
 * @param {string} name - Contextual label for error reporting
 * @param {number} [maximumBytes=65536] - Maximum allowable file size in bytes
 * @returns {Promise<any>} Parsed JSON content
 * @throws {TypeError} If file does not exist, exceeds size limits, is empty, or has invalid JSON syntax
 */
export async function readJsonFile(filePath, name, maximumBytes = 64 * 1024) {
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0 || details.size > maximumBytes) {
    throw new TypeError(`${name} must be a non-empty file no larger than ${maximumBytes} bytes`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new TypeError(`${name} must contain valid JSON`);
  }
}

/**
 * Validates an operator review record against release invariants.
 * Enforces schema version 1, a release-session UUID, a bounded operator label,
 * successful review, a valid phase name, and exact Git SHA parity with the release.
 *
 * @param {unknown} input - Raw parsed JSON approval metadata
 * @param {object} spec - Release specification object
 * @returns {object} Normalized, validated approval metadata record
 * @throws {TypeError} If schema, job naming, UUID formatting, or Git SHA validation fails
 */
export function validateApprovalMetadata(input, spec) {
  const approval = plainObject(input, "approval metadata");
  exactKeys(approval, approvalKeys, "approval metadata");
  if (approval.schema_version !== 1) {
    throw new TypeError("approval metadata schema_version must be 1");
  }
  matchedString(approval.workflow_id, uuidPattern, "approval metadata workflow_id");
  matchedString(approval.pipeline_sha, gitShaPattern, "approval metadata pipeline_sha");
  matchedString(approval.plan_digest, planDigestPattern, "approval metadata plan_digest");
  if (approval.pipeline_sha !== spec.git_sha) {
    throw new TypeError("approval metadata pipeline_sha does not match the release");
  }

  const job = plainObject(approval.approval_job, "approval metadata approval_job");
  exactKeys(job, approvalJobKeys, "approval metadata approval_job");
  matchedString(job.id, uuidPattern, "approval metadata approval_job.id");
  matchedString(job.approved_by, /^[A-Za-z0-9][A-Za-z0-9@._+ -]{0,127}$/, "approval operator");
  if (job.status !== "success") {
    throw new TypeError("approval metadata approval_job.status must be success");
  }
  if (typeof job.name !== "string" || !/^staging-[a-z0-9-]+-approval$/.test(job.name)) {
    throw new TypeError("approval metadata approval_job.name is invalid");
  }

  return {
    approval_job: {
      approved_by: job.approved_by,
      id: job.id.toLowerCase(),
      name: job.name,
      status: "success",
    },
    pipeline_sha: approval.pipeline_sha,
    plan_digest: approval.plan_digest,
    schema_version: 1,
    workflow_id: approval.workflow_id.toLowerCase(),
  };
}

/**
 * Loads operator review files, requiring distinct phases in one release session
 * and the expected reviewed plan digest for each phase.
 *
 * @param {object} params - Loading options
 * @param {Set<string>} params.expectedNames - Set of required approval job names
 * @param {Array<string>} params.paths - File paths to approval metadata JSON files
 * @param {string} [params.planDigest] - Single expected OpenTofu plan digest
 * @param {Map<string, string>} [params.planDigests] - Per-job expected plan digests
 * @param {object} params.spec - Release specification object
 * @returns {Promise<Array<object>>} Sorted array of validated approval records
 * @throws {TypeError} If files are missing, duplicated, incomplete, or digests mismatch
 */
export async function loadApprovalMetadata({
  expectedNames,
  paths,
  planDigest,
  planDigests,
  spec,
}) {
  if (!(expectedNames instanceof Set) || expectedNames.size === 0) {
    throw new TypeError("expected approval names must be a non-empty set");
  }
  if (planDigest !== undefined && planDigests !== undefined) {
    throw new TypeError("approval loading accepts one plan digest mode");
  }
  if (planDigests !== undefined) {
    if (!(planDigests instanceof Map)) {
      throw new TypeError("approval plan digests must be a map");
    }
    const unknown = [...planDigests.keys()].filter((name) => !expectedNames.has(name));
    const missing = [...expectedNames].filter((name) => !planDigests.has(name));
    if (unknown.length > 0 || missing.length > 0) {
      throw new TypeError("approval plan digests must match expected approvals");
    }
    for (const digest of planDigests.values()) {
      matchedString(digest, planDigestPattern, "approval plan digest");
    }
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TypeError("at least one --approval-metadata file is required");
  }
  const approvals = await Promise.all(
    paths.map(async (approvalPath, index) =>
      validateApprovalMetadata(
        await readJsonFile(approvalPath, `approval metadata ${index + 1}`, 32 * 1024),
        spec,
      ),
    ),
  );
  const names = new Set();
  const ids = new Set();
  const workflows = new Set();
  for (const approval of approvals) {
    if (!expectedNames.has(approval.approval_job.name)) {
      throw new TypeError(`approval ${approval.approval_job.name} is not valid for this operation`);
    }
    const expectedDigest = planDigests?.get(approval.approval_job.name) ?? planDigest;
    if (approval.plan_digest !== expectedDigest) {
      throw new TypeError("approval metadata plan_digest does not match --plan-digest");
    }
    if (names.has(approval.approval_job.name) || ids.has(approval.approval_job.id)) {
      throw new TypeError("approval metadata files must identify distinct approval jobs");
    }
    names.add(approval.approval_job.name);
    ids.add(approval.approval_job.id);
    workflows.add(approval.workflow_id);
  }
  const missing = [...expectedNames].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new TypeError(`approval metadata is missing required jobs: ${missing.join(", ")}`);
  }
  if (workflows.size !== 1) {
    throw new TypeError("approval metadata must belong to one release session");
  }
  return approvals.sort((left, right) =>
    left.approval_job.name.localeCompare(right.approval_job.name),
  );
}

/**
 * Asserts explicit human intent for mutating release commands.
 * Requires `--apply`, exact string confirmation matching `release staging <git_sha>`,
 * valid SHA-256 plan digest, and verifies working tree commit matches release SHA.
 *
 * @param {object} params - Confirmation parameters
 * @param {boolean} params.apply - Flag indicating mutation execution
 * @param {string} params.confirm - Explicit confirmation string
 * @param {string} [params.currentSha] - Checked-out Git commit SHA
 * @param {string} params.planDigest - SHA-256 digest of the reviewed OpenTofu plan
 * @param {object} params.spec - Release specification object
 * @returns {void}
 * @throws {TypeError} If apply is false, confirmation string does not match, or Git SHA differs
 */
export function assertMutatingIntent({ apply, confirm, currentSha, planDigest, spec }) {
  if (apply !== true) {
    throw new TypeError("mutating release commands require --apply");
  }
  const expected = `release staging ${spec.git_sha}`;
  if (confirm !== expected) {
    throw new TypeError(`--confirm must exactly equal ${expected}`);
  }
  matchedString(planDigest, planDigestPattern, "--plan-digest");
  if (currentSha !== undefined && currentSha !== spec.git_sha) {
    throw new TypeError("the checked-out commit does not match the release git_sha");
  }
}

/**
 * Verifies that the current Git repository working tree is clean and checked out
 * to the exact commit SHA designated in the release specification.
 *
 * @param {object} params - Checkout verification parameters
 * @param {string} params.repoRoot - Path to the root of the Git repository
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess command runner
 * @param {object} params.spec - Release specification object
 * @returns {Promise<string>} Verified HEAD commit SHA
 * @throws {TypeError} If working tree is dirty or HEAD does not match spec.git_sha
 */
export async function verifyReleaseCheckout({ repoRoot, runCommand, spec }) {
  const [head, status] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    runCommand("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repoRoot,
    }),
  ]);
  const currentSha = head.stdout.trim();
  if (currentSha !== spec.git_sha) {
    throw new TypeError("the checked-out commit does not match the release git_sha");
  }
  if (status.stdout.trim()) {
    throw new TypeError("tracked working tree changes are not releasable");
  }
  return currentSha;
}

/**
 * Checks a clean checkout at the release SHA, explicit mutation intent, and
 * phase-scoped operator review records. This is an accident-prevention gate;
 * filesystem access and deployment credentials, not these JSON files, authorize the operator.
 *
 * @param {object} params - Authorization parameters
 * @param {boolean} params.apply - Apply flag
 * @param {Array<string>} params.approvalPaths - Paths to approval metadata JSON files
 * @param {string} params.confirm - User-supplied confirmation string
 * @param {Set<string>} params.expectedApprovalNames - Required approval job names
 * @param {string} params.planDigest - Reviewed OpenTofu plan digest
 * @param {string} params.repoRoot - Repository root directory path
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess command runner
 * @param {object} params.spec - Release specification object
 * @returns {Promise<Array<object>>} Loaded, verified approval records
 */
export async function authorizeMutation({
  apply,
  approvalPaths,
  confirm,
  expectedApprovalNames,
  planDigest,
  repoRoot,
  runCommand,
  spec,
}) {
  const currentSha = await verifyReleaseCheckout({
    repoRoot,
    runCommand,
    spec,
  });
  assertMutatingIntent({ apply, confirm, currentSha, planDigest, spec });
  return loadApprovalMetadata({
    expectedNames: expectedApprovalNames,
    paths: approvalPaths,
    planDigest,
    spec,
  });
}

/**
 * Expected post-apply activation outputs for each IaC release phase, expressed
 * as [app_custom_domains_attached, queue_consumers_attached,
 * queue_delivery_paused]. Exported so manifest validation can cross-check
 * redacted plan summaries against the same phase contract the guard enforces.
 */
export const iacPhaseStates = Object.freeze({
  active: [true, true, false],
  "consumers-paused": [false, true, true],
  "domains-paused": [true, true, true],
  foundation: [false, false, true],
});

/**
 * Asserts that the post-apply OpenTofu IaC outputs match the exact expected state
 * for the target release phase (e.g., active, consumers-paused, domains-paused, foundation).
 *
 * @param {object} iac - Parsed post-apply IaC output object
 * @param {string} phase - Target release phase name
 * @param {object} spec - Release specification object
 * @returns {string} Confirmed release phase string
 * @throws {TypeError} If phase is invalid or IaC outputs do not match the phase specification
 */
export function assertIacState(iac, phase, spec) {
  const expected = iacPhaseStates[phase];
  if (!expected) throw new TypeError(`unknown IaC release phase: ${phase}`);
  if (phase === "foundation" && spec.deployment_mode !== "bootstrap") {
    throw new TypeError("foundation IaC state is valid only for bootstrap releases");
  }
  const resources = plainObject(iac.release_resources, "IaC release_resources");
  const actual = [
    resources.app_custom_domains_attached,
    resources.queue_consumers_attached,
    resources.queue_delivery_paused,
  ];
  if (actual.some((value) => typeof value !== "boolean")) {
    throw new TypeError("IaC release activation outputs must be boolean");
  }
  if (actual.some((value, index) => value !== expected[index])) {
    throw new TypeError(`IaC outputs do not prove the ${phase} release state`);
  }
  return phase;
}

/**
 * Atomically writes an evidence record to a private directory (0o700) using a secure temporary file (0o600)
 * and atomic rename to prevent partial or corrupted reads by concurrent processes.
 *
 * @param {string} outDir - Target directory for evidence files
 * @param {string} filename - Base filename matching `^[a-z0-9][a-z0-9.-]*\.json$`
 * @param {unknown} value - JSON-serializable evidence data
 * @returns {Promise<string>} Absolute destination path of written evidence file
 * @throws {TypeError} If filename pattern is invalid
 */
export async function writeEvidence(outDir, filename, value) {
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(filename)) {
    throw new TypeError("evidence filename is invalid");
  }
  await mkdir(outDir, { mode: 0o700, recursive: true });
  const target = path.join(outDir, filename);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, releaseInternals.json(value), { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
