import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { readBoundedJsonResponse } from "./release-http.mjs";
import { normalizeNeonDatabaseHostname, validateDatabaseEnvironment } from "./release-lib.mjs";

const apiBase = "https://console.neon.tech/api/v2";
const identifierPattern = /^[a-z0-9-]{1,60}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const maximumResponseBytes = 256 * 1024;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

/**
 * Validates that an identifier string matches the allowed alphanumeric slug pattern (`^[a-z0-9_-]+$`).
 *
 * @param {unknown} value - Identifier to test
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated identifier
 * @throws {TypeError} If value is not a string or fails the pattern check
 */
function identifier(value, name) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * Validates that a string is a valid RFC3339 timestamp with parseable epoch value.
 *
 * @param {unknown} value - Timestamp candidate string
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated RFC3339 timestamp string
 * @throws {TypeError} If value is not a string, fails RFC3339 regex, or cannot be parsed by Date
 */
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

/**
 * Validates Neon API credentials and ensures project and branch environment variables
 * match the designated target project and branch in the release specification.
 *
 * @param {Record<string, string | undefined>} environment - Process environment variables
 * @param {object} spec - Release specification object
 * @returns {{ branchId: string, projectId: string, token: string }} Validated Neon configuration parameters
 * @throws {TypeError} If API key is missing or project/branch variables do not match the release spec
 */
function protectedEnvironment(environment, spec) {
  const token = environment.NEON_API_KEY;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /[\u0000-\u0020\u007f]/.test(token)
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

/**
 * Performs an authenticated HTTP request against the Neon REST API with size-bounded JSON parsing.
 *
 * @param {object} params - Request options
 * @param {{ token: string }} params.environment - Object holding Neon API bearer token
 * @param {typeof fetch} params.fetchImpl - HTTP fetch implementation
 * @param {string} [params.method="GET"] - HTTP method
 * @param {string} params.pathname - API path to append to Neon base URL
 * @param {number} [params.requestTimeoutMs=15000] - Request timeout in milliseconds
 * @returns {Promise<any>} Parsed JSON response payload
 * @throws {Error} If HTTP response is not ok or exceeds maximum response size limit
 */
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

/**
 * Validates the schema and attributes of a Neon snapshot record.
 * Verifies ISO timestamps, identifier formats, and enforces that expiration follows creation.
 *
 * @param {unknown} input - Raw snapshot record
 * @param {object} [expected={}] - Optional map of expected property values
 * @returns {{ created_at: string, expires_at: string, id: string, name: string, source_branch_id: string }} Validated snapshot record
 * @throws {TypeError} If snapshot structure, fields, or constraints are invalid
 */
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

/**
 * Validates a list of Neon snapshots returned from the list snapshots endpoint.
 *
 * @param {unknown} input - Raw JSON response from Neon snapshots listing endpoint
 * @returns {Array<object>} Validated snapshot records array
 * @throws {TypeError} If response is not an object containing a snapshots array
 */
function parseSnapshotList(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.snapshots)) {
    throw new TypeError("Neon snapshot list response is invalid");
  }
  return input.snapshots.map((snapshot) => validateSnapshot(snapshot));
}

/**
 * Validates a single Neon operation payload against project scope and execution invariants.
 *
 * Ensures the operation record belongs to the expected project, has a valid UUID,
 * valid RFC 3339 timestamps, recognized status enumeration, and non-negative
 * duration and failure metrics. Enforces that operations with status "finished" report
 * zero failures.
 *
 * @param {unknown} input - Raw Neon operation object or envelope containing an operation field
 * @param {string} projectId - Expected Neon project identifier to enforce tenant boundary
 * @returns {{ id: string, status: string }} Normalized lowercase operation ID and status
 * @throws {TypeError} If structure is invalid or finished operation reports failures
 */
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

/**
 * Parses and validates the response from a Neon branch snapshot creation API call.
 *
 * Enforces exact response key containment (only "operations" and "snapshot"),
 * validates that at least one completion operation was scheduled, and verifies
 * that the returned snapshot matches the expected release snapshot name and source branch ID.
 *
 * @param {unknown} input - Decoded JSON payload from Neon snapshot creation endpoint
 * @param {{ branchId: string, name: string, projectId: string }} expected - Expected release metadata
 * @returns {{ operations: Array<{ id: string, status: string }>, snapshot: { created_at: string, expires_at: string, id: string, name: string, source_branch_id: string } }} Parsed operations and validated snapshot
 * @throws {TypeError} If response shape is invalid or missing required completion operations
 */
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

/**
 * Parses and validates the response from a Neon operation status polling endpoint.
 *
 * Ensures the response envelope contains exclusively a single "operation" property,
 * delegating field validation and project isolation enforcement to parseOperation.
 *
 * @param {unknown} input - Decoded JSON response from GET /projects/:id/operations/:operation_id
 * @param {string} projectId - Expected Neon project identifier
 * @returns {{ id: string, status: string }} Normalized operation ID and current execution status
 * @throws {TypeError} If envelope contains unexpected keys or is not an operation object
 */
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

/**
 * Queries Neon API for existing snapshots and retrieves one matching the release name.
 *
 * Enforces that at most one snapshot exists with the given release-scoped name.
 * If a matching snapshot is present, verifies that its source branch and expiration
 * timestamp exactly match the release specification to avoid ambiguity or reuse of conflicting state.
 *
 * @param {object} options - Snapshot search parameters
 * @param {string} options.branchId - Expected Neon source branch identifier
 * @param {{ token: string }} options.environment - Neon API authentication credentials
 * @param {string} options.expiresAt - Expected snapshot expiration timestamp
 * @param {typeof fetch} options.fetchImpl - HTTP client implementation
 * @param {string} options.name - Unique release snapshot name (e.g., meltiply-<release_id>)
 * @param {string} options.projectId - Neon project identifier
 * @returns {Promise<object|undefined>} Matching validated snapshot object, or undefined if none exists
 * @throws {TypeError} If duplicate snapshots exist or branch/expiry mismatch occurs
 */
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

/**
 * Validates Neon branch endpoints and verifies exact database URL hostname parity.
 *
 * Scans branch endpoints returned by the Neon control plane to ensure that exactly
 * one active (non-disabled) endpoint matches the configured database hostname for
 * the target project and branch. Computes an immutable SHA-256 digest of the host.
 *
 * @param {unknown} input - Raw endpoints response payload from Neon API
 * @param {{ branchId: string, environment: Record<string, string | undefined>, projectId: string }} expected - Target environment and branch context
 * @returns {{ hostDigest: string, id: string }} SHA-256 digest of verified hostname and validated endpoint identifier
 * @throws {TypeError} If response is malformed or database URL does not match exactly one enabled endpoint
 */
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

/**
 * Retrieves Neon branch endpoints via the control plane and verifies connection parity.
 *
 * Queries the Neon API for endpoints belonging to the specified project branch and
 * asserts that the release database connection string maps directly to a verified,
 * active branch endpoint.
 *
 * @param {object} options - Endpoint verification options
 * @param {Record<string, string | undefined>} options.environment - Process environment containing DATABASE_URL
 * @param {typeof fetch} options.fetchImpl - HTTP client implementation
 * @param {{ branchId: string, projectId: string, token: string }} options.neon - Protected Neon configuration
 * @returns {Promise<{ hostDigest: string, id: string }>} Validated endpoint ID and host digest
 */
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

/**
 * Polls asynchronous Neon operations until all complete successfully or timeout.
 *
 * Monitors long-running snapshot creation operations by polling Neon control-plane
 * endpoints with exponential/paced delays. Halts immediately on terminal failure statuses
 * (cancelled, error, failed, skipped) and bounds total waiting time to 15 minutes.
 *
 * @param {object} options - Operation polling options
 * @param {{ token: string }} options.environment - Protected Neon API credentials
 * @param {typeof fetch} options.fetchImpl - HTTP client implementation
 * @param {Array<{ id: string, status: string }>} options.operations - Operations to track
 * @param {(ms: number) => Promise<void>} options.pause - Pacing delay function
 * @param {string} options.projectId - Neon project identifier
 * @returns {Promise<void>} Resolves when all operations reach "finished" status
 * @throws {Error} If any operation fails or total execution exceeds the 15-minute deadline
 */
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

/**
 * Asserts structural and cryptographic validity of restore-point evidence.
 *
 * Validates that restore-point evidence conforms strictly to schema version 1,
 * matches the release specification (git SHA, release ID, plan digest, Neon project/branch),
 * verifies phase-scoped operator review records (plain JSON matching commit and
 * plan digest, not authenticated identities), confirms snapshot lifetime
 * invariants, checks the composite SHA-256 snapshot digest, and verifies endpoint hostname digest parity.
 *
 * @param {unknown} evidence - Raw restore-point evidence object to validate
 * @param {object} [context] - Expected context containing approvals, environment, planDigest, and spec
 * @returns {object} Validated immutable restore-point evidence object
 * @throws {TypeError} If schema fields are invalid, expired, or cryptographic digests mismatch
 */
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
    !/^[0-9a-f]{64}$/.test(evidence.snapshot_digest) ||
    !/^[0-9a-f]{64}$/.test(evidence.endpoint_host_digest)
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

/**
 * Guarantees a verified Neon database snapshot restore point prior to mutating releases.
 *
 * Verifies that the configured restore point expiration is between 7 and 30 days in the future,
 * validates database endpoint hostname parity against the reviewed Neon branch, checks for
 * existing local evidence or completed remote snapshots to support idempotent reruns, triggers
 * snapshot creation, polls completion operations to finish, and persists canonical evidence atomically.
 *
 * **Recovery sequencing**: Restoring a Neon snapshot rolls back the database but does **not**
 * undo content already published to social providers (Facebook, Instagram, TikTok, etc.).
 * Before restoring, the operator must:
 * 1. Pause Queue delivery and Automation cron triggers to stop new writes and publications.
 * 2. Inspect the recovery point to identify which publications and analytics completed
 *    after the snapshot timestamp — these will vanish from the local database but remain
 *    live on provider platforms.
 * 3. After restoring, reconcile external provider state: mark already-published content
 *    as delivered and replay or discard any partially-processed queue messages.
 *
 * @param {object} options - Restore point creation options
 * @param {object} options.approvals - Operator reviews bound to the release commit, phase, and plan digest.
 * @param {Record<string, string | undefined>} options.environment - Runtime environment with credentials
 * @param {typeof fetch} [options.fetchImpl=fetch] - HTTP client implementation
 * @param {() => number} [options.now] - Epoch millisecond timestamp provider
 * @param {string} options.outDir - Output directory for atomic evidence persistence
 * @param {(ms: number) => Promise<void>} [options.pause] - Pacing delay provider
 * @param {string} options.planDigest - SHA-256 digest of verified release plan
 * @param {object} options.spec - Verified release specification
 * @returns {Promise<object>} Validated restore-point evidence record
 * @throws {TypeError|Error} If lifetime is invalid, endpoint mismatches, snapshot fails, or evidence is corrupted
 */
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
  let snapshot = await listNamedSnapshot({
    branchId: neon.branchId,
    environment: neon,
    expiresAt: spec.restore_point_expires_at,
    fetchImpl,
    name,
    projectId: neon.projectId,
  });
  if (snapshot) {
    throw new Error("Neon release snapshot exists without completed local evidence");
  }
  if (!snapshot) {
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
    snapshot = parsed.snapshot;
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
  }

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

/**
 * Asserts that a valid, active restore-point evidence file exists before mutating operations.
 *
 * Loads and cryptographically validates the local restore-point evidence file against
 * the current release specification, plan digest, and database environment. Verifies that
 * the database snapshot has at least the minimum required lifetime remaining (default 7 days).
 *
 * @param {object} options - Restore point requirement options
 * @param {object} options.approvals - Validated operator review records, not identity authentication.
 * @param {Record<string, string | undefined>} options.environment - Runtime environment
 * @param {number} [options.minimumRemainingMs=604800000] - Minimum remaining milliseconds before expiry (7 days)
 * @param {() => number} [options.now] - Current time provider
 * @param {string} options.outDir - Directory containing restore-point-evidence.json
 * @param {string} options.planDigest - Release plan digest
 * @param {object} options.spec - Release specification
 * @returns {Promise<object>} Validated restore-point evidence record
 * @throws {TypeError} If evidence is missing, invalid, or has insufficient remaining lifetime
 */
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
