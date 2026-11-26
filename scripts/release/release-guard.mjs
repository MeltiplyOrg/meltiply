import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stableJson } from "../lib/stable-json.mjs";
import { exactKeys, matchedString, plainObject } from "./validation.mjs";

const approvalActorPattern = /^[A-Za-z0-9][A-Za-z0-9@._+ -]{0,127}$/;
const approvalEnvironmentPattern = /^[a-z]+-[a-z0-9-]+-approval$/;
const evidenceFilenamePattern = /^[a-z0-9][a-z0-9.-]*\.json$/;

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

export function assertReleaseBound(evidence, name, spec) {
  const record = plainObject(evidence, name);
  if (
    record.schema_version !== 1 ||
    record.release_id !== spec.release_id ||
    record.git_sha !== spec.git_sha
  ) {
    throw new TypeError(`${name} does not match the release`);
  }
  return record;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
  matchedString(job.approved_by, approvalActorPattern, "approval operator");
  if (job.status !== "success") {
    throw new TypeError("approval metadata approval_job.status must be success");
  }
  if (
    typeof job.name !== "string" ||
    !job.name.startsWith(`${spec.environment}-`) ||
    !approvalEnvironmentPattern.test(job.name)
  ) {
    throw new TypeError(
      "approval metadata approval_job.name is invalid for the release environment",
    );
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

export function assertMutatingIntent({ apply, confirm, currentSha, planDigest, spec }) {
  if (apply !== true) {
    throw new TypeError("mutating release commands require --apply");
  }
  const expected = `release ${spec.environment} ${spec.git_sha}`;
  if (confirm !== expected) {
    throw new TypeError(`--confirm must exactly equal ${expected}`);
  }
  matchedString(planDigest, planDigestPattern, "--plan-digest");
  if (currentSha !== undefined && currentSha !== spec.git_sha) {
    throw new TypeError("the checked-out commit does not match the release git_sha");
  }
}

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

export const iacPhaseStates = Object.freeze({
  active: [true, true, false],
  "consumers-paused": [false, true, true],
  "domains-paused": [true, true, true],
  foundation: [false, false, true],
});

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

export async function writeEvidence(outDir, filename, value) {
  if (!evidenceFilenamePattern.test(filename)) {
    throw new TypeError("evidence filename is invalid");
  }
  await mkdir(outDir, { mode: 0o700, recursive: true });
  const target = path.join(outDir, filename);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, stableJson(value), { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
