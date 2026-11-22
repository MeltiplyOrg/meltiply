import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { assertReleaseBound, readJsonFile, writeEvidence } from "./release-guard.mjs";
import { readBoundedJsonResponse } from "./release-http.mjs";
import {
  assertWorkerTraffic,
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

async function loadApiCandidateEvidence(outDir, spec) {
  const candidate = assertReleaseBound(
    await readJsonFile(candidatePath(outDir, "api"), "API candidate evidence"),
    "API candidate evidence",
    spec,
  );
  const secrets = assertReleaseBound(
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

function versionUrlOrigin(spec, versionId) {
  const origin = new URL(spec.api_workers_dev_url);
  return `https://${versionId.slice(0, 8)}-${origin.hostname}`;
}

export async function fetchHealth({
  expectedEnvironment,
  fetchImpl,
  origin,
  requestBudgetMs,
  legacyVersion,
}) {
  let response;
  try {
    response = await fetchImpl(new URL(`${origin}${healthPath}`), {
      headers: { Accept: "application/json" },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, requestBudgetMs))),
    });
  } catch (cause) {
    throw new Error("API health transport failed", { cause });
  }
  if (!response.ok) {
    throw new Error(`API health request failed with status ${response.status}`);
  }
  const body = await readBoundedJsonResponse(response, maximumResponseBytes, "API health response");
  const legacy =
    body !== null &&
    typeof body === "object" &&
    !Object.hasOwn(body, "contract_version") &&
    legacyVersion !== undefined &&
    body.version === legacyVersion;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    JSON.stringify(Object.keys(body).sort()) !==
      JSON.stringify(
        legacy
          ? ["environment", "status", "version"]
          : ["contract_version", "environment", "status", "version"],
      ) ||
    (!legacy &&
      (typeof body.contract_version !== "string" || body.contract_version.length === 0)) ||
    body.environment !== expectedEnvironment ||
    body.status !== "ok" ||
    typeof body.version !== "string" ||
    !gitShaPattern.test(body.version)
  ) {
    throw new TypeError(`API health response is not the ${expectedEnvironment} contract`);
  }
  return {
    contract_version: legacy ? null : body.contract_version,
    environment: body.environment,
    status: body.status,
    version: body.version,
  };
}

async function pollHealth({
  acceptedVersions,
  expectedEnvironment,
  fetchImpl = fetch,
  legacyVersion,
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
        legacyVersion,
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
      contract_version: result.health.contract_version,
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
  let previousVersionId;
  if (spec.deployment_mode === "bootstrap") {
    const deployment = assertReleaseBound(
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
    const rollout = assertReleaseBound(
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
      previousVersionId = previousVersion.version_id;
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
  assertWorkerTraffic(
    observedTraffic,
    expectedTraffic,
    "API deployment does not match the release traffic set",
  );

  const acceptedVersions = new Set([spec.git_sha]);
  if (previousSha !== undefined) acceptedVersions.add(previousSha);
  const result = await pollHealth({
    acceptedVersions,
    expectedEnvironment: spec.environment,
    fetchImpl,
    legacyVersion: previousSha !== spec.git_sha ? previousSha : undefined,
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
      contract_version: result.health.contract_version,
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
    ...(result.health.contract_version === null
      ? {
          previous_version: { version_id: previousVersionId, git_sha: previousSha },
        }
      : {}),
    traffic: observedTraffic,
    version_id: versionId,
    worker: "api",
  };
  await writeEvidence(outDir, filename, evidence);
  return evidence;
}
