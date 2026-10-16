import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readBoundedJsonResponse } from "../release/release-http.mjs";

const MAXIMUM_API_RESPONSE_BYTES = 1024 * 1024;
const circleApiBase = "https://circleci.com/api/v2";
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const allowedApprovalNames = new Set([
  "staging-foundation-approval",
  "staging-traffic-approval",
  "staging-queue-resume-approval",
]);
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Retrieves all jobs for a CircleCI workflow with bounded pagination and size limits.
 * Required during protected staging releases to discover approval hold jobs and verify
 * their execution state against CircleCI v2 API before mutating infrastructure.
 *
 * @param {object} input - Input parameters
 * @param {typeof fetch} input.fetchImpl - HTTP fetch implementation
 * @param {string} input.token - CircleCI API authentication token
 * @param {string} input.workflowId - CircleCI workflow UUID
 * @returns {Promise<Array<object>>} Full list of workflow job records
 * @throws {Error} If workflow ID is not a UUID, token is missing, request fails, or pagination exceeds 100 pages
 */
export async function readWorkflowJobs({ fetchImpl, token, workflowId }) {
  if (!identifierPattern.test(workflowId)) {
    throw new Error("CircleCI workflow ID must be a UUID");
  }
  if (!token) throw new Error("CIRCLE_TOKEN is required");

  const jobs = [];
  const seenPageTokens = new Set();
  let pageToken;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > 100) {
      throw new Error("CircleCI workflow jobs pagination exceeded 100 pages");
    }
    const url = new URL(`${circleApiBase}/workflow/${workflowId}/job`);
    if (pageToken) url.searchParams.set("page-token", pageToken);
    const response = await fetchImpl(url, {
      headers: { "Circle-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`CircleCI workflow jobs request failed (${response.status})`);
    }
    const page = await readBoundedJsonResponse(
      response,
      MAXIMUM_API_RESPONSE_BYTES,
      "CircleCI workflow jobs response",
    );
    if (!Array.isArray(page.items)) {
      throw new Error("CircleCI workflow jobs response has no items array");
    }
    jobs.push(...page.items);
    pageToken = page.next_page_token || undefined;
    if (pageToken) {
      if (typeof pageToken !== "string" || pageToken.length > 1024) {
        throw new Error("CircleCI workflow jobs returned an invalid page token");
      }
      if (seenPageTokens.has(pageToken)) {
        throw new Error("CircleCI workflow jobs returned a repeated page token");
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);

  return jobs;
}

/**
 * Validates a successful CircleCI approval hold and extracts immutable evidence bound to the commit and plan.
 * Enforces cryptographic and identity invariants (UUID IDs, 40-char SHA, 64-char plan digest, approved hold names)
 * to ensure that only authenticated human approvals for the exact reviewed plan can authorize mutating release operations.
 *
 * @param {Array<object>} jobs - Job records returned by readWorkflowJobs
 * @param {string} workflowId - CircleCI workflow UUID
 * @param {string} pipelineSha - 40-character Git commit SHA of the release
 * @param {string} planDigest - 64-character SHA-256 hash of the reviewed OpenTofu plan
 * @param {string} approvalName - Name of the approved staging hold job
 * @returns {object} Verified approval evidence record matching schema version 1
 * @throws {Error} If identifiers, SHA, or plan digest are invalid, approval name is disallowed, or job status is not success
 */
export function approvalEvidence(jobs, workflowId, pipelineSha, planDigest, approvalName) {
  if (!identifierPattern.test(workflowId)) {
    throw new Error("CircleCI workflow ID must be a UUID");
  }
  if (!shaPattern.test(pipelineSha)) {
    throw new Error("CircleCI pipeline SHA must contain exactly 40 hex characters");
  }
  if (!digestPattern.test(planDigest)) {
    throw new Error("plan digest must contain exactly 64 lowercase hex characters");
  }
  if (!allowedApprovalNames.has(approvalName)) {
    throw new Error("approval job name is not an allowed staging hold");
  }
  const matches = jobs.filter((job) => job.name === approvalName && job.type === "approval");
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${approvalName} approval job, found ${matches.length}`);
  }

  const [job] = matches;
  if (job.status !== "success") {
    throw new Error(`${approvalName} approval status must be success, got ${String(job.status)}`);
  }
  if (!identifierPattern.test(job.id ?? "")) {
    throw new Error(`${approvalName} approval job has no valid job ID`);
  }
  if (!identifierPattern.test(job.approved_by ?? "")) {
    throw new Error(`${approvalName} approval job has no valid approved_by ID`);
  }
  if (!rfc3339Pattern.test(job.stopped_at ?? "") || Number.isNaN(Date.parse(job.stopped_at))) {
    throw new Error(`${approvalName} approval job has no valid completion time`);
  }

  return {
    schema_version: 1,
    workflow_id: workflowId,
    pipeline_sha: pipelineSha,
    plan_digest: planDigest,
    approval_job: {
      id: job.id,
      name: job.name,
      status: job.status,
      approved_by: job.approved_by,
    },
  };
}

/**
 * CLI entrypoint for recording verified CircleCI approval evidence.
 * Reads environment credentials and pipeline context, validates the specified approval hold against
 * the workflow API, and persists evidence JSON with restrictive file permissions (mode 0o600).
 *
 * @returns {Promise<void>}
 * @throws {Error} If arguments or environment variables are missing, or verification fails
 */
async function main() {
  const [approvalName, planDigest, outputPath, ...extra] = process.argv.slice(2);
  if (!approvalName || !planDigest || !outputPath || extra.length > 0) {
    throw new Error(
      "usage: node scripts/ci/circleci-approval.mjs <approval-job-name> <plan-digest> <output.json>",
    );
  }

  const workflowId = process.env.CIRCLE_WORKFLOW_ID ?? "";
  const jobs = await readWorkflowJobs({
    fetchImpl: fetch,
    token: process.env.CIRCLE_TOKEN ?? "",
    workflowId,
  });
  const evidence = approvalEvidence(
    jobs,
    workflowId,
    process.env.CIRCLE_SHA1 ?? "",
    planDigest,
    approvalName,
  );
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Recorded verified ${approvalName} approval metadata.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
