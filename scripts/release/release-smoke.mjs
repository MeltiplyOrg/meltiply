import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { readJsonFile, writeEvidence } from "./release-guard.mjs";
import { readBoundedJsonResponse } from "./release-http.mjs";
import {
  candidatePath,
  getWorkerTraffic,
  secretPath,
  validateWorkerVersionId,
  verifyWorkerVersion,
  workerConfigPath,
  workerVersionBindingSha,
} from "./release-worker.mjs";

const healthPath = "/api/v1/health";
const maximumResponseBytes = 8 * 1024;
const requestTimeoutMs = 10_000;
const smokeDeadlineMs = 120_000;
const smokePollIntervalMs = 2_000;
const smokePollAttempts = 60;
const gitShaPattern = /^[0-9a-f]{40}$/;

/**
 * Asserts that an evidence record binds the current release identity.
 *
 * @param {object} evidence - Parsed evidence record
 * @param {string} name - Evidence description for error reporting
 * @param {object} spec - Validated release specification
 * @returns {object} The validated evidence record
 * @throws {TypeError} If schema version, release ID, or Git SHA do not match
 */
function assertReleaseEvidence(evidence, name, spec) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.schema_version !== 1 ||
    evidence.release_id !== spec.release_id ||
    evidence.git_sha !== spec.git_sha
  ) {
    throw new TypeError(`${name} does not match the release`);
  }
  return evidence;
}

/**
 * Loads the API candidate and secret-injection evidence for the release.
 *
 * The deployable candidate is the secret-injected version: it is the version
 * promoted by activation and canary rollouts and the only version that can
 * satisfy deployed binding validation over HTTP.
 *
 * @param {string} outDir - Release evidence directory
 * @param {object} spec - Validated release specification
 * @returns {Promise<{ candidate: object, versionId: string }>} Bound candidate evidence and deployable version ID
 * @throws {TypeError} If evidence is missing, mismatched, or internally inconsistent
 */
async function loadApiCandidateEvidence(outDir, spec) {
  const candidate = assertReleaseEvidence(
    await readJsonFile(candidatePath(outDir, "api"), "API candidate evidence"),
    "API candidate evidence",
    spec,
  );
  const secrets = assertReleaseEvidence(
    await readJsonFile(secretPath(outDir, "api"), "API secret evidence"),
    "API secret evidence",
    spec,
  );
  const versionId = validateWorkerVersionId(secrets.version_id);
  const candidateVersionId = validateWorkerVersionId(candidate.version_id);
  if (secrets.based_on_version_id !== candidateVersionId) {
    throw new TypeError("API secret evidence is not based on the code candidate");
  }
  return { candidate, versionId };
}

/**
 * Builds the immutable Version URL origin for a Worker version.
 *
 * Cloudflare Version URLs use the first eight characters of the version UUID
 * as the hostname prefix on the Worker's workers.dev subdomain, matching the
 * URL Wrangler reports after `versions upload`. The subdomain is pinned by
 * the reviewed release input's api_workers_dev_url, matched against the IaC
 * API Worker name before CLI smoke begins.
 *
 * @param {object} spec - Validated release specification
 * @param {string} versionId - Worker version UUID
 * @returns {string} Absolute HTTPS origin for the immutable version
 * @throws {TypeError} If the configured origin is not the expected Worker subdomain
 */
function versionUrlOrigin(spec, versionId) {
  const origin = new URL(spec.api_workers_dev_url);
  return `https://${versionId.slice(0, 8)}-${origin.hostname}`;
}

/**
 * Performs one bounded GET against the public API health endpoint.
 *
 * Rejects redirects, non-200 statuses, non-JSON envelopes, and bodies with
 * unexpected keys. The health contract is exactly {environment, status,
 * version} so a successful response binds the serving code to a concrete
 * Git SHA without exposing internals.
 *
 * @param {object} params - Probe parameters
 * @param {string} params.expectedEnvironment - Selected release environment
 * @param {typeof fetch} params.fetchImpl - HTTP client implementation
 * @param {string} params.origin - Absolute HTTPS origin to probe
 * @param {number} params.requestBudgetMs - Maximum time allowed for the request
 * @returns {Promise<object>} Validated health payload
 * @throws {TypeError|Error} If the response is not an exact health success envelope
 */
export async function fetchHealth({ expectedEnvironment, fetchImpl, origin, requestBudgetMs }) {
  let response;
  try {
    response = await fetchImpl(new URL(`${origin}${healthPath}`), {
      headers: { Accept: "application/json" },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, requestBudgetMs))),
    });
  } catch (cause) {
    // Node fetch reports transport failures as TypeError too. Wrap only the
    // transport boundary so contract TypeErrors below remain terminal.
    throw new Error("API health transport failed", { cause });
  }
  if (!response.ok) {
    throw new Error(`API health request failed with status ${response.status}`);
  }
  const body = await readBoundedJsonResponse(response, maximumResponseBytes, "API health response");
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    JSON.stringify(Object.keys(body).sort()) !==
      JSON.stringify(["environment", "status", "version"]) ||
    body.environment !== expectedEnvironment ||
    body.status !== "ok" ||
    typeof body.version !== "string" ||
    !gitShaPattern.test(body.version)
  ) {
    throw new TypeError(`API health response is not the ${expectedEnvironment} contract`);
  }
  return {
    environment: body.environment,
    status: body.status,
    version: body.version,
  };
}

/**
 * Polls an API health endpoint until it reports an accepted Git SHA.
 *
 * Bounded by a monotonic deadline: every attempt is timeout-bounded and
 * transport failures are retried while budget remains. Envelope or version
 * mismatches throw TypeError, which is terminal — a healthy endpoint cannot
 * fix a wrong binding by retrying — while transport errors retry until the
 * deadline or attempt ceiling.
 *
 * @param {object} params - Polling parameters
 * @param {Set<string>} params.acceptedVersions - Git SHAs the endpoint may legitimately serve
 * @param {string} params.expectedEnvironment - Selected release environment
 * @param {typeof fetch} [params.fetchImpl=fetch] - HTTP client implementation
 * @param {number} [params.maximumElapsedMs=120000] - Hard deadline in milliseconds
 * @param {() => number} [params.now] - High-resolution timestamp provider
 * @param {string} params.origin - Absolute origin to poll
 * @param {(ms: number) => Promise<void>} [params.pause] - Delay between attempts
 * @param {number} [params.pollAttempts=60] - Maximum number of attempts
 * @param {number} [params.pollIntervalMs=2000] - Interval between attempts
 * @returns {Promise<{ attempts: number, health: object }>} Successful health payload and attempt count
 * @throws {TypeError|Error} If bounds are invalid, the version mismatches, or the deadline expires
 */
async function pollHealth({
  acceptedVersions,
  expectedEnvironment,
  fetchImpl = fetch,
  maximumElapsedMs = smokeDeadlineMs,
  now = () => performance.now(),
  origin,
  pause = (milliseconds) => delay(milliseconds),
  pollAttempts = smokePollAttempts,
  pollIntervalMs = smokePollIntervalMs,
}) {
  if (!Number.isInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 60) {
    throw new TypeError("smoke poll attempts must be between 1 and 60");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10_000) {
    throw new TypeError("smoke poll interval must be between 0 and 10000 ms");
  }
  if (!Number.isInteger(maximumElapsedMs) || maximumElapsedMs < 1 || maximumElapsedMs > 900_000) {
    throw new TypeError("smoke deadline must be between 1 and 900000 ms");
  }
  const deadline = now() + maximumElapsedMs;
  let failure;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const budget = Math.floor(deadline - now());
    if (budget < 1) break;
    try {
      const health = await fetchHealth({
        expectedEnvironment,
        fetchImpl,
        origin,
        requestBudgetMs: budget,
      });
      if (!acceptedVersions.has(health.version)) {
        throw new TypeError("API health serves a version outside the release traffic set");
      }
      return { attempts: attempt, health };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      failure = error;
    }
    const remaining = Math.floor(deadline - now());
    if (attempt < pollAttempts && remaining > 0) {
      await pause(Math.min(pollIntervalMs, remaining));
    }
  }
  const detail = failure ? `: ${failure.message}` : "";
  throw new Error(`API health did not reach the expected release state${detail}`);
}

/**
 * Re-verifies the deployable API candidate on the Cloudflare control plane.
 *
 * `versions view` re-asserts the release tag and the VERSION binding equal to
 * the release Git SHA, so smoke evidence binds an immutable version identity
 * rather than a mutable deployment pointer.
 *
 * @param {object} params - Verification parameters
 * @param {Record<string, string | undefined>} params.environment - Process environment
 * @param {string} params.outDir - Release output directory holding rendered configs
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess runner
 * @param {object} params.spec - Validated release specification
 * @param {string} params.versionId - Deployable secret-injected version ID
 * @returns {Promise<object>} Verified version details record
 */
async function verifyCandidateVersion({ environment, outDir, runCommand, spec, versionId }) {
  return verifyWorkerVersion({
    configPath: workerConfigPath(outDir, "api"),
    environment,
    gitSha: spec.git_sha,
    id: versionId,
    runCommand,
    tag: `${spec.release_id}-api-secrets`,
    worker: "api",
  });
}

/**
 * Asserts that control-plane traffic equals the expected deployment split.
 *
 * @param {Array<{ percentage: number, version_id: string }>} traffic - Observed traffic
 * @param {Array<{ percentage: number, version_id: string }>} expected - Expected traffic
 * @param {string} name - Context for error reporting
 * @throws {TypeError} If the observed split differs from the expected split
 */
function assertTrafficSplit(traffic, expected, name) {
  const normalized = [...expected].sort((left, right) =>
    left.version_id.localeCompare(right.version_id),
  );
  if (JSON.stringify(traffic) !== JSON.stringify(normalized)) {
    throw new TypeError(`${name} does not match the release traffic set`);
  }
}

/**
 * Probes the immutable API candidate version over HTTPS before promotion.
 *
 * Loads candidate and secret evidence, re-verifies the secrets version tag and
 * VERSION binding on the control plane, then polls the version's immutable
 * Version URL until `/api/v1/health` reports the release Git SHA. Version URLs
 * route only when the Worker enables preview URLs, so a Worker deployed with
 * previews disabled fails closed rather than passing smoke by another path.
 *
 * @param {object} params - Smoke parameters
 * @param {Record<string, string | undefined>} params.environment - Process environment
 * @param {typeof fetch} [params.fetchImpl=fetch] - HTTP client implementation
 * @param {string} params.outDir - Release output/evidence directory
 * @param {(ms: number) => Promise<void>} [params.pause] - Poll pacing provider
 * @param {number} [params.pollAttempts] - Maximum health poll attempts
 * @param {number} [params.pollIntervalMs] - Poll interval in milliseconds
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess runner
 * @param {object} params.spec - Validated release specification
 * @returns {Promise<object>} Immutable candidate smoke evidence record
 * @throws {TypeError|Error} If evidence mismatches, the version is unreachable, or health is wrong
 */
export async function smokeVersionCandidate({
  environment,
  fetchImpl = fetch,
  outDir,
  pause,
  pollAttempts,
  pollIntervalMs,
  runCommand,
  spec,
}) {
  const { candidate, versionId } = await loadApiCandidateEvidence(outDir, spec);
  await verifyCandidateVersion({
    environment,
    outDir,
    runCommand,
    spec,
    versionId,
  });
  const origin = versionUrlOrigin(spec, versionId);
  const result = await pollHealth({
    acceptedVersions: new Set([spec.git_sha]),
    expectedEnvironment: spec.environment,
    fetchImpl,
    origin,
    pause,
    pollAttempts,
    pollIntervalMs,
  });
  const evidence = {
    attempts: result.attempts,
    candidate_version_id: candidate.version_id,
    git_sha: spec.git_sha,
    health: {
      environment: result.health.environment,
      status: result.health.status,
      url: `${origin}${healthPath}`,
      version: result.health.version,
    },
    phase: "version",
    release_id: spec.release_id,
    schema_version: 1,
    status: "passed",
    version_id: versionId,
    worker: "api",
  };
  await writeEvidence(outDir, "smoke-version.json", evidence);
  return evidence;
}

/**
 * Probes the live API hostname against the release traffic split.
 *
 * For bootstrap, deployment evidence must prove the secrets version serves
 * 100% of traffic; for updates, the rollout evidence at the requested
 * percentage must equal the control-plane split between the secrets version
 * and the previously serving version. The health probe then asserts the
 * hostname serves only Git SHAs that the verified traffic split permits —
 * fail-closed against a third version or a stale release.
 *
 * @param {object} params - Smoke parameters
 * @param {Record<string, string | undefined>} params.environment - Process environment
 * @param {typeof fetch} [params.fetchImpl=fetch] - HTTP client implementation
 * @param {string} params.outDir - Release output/evidence directory
 * @param {(ms: number) => Promise<void>} [params.pause] - Poll pacing provider
 * @param {number | undefined} params.percentage - Rollout percentage for update releases
 * @param {number} [params.pollAttempts] - Maximum health poll attempts
 * @param {number} [params.pollIntervalMs] - Poll interval in milliseconds
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess runner
 * @param {object} params.spec - Validated release specification
 * @returns {Promise<object>} Live smoke evidence record
 * @throws {TypeError|Error} If mode/percentage is invalid, traffic mismatches, or health is outside the release set
 */
export async function smokeLiveApi({
  environment,
  fetchImpl = fetch,
  outDir,
  pause,
  percentage,
  pollAttempts,
  pollIntervalMs,
  runCommand,
  spec,
}) {
  if (spec.deployment_mode === "update") {
    if (![5, 25, 50, 100].includes(percentage)) {
      throw new TypeError("update live smoke requires --percentage 5, 25, 50, or 100");
    }
  } else if (percentage !== undefined) {
    throw new TypeError("bootstrap live smoke does not accept --percentage");
  }

  const { versionId } = await loadApiCandidateEvidence(outDir, spec);
  await verifyCandidateVersion({
    environment,
    outDir,
    runCommand,
    spec,
    versionId,
  });

  const configPath = workerConfigPath(outDir, "api");
  let expectedTraffic;
  let previousSha;
  if (spec.deployment_mode === "bootstrap") {
    const deployment = assertReleaseEvidence(
      await readJsonFile(
        path.join(outDir, "worker-api-deployment.json"),
        "API deployment evidence",
      ),
      "API deployment evidence",
      spec,
    );
    if (deployment.version_id !== versionId) {
      throw new TypeError("API deployment evidence does not match the secrets version");
    }
    expectedTraffic = [{ percentage: 100, version_id: versionId }];
  } else {
    const rollout = assertReleaseEvidence(
      await readJsonFile(
        path.join(outDir, `api-rollout-${percentage}.json`),
        "API rollout evidence",
      ),
      "API rollout evidence",
      spec,
    );
    if (rollout.version_id !== versionId || rollout.percentage !== percentage) {
      throw new TypeError("API rollout evidence does not match the requested percentage");
    }
    expectedTraffic = rollout.traffic;
    if (percentage !== 100) {
      const previousVersion = expectedTraffic.find((entry) => entry.version_id !== versionId);
      if (!previousVersion) {
        throw new TypeError("partial rollout evidence lacks the previous version");
      }
      previousSha = await workerVersionBindingSha({
        configPath,
        environment,
        id: previousVersion.version_id,
        runCommand,
        worker: "api",
      });
    }
  }

  const observedTraffic = await getWorkerTraffic({
    configPath,
    environment,
    runCommand,
  });
  assertTrafficSplit(observedTraffic, expectedTraffic, "API deployment");

  const acceptedVersions = new Set([spec.git_sha]);
  if (previousSha !== undefined) acceptedVersions.add(previousSha);
  const result = await pollHealth({
    acceptedVersions,
    expectedEnvironment: spec.environment,
    fetchImpl,
    origin: spec.app_url,
    pause,
    pollAttempts,
    pollIntervalMs,
  });

  const filename =
    spec.deployment_mode === "bootstrap" ? "smoke-live.json" : `smoke-live-${percentage}.json`;
  const evidence = {
    attempts: result.attempts,
    git_sha: spec.git_sha,
    health: {
      environment: result.health.environment,
      status: result.health.status,
      url: `${spec.app_url}${healthPath}`,
      version: result.health.version,
    },
    percentage: spec.deployment_mode === "bootstrap" ? 100 : percentage,
    phase: "live",
    release_id: spec.release_id,
    schema_version: 1,
    status: "passed",
    traffic: observedTraffic,
    version_id: versionId,
    worker: "api",
  };
  await writeEvidence(outDir, filename, evidence);
  return evidence;
}
