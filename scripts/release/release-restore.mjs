import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { readBoundedJsonResponse } from "./release-http.mjs";
import { normalizeNeonDatabaseHostname, validateDatabaseEnvironment } from "./release-lib.mjs";

const unsafeEnvironmentValuePattern = /[\u0000-\u0020\u007f]/;
const sha256Pattern = /^[0-9a-f]{64}$/;

const apiBase = "https://console.neon.tech/api/v2";
const identifierPattern = /^[a-z0-9-]{1,60}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const maximumResponseBytes = 256 * 1024;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

function identifier(value, name) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value, name) {
  if (
    typeof value !== "string" ||
    !rfc3339Pattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function protectedEnvironment(environment, spec) {
  const token = environment.NEON_API_KEY;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    token.trim() !== token ||
    unsafeEnvironmentValuePattern.test(token)
  ) {
    throw new TypeError("NEON_API_KEY is required for restore-point creation");
  }
  const branchId = identifier(environment.MELTIPLY_NEON_BRANCH_ID, "MELTIPLY_NEON_BRANCH_ID");
  const projectId = identifier(environment.MELTIPLY_NEON_PROJECT_ID, "MELTIPLY_NEON_PROJECT_ID");
  if (branchId !== spec.neon_branch_id || projectId !== spec.neon_project_id) {
    throw new TypeError("protected Neon project/branch do not match the reviewed release");
  }
  return {
    branchId,
    projectId,
    token,
  };
}

async function neonRequest({
  environment,
  fetchImpl,
  method = "GET",
  pathname,
  requestTimeoutMs = 15_000,
}) {
  const response = await fetchImpl(new URL(`${apiBase}${pathname}`), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${environment.token}`,
    },
    method,
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Neon API request failed with status ${response.status}`);
  }
  return readBoundedJsonResponse(response, maximumResponseBytes, "Neon API response");
}

function validateSnapshot(input, expected = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Neon snapshot must be an object");
  }
  const snapshot = {
    created_at: timestamp(input.created_at, "Neon snapshot created_at"),
    expires_at: timestamp(input.expires_at, "Neon snapshot expires_at"),
    id: identifier(input.id, "Neon snapshot id"),
    name:
      typeof input.name === "string" && input.name.length > 0 && input.name.length <= 128
        ? input.name
        : (() => {
            throw new TypeError("Neon snapshot name is invalid");
          })(),
    source_branch_id: identifier(input.source_branch_id, "Neon snapshot source_branch_id"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (snapshot[key] !== value) {
      throw new TypeError(`Neon snapshot ${key} does not match the release`);
    }
  }
  if (Date.parse(snapshot.expires_at) <= Date.parse(snapshot.created_at)) {
    throw new TypeError("Neon snapshot expiry must follow creation");
  }
  return snapshot;
}

function parseSnapshotList(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.snapshots)) {
    throw new TypeError("Neon snapshot list response is invalid");
  }
  return input.snapshots.map((snapshot) => validateSnapshot(snapshot));
}

function parseOperation(input, projectId) {
  const operation = input?.operation ?? input;
  if (
    !operation ||
    typeof operation !== "object" ||
    !uuidPattern.test(operation.id) ||
    operation.project_id !== projectId ||
    typeof operation.action !== "string" ||
    operation.action.length === 0 ||
    !Number.isInteger(operation.failures_count) ||
    operation.failures_count < 0 ||
    !Number.isInteger(operation.total_duration_ms) ||
    operation.total_duration_ms < 0 ||
    !rfc3339Pattern.test(operation.created_at) ||
    !rfc3339Pattern.test(operation.updated_at) ||
    !new Set([
      "cancelled",
      "cancelling",
      "error",
      "failed",
      "finished",
      "running",
      "scheduling",
      "skipped",
    ]).has(operation.status)
  ) {
    throw new TypeError("Neon operation response is invalid");
  }
  if (operation.status === "finished" && operation.failures_count !== 0) {
    throw new TypeError("Neon finished operation reports failures");
  }
  return { id: operation.id.toLowerCase(), status: operation.status };
}

export function parseCreateSnapshotResponse(input, expected) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Neon snapshot response must be an object");
  }
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["operations", "snapshot"])) {
    throw new TypeError("Neon snapshot response must contain only snapshot and operations");
  }
  if (!Array.isArray(input.operations)) {
    throw new TypeError("Neon snapshot response operations are invalid");
  }
  if (input.operations.length === 0) {
    throw new TypeError("Neon snapshot response has no completion operation");
  }
  return {
    operations: input.operations.map((operation) => parseOperation(operation, expected.projectId)),
    snapshot: validateSnapshot(input.snapshot, {
      name: expected.name,
      source_branch_id: expected.branchId,
    }),
  };
}

function parseOperationResponse(input, projectId) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    JSON.stringify(Object.keys(input)) !== JSON.stringify(["operation"])
  ) {
    throw new TypeError("Neon operation response must contain one operation");
  }
  return parseOperation(input.operation, projectId);
}

async function listNamedSnapshot({ branchId, environment, expiresAt, fetchImpl, name, projectId }) {
  const response = await neonRequest({
    environment,
    fetchImpl,
    pathname: `/projects/${encodeURIComponent(projectId)}/snapshots`,
  });
  const matches = parseSnapshotList(response).filter((snapshot) => snapshot.name === name);
  if (matches.length > 1) {
    throw new TypeError("Neon returned duplicate release snapshots");
  }
  if (matches.length === 1 && matches[0].source_branch_id !== branchId) {
    throw new TypeError("Neon release snapshot belongs to another branch");
  }
  if (matches.length === 1 && matches[0].expires_at !== expiresAt) {
    if (Date.parse(matches[0].expires_at) !== Date.parse(expiresAt)) {
      throw new TypeError("Neon release snapshot expiry does not match the release");
    }
  }
  return matches[0];
}

export function parseEndpointResponse(input, expected) {
  if (!input || typeof input !== "object" || !Array.isArray(input.endpoints)) {
    throw new TypeError("Neon endpoint response is invalid");
  }
  const databaseHostname = normalizeNeonDatabaseHostname(
    new URL(validateDatabaseEnvironment(expected.environment)).hostname,
  );
  const matches = input.endpoints.filter((endpoint) => {
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      endpoint.project_id !== expected.projectId ||
      endpoint.branch_id !== expected.branchId ||
      endpoint.disabled !== false
    ) {
      return false;
    }
    try {
      return normalizeNeonDatabaseHostname(endpoint.host) === databaseHostname;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new TypeError("database URL must match one enabled endpoint on the reviewed Neon branch");
  }
  return {
    hostDigest: sha256(databaseHostname),
    id: identifier(matches[0].id, "Neon endpoint id"),
  };
}

async function verifyDatabaseEndpoint({ environment, fetchImpl, neon }) {
  return parseEndpointResponse(
    await neonRequest({
      environment: neon,
      fetchImpl,
      pathname: `/projects/${encodeURIComponent(neon.projectId)}/branches/${encodeURIComponent(neon.branchId)}/endpoints`,
    }),
    {
      branchId: neon.branchId,
      environment,
      projectId: neon.projectId,
    },
  );
}

async function waitForOperations({ environment, fetchImpl, operations, pause, projectId }) {
  const pending = operations;
  const deadline = performance.now() + 900_000;
  for (const initial of pending) {
    let operation = initial;
    while (operation.status !== "finished") {
      if (new Set(["cancelled", "error", "failed", "skipped"]).has(operation.status)) {
        throw new Error("Neon snapshot operation failed");
      }
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new Error("Neon snapshot operation timed out");
      await pause(Math.min(5_000, remaining));
      const requestBudget = Math.floor(deadline - performance.now());
      if (requestBudget < 1) {
        throw new Error("Neon snapshot operation timed out");
      }
      operation = parseOperationResponse(
        await neonRequest({
          environment,
          fetchImpl,
          pathname: `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operation.id)}`,
          requestTimeoutMs: Math.min(15_000, requestBudget),
        }),
        projectId,
      );
    }
  }
}

function validateRestorePointEvidence(evidence, { approvals, environment, planDigest, spec } = {}) {
  const expectedKeys = [
    "approvals",
    "created_at",
    "expires_at",
    "endpoint_host_digest",
    "endpoint_id",
    "git_sha",
    "plan_digest",
    "project_id",
    "provider",
    "release_id",
    "schema_version",
    "snapshot_digest",
    "snapshot_id",
    "snapshot_name",
    "source_branch_id",
    "status",
  ];
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.schema_version !== 1 ||
    evidence.provider !== "neon" ||
    evidence.status !== "ready" ||
    evidence.git_sha !== spec.git_sha ||
    evidence.release_id !== spec.release_id ||
    evidence.plan_digest !== planDigest ||
    evidence.project_id !== spec.neon_project_id ||
    evidence.source_branch_id !== spec.neon_branch_id ||
    Date.parse(evidence.expires_at) !== Date.parse(spec.restore_point_expires_at) ||
    evidence.snapshot_name !== `meltiply-${spec.release_id}` ||
    JSON.stringify(evidence.approvals) !== JSON.stringify(approvals)
  ) {
    throw new TypeError("restore-point evidence does not match the release");
  }
  if (JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys.sort())) {
    throw new TypeError("restore-point evidence fields are invalid");
  }
  identifier(evidence.project_id, "restore-point project_id");
  identifier(evidence.source_branch_id, "restore-point source_branch_id");
  identifier(evidence.snapshot_id, "restore-point snapshot_id");
  identifier(evidence.endpoint_id, "restore-point endpoint_id");
  timestamp(evidence.created_at, "restore-point created_at");
  timestamp(evidence.expires_at, "restore-point expires_at");
  if (
    typeof evidence.snapshot_name !== "string" ||
    evidence.snapshot_name.length === 0 ||
    evidence.snapshot_name.length > 128
  ) {
    throw new TypeError("restore-point snapshot_name is invalid");
  }
  if (
    !sha256Pattern.test(evidence.snapshot_digest) ||
    !sha256Pattern.test(evidence.endpoint_host_digest)
  ) {
    throw new TypeError("restore-point snapshot_digest is invalid");
  }
  if (Date.parse(evidence.created_at) >= Date.parse(evidence.expires_at)) {
    throw new TypeError("restore-point evidence expiry must follow creation");
  }
  const expectedDigest = sha256(
    [
      evidence.snapshot_id,
      evidence.snapshot_name,
      evidence.source_branch_id,
      evidence.created_at,
      evidence.expires_at,
    ].join("\0"),
  );
  if (evidence.snapshot_digest !== expectedDigest) {
    throw new TypeError("restore-point snapshot_digest does not match evidence");
  }
  const databaseHostname = normalizeNeonDatabaseHostname(
    new URL(validateDatabaseEnvironment(environment)).hostname,
  );
  if (evidence.endpoint_host_digest !== sha256(databaseHostname)) {
    throw new TypeError("restore-point endpoint does not match the system database URL");
  }
  return evidence;
}

export async function createRestorePoint({
  approvals,
  environment,
  fetchImpl = fetch,
  now = () => Date.now(),
  outDir,
  pause = (milliseconds) => delay(milliseconds),
  planDigest,
  spec,
}) {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) throw new TypeError("release time is invalid");
  const expiryTime = Date.parse(spec.restore_point_expires_at);
  const lifetime = expiryTime - currentTime;
  if (lifetime < sevenDaysMs || lifetime > thirtyDaysMs) {
    throw new TypeError("restore_point_expires_at must be 7 to 30 days in the future");
  }
  const neon = protectedEnvironment(environment, spec);
  const endpoint = await verifyDatabaseEndpoint({
    environment,
    fetchImpl,
    neon,
  });
  const name = `meltiply-${spec.release_id}`;
  try {
    return validateRestorePointEvidence(
      await readJsonFile(
        path.join(outDir, "restore-point-evidence.json"),
        "restore-point evidence",
      ),
      { approvals, environment, planDigest, spec },
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existingSnapshot = await listNamedSnapshot({
    branchId: neon.branchId,
    environment: neon,
    expiresAt: spec.restore_point_expires_at,
    fetchImpl,
    name,
    projectId: neon.projectId,
  });
  if (existingSnapshot) {
    throw new Error("Neon release snapshot exists without completed local evidence");
  }
  const snapshotEndpoint = new URL(
    `${apiBase}/projects/${encodeURIComponent(neon.projectId)}/branches/${encodeURIComponent(neon.branchId)}/snapshot`,
  );
  snapshotEndpoint.searchParams.set("name", name);
  snapshotEndpoint.searchParams.set("expires_at", spec.restore_point_expires_at);
  const response = await fetchImpl(snapshotEndpoint, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${neon.token}`,
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Neon snapshot creation failed with status ${response.status}`);
  }
  const created = await readBoundedJsonResponse(
    response,
    maximumResponseBytes,
    "Neon snapshot response",
  );
  const parsed = parseCreateSnapshotResponse(created, {
    branchId: neon.branchId,
    name,
    projectId: neon.projectId,
  });
  const snapshot = parsed.snapshot;
  if (Date.parse(snapshot.expires_at) !== Date.parse(spec.restore_point_expires_at)) {
    throw new TypeError("Neon snapshot expiry does not match the release");
  }
  await waitForOperations({
    environment: neon,
    fetchImpl,
    operations: parsed.operations,
    pause,
    projectId: neon.projectId,
  });

  const evidence = {
    approvals,
    created_at: snapshot.created_at,
    expires_at: snapshot.expires_at,
    endpoint_host_digest: endpoint.hostDigest,
    endpoint_id: endpoint.id,
    git_sha: spec.git_sha,
    plan_digest: planDigest,
    project_id: neon.projectId,
    provider: "neon",
    release_id: spec.release_id,
    schema_version: 1,
    snapshot_digest: sha256(
      [
        snapshot.id,
        snapshot.name,
        snapshot.source_branch_id,
        snapshot.created_at,
        snapshot.expires_at,
      ].join("\0"),
    ),
    snapshot_id: snapshot.id,
    snapshot_name: snapshot.name,
    source_branch_id: snapshot.source_branch_id,
    status: "ready",
  };
  validateRestorePointEvidence(evidence, {
    approvals,
    environment,
    planDigest,
    spec,
  });
  await writeEvidence(outDir, "restore-point-evidence.json", evidence);
  return evidence;
}

export async function requireRestorePoint({
  approvals,
  environment,
  minimumRemainingMs = sevenDaysMs,
  now = () => Date.now(),
  outDir,
  planDigest,
  spec,
}) {
  const evidence = validateRestorePointEvidence(
    await readJsonFile(path.join(outDir, "restore-point-evidence.json"), "restore-point evidence"),
    { approvals, environment, planDigest, spec },
  );
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("release time is invalid");
  }
  if (Date.parse(evidence.expires_at) - currentTime < minimumRemainingMs) {
    throw new TypeError("restore-point evidence has less than seven days remaining");
  }
  return evidence;
}
