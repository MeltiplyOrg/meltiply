import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { readBoundedResponseBody } from "./release-http.mjs";
import { releaseInternals } from "./release-lib.mjs";

const phaseNames = new Set(["cron-activate", "cron-pause"]);
const maximumResponseBytes = 64 * 1024;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Asserts that a value is a plain non-null, non-array object record.
 *
 * @param {unknown} value - Value to validate
 * @param {string} name - Contextual label for error messages
 * @returns {object} Validated plain object
 * @throws {TypeError} If value is null, an array, or not an object
 */
function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Asserts that an object contains only keys belonging to an allowed set.
 *
 * @param {object} value - Object to inspect
 * @param {Set<string>} allowed - Set of recognized key names
 * @param {string} name - Contextual label for error messages
 * @returns {void}
 * @throws {TypeError} If any unknown key is present
 */
function knownKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${name} has unknown keys: ${unknown.join(", ")}`);
  }
}

/**
 * Validates, normalizes, and sorts an array of cron schedule pattern strings.
 * Enforces maximum count (16), string length (1-256), printable characters, and unique entries.
 *
 * @param {unknown} value - Candidate array of cron schedule strings
 * @param {string} name - Contextual label for error reporting
 * @returns {Array<string>} Sorted, deduplicated array of cron expressions
 * @throws {TypeError} If validation constraints are breached
 */
function cronSet(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > 16) throw new TypeError(`${name} has too many schedules`);
  const schedules = value.map((schedule, index) => {
    if (
      typeof schedule !== "string" ||
      schedule.length === 0 ||
      schedule.length > 256 ||
      schedule.trim() !== schedule ||
      /[\u0000-\u001f\u007f]/.test(schedule)
    ) {
      throw new TypeError(`${name}[${index}] is invalid`);
    }
    return schedule;
  });
  const unique = [...new Set(schedules)].sort();
  if (unique.length !== schedules.length) {
    throw new TypeError(`${name} contains duplicate schedules`);
  }
  return unique;
}

/**
 * Computes the canonical SHA-256 digest of a validated cron schedule set.
 *
 * @param {Array<string>} schedules - Cron schedule expressions
 * @returns {string} Hexadecimal SHA-256 hash digest
 */
export function scheduleSetDigest(schedules) {
  return sha256(releaseInternals.json(cronSet(schedules, "Cron schedules")));
}

/**
 * Parses and validates the Cloudflare Workers script schedules API response.
 * Enforces strict JSON shape, RFC3339 timestamps for creation and modification,
 * and extracts normalized cron expressions.
 *
 * @param {string} source - Raw API response body string
 * @returns {Array<string>} Sorted array of normalized cron expressions
 * @throws {TypeError} If JSON parsing fails or envelope schema is violated
 */
export function parseScheduleResponse(source) {
  let response;
  try {
    response = JSON.parse(source);
  } catch {
    throw new TypeError("Cloudflare schedules response must be valid JSON");
  }
  plainObject(response, "Cloudflare schedules response");
  knownKeys(
    response,
    new Set(["errors", "messages", "result", "success"]),
    "Cloudflare schedules response",
  );
  const result = plainObject(response.result, "Cloudflare schedules response result");
  knownKeys(result, new Set(["schedules"]), "Cloudflare schedules response result");
  if (response.success !== true || !Array.isArray(result.schedules)) {
    throw new TypeError("Cloudflare schedules response is unsuccessful");
  }
  return cronSet(
    result.schedules.map((entry, index) => {
      const schedule = plainObject(
        entry,
        `Cloudflare schedules response result.schedules[${index}]`,
      );
      knownKeys(
        schedule,
        new Set(["created_on", "cron", "modified_on"]),
        `Cloudflare schedules response result.schedules[${index}]`,
      );
      for (const field of ["created_on", "modified_on"]) {
        if (
          field in schedule &&
          (typeof schedule[field] !== "string" || !rfc3339Pattern.test(schedule[field]))
        ) {
          throw new TypeError(
            `Cloudflare schedules response result.schedules[${index}].${field} is invalid`,
          );
        }
      }
      return schedule.cron;
    }),
    "Cloudflare schedules response",
  );
}

/**
 * Extracts and validates the Cloudflare API bearer token from the environment.
 * Ensures the token satisfies length and ASCII character invariants.
 *
 * @param {Record<string, string | undefined>} environment - Environment variables
 * @returns {string} Validated bearer token
 * @throws {TypeError} If token is missing, too short, too long, or contains control characters
 */
function apiToken(environment) {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new TypeError("CLOUDFLARE_API_TOKEN is required for Cron proof");
  }
  return token;
}

/**
 * Fetches the active schedule set for a Worker script directly from the Cloudflare REST API.
 * Supports 404 tolerance when bootstrapping a brand new Worker (`allowMissingWorker`).
 *
 * @param {object} params - Request parameters
 * @param {boolean} params.allowMissingWorker - Whether to treat 404 as an empty schedule set
 * @param {Record<string, string | undefined>} params.environment - Environment variables containing API token
 * @param {typeof fetch} params.fetchImpl - HTTP fetch implementation
 * @param {number} params.requestTimeoutMs - Timeout in milliseconds for the request
 * @param {object} params.spec - Release specification object
 * @param {string} params.workerName - Name of the Cloudflare Worker script
 * @returns {Promise<Array<string>>} Sorted array of active cron schedule strings
 * @throws {Error} If API request fails or returns an unhandled HTTP status
 */
async function fetchScheduleSet({
  allowMissingWorker,
  environment,
  fetchImpl,
  requestTimeoutMs,
  spec,
  workerName,
}) {
  const accountId = spec.runtime.r2_account_id;
  const endpoint = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
  );
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: `Bearer ${apiToken(environment)}` },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 404 && allowMissingWorker) return [];
  if (!response.ok) {
    throw new Error(`Cloudflare schedules request failed with status ${response.status}`);
  }
  const source = await readBoundedResponseBody(
    response,
    maximumResponseBytes,
    "Cloudflare schedules response",
  );
  return parseScheduleResponse(source);
}

/**
 * Polls the Cloudflare control-plane until the observed cron schedule set matches the expected set.
 * Enforces a monotonic 15-minute deadline (900,000 ms) and up to 180 attempts to confirm
 * triggers have successfully activated or paused across Cloudflare's edge.
 *
 * @param {object} params - Polling options
 * @param {boolean} [params.allowMissingWorker=false] - Whether 404 is allowed during bootstrap
 * @param {Record<string, string | undefined>} params.environment - Environment variables
 * @param {Array<string>} params.expected - Array of expected cron schedule expressions
 * @param {typeof fetch} [params.fetchImpl=fetch] - HTTP fetch implementation
 * @param {number} [params.maximumElapsedMs=900000] - Hard deadline in milliseconds
 * @param {() => number} [params.now] - High-resolution timestamp provider
 * @param {(ms: number) => Promise<void>} [params.pause] - Delay function
 * @param {number} [params.pollAttempts=180] - Maximum number of poll attempts
 * @param {number} [params.pollIntervalMs=5000] - Interval between attempts in milliseconds
 * @param {object} params.spec - Release specification object
 * @param {string} params.workerName - Name of the Worker script
 * @returns {Promise<number>} Attempt number on which the expected state was confirmed
 * @throws {Error} If polling times out before reaching the expected schedule set
 * @throws {TypeError} If polling bounds or expected schedules are invalid
 */
export async function pollScheduleSet({
  allowMissingWorker = false,
  environment,
  expected,
  fetchImpl = fetch,
  maximumElapsedMs = 900_000,
  now = () => performance.now(),
  pause = (milliseconds) => delay(milliseconds),
  pollAttempts = 180,
  pollIntervalMs = 5_000,
  spec,
  workerName,
}) {
  const expectedSet = cronSet(expected, "expected Cron schedules");
  if (!Number.isInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 180) {
    throw new TypeError("Cron poll attempts must be between 1 and 180");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000) {
    throw new TypeError("Cron poll interval must be between 0 and 5000 ms");
  }
  if (!Number.isInteger(maximumElapsedMs) || maximumElapsedMs < 1 || maximumElapsedMs > 900_000) {
    throw new TypeError("Cron poll deadline must be between 1 and 900000 ms");
  }
  const deadline = now() + maximumElapsedMs;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const requestBudget = Math.floor(deadline - now());
    if (requestBudget < 1) break;
    const actual = await fetchScheduleSet({
      allowMissingWorker,
      environment,
      fetchImpl,
      requestTimeoutMs: Math.min(10_000, requestBudget),
      spec,
      workerName,
    });
    if (now() <= deadline && JSON.stringify(actual) === JSON.stringify(expectedSet)) {
      return attempt;
    }
    const remaining = Math.floor(deadline - now());
    if (attempt < pollAttempts && remaining > 0) {
      await pause(Math.min(pollIntervalMs, remaining));
    }
  }
  throw new Error("Cloudflare Cron schedules did not reach the reviewed state");
}

/**
 * Asserts that an evidence record matches the current release ID, Git SHA, and schema version.
 *
 * @param {object} evidence - Parsed evidence record
 * @param {string} name - Evidence description for error reporting
 * @param {object} spec - Release specification object
 * @returns {object} Validated evidence record
 * @throws {TypeError} If schema version, release ID, or Git SHA do not match
 */
function assertReleaseEvidence(evidence, name, spec) {
  if (
    evidence?.schema_version !== 1 ||
    evidence?.release_id !== spec.release_id ||
    evidence?.git_sha !== spec.git_sha
  ) {
    throw new TypeError(`${name} does not match the release`);
  }
  return evidence;
}

/**
 * Extracts and validates the canonical cron triggers defined in the rendered Automation Worker config.
 *
 * @param {object} config - Parsed rendered Wrangler configuration for Automation Worker
 * @param {object} spec - Selected release environment the rendered identity must match
 * @returns {Array<string>} Validated array of cron schedule pattern strings
 * @throws {TypeError} If the Worker identity or schedules are invalid
 */
function canonicalSchedules(config, spec) {
  if (
    typeof config?.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(config.name) ||
    (spec.environment === "production" && !config.name.endsWith(`-${spec.environment}`))
  ) {
    throw new TypeError("rendered Automation config has the wrong Worker name");
  }
  const schedules = cronSet(config?.triggers?.crons, "rendered Automation Cron schedules");
  if (schedules.length === 0) {
    throw new TypeError("rendered Automation config has no Cron schedules");
  }
  return schedules;
}

/**
 * Verifies that prerequisite deployment evidence and successful live smoke test evidence
 * exist before permitting cron triggers to be activated.
 *
 * @param {string} outDir - Directory path holding release evidence artifacts
 * @param {object} spec - Release specification object
 * @returns {Promise<void>}
 * @throws {TypeError} If deployment or smoke evidence is missing, mismatched, or failed
 */
async function assertActivationEvidence(outDir, spec) {
  assertReleaseEvidence(
    await readJsonFile(
      path.join(outDir, "worker-automation-deployment.json"),
      "Automation deployment evidence",
    ),
    "Automation deployment evidence",
    spec,
  );
  const smokeName =
    spec.deployment_mode === "bootstrap" ? "smoke-live.json" : "smoke-live-100.json";
  const smoke = assertReleaseEvidence(
    await readJsonFile(path.join(outDir, smokeName), "live smoke evidence"),
    "live smoke evidence",
    spec,
  );
  if (smoke.status !== "passed") {
    throw new TypeError("live smoke evidence is not successful");
  }
}

/**
 * Orchestrates pausing ('cron-pause') or activating ('cron-activate') scheduled cron triggers
 * for the Automation Worker.
 * When activating, asserts successful deployment and live smoke test evidence, deploys triggers
 * via Wrangler, and verifies against Cloudflare's control plane.
 * When pausing, empties cron triggers, deploys the pinned Wrangler through Bun, and verifies triggers are removed.
 * Records an atomic evidence artifact upon completion.
 *
 * @param {object} params - Transition parameters
 * @param {Array<object>} params.approvals - Operator reviews bound to the release commit, phase, and plan digest; not identity authentication.
 * @param {Record<string, string | undefined>} params.environment - Process environment variables
 * @param {typeof fetch} [params.fetchImpl=fetch] - HTTP fetch implementation
 * @param {string} params.outDir - Output directory for release artifacts and evidence
 * @param {(ms: number) => Promise<void>} [params.pause] - Delay function for polling
 * @param {string} params.phase - Release phase ('cron-activate' or 'cron-pause')
 * @param {string} params.planDigest - OpenTofu plan SHA-256 digest
 * @param {number} [params.pollAttempts] - Maximum poll attempts
 * @param {number} [params.pollIntervalMs] - Milliseconds between poll attempts
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess runner
 * @param {object} params.spec - Validated release specification
 * @returns {Promise<object>} Structured evidence record detailing the completed transition
 * @throws {TypeError} If phase name is invalid or prerequisites are unmet
 */
export async function transitionAutomationCron({
  approvals,
  environment,
  fetchImpl = fetch,
  outDir,
  pause,
  phase,
  planDigest,
  pollAttempts,
  pollIntervalMs,
  runCommand,
  spec,
}) {
  if (!phaseNames.has(phase)) throw new TypeError(`unknown Cron phase: ${phase}`);
  const configPath = path.join(outDir, "wrangler", "automation.json");
  const config = await readJsonFile(configPath, "rendered Automation config", 1024 * 1024);
  const schedules = canonicalSchedules(config, spec);
  const activating = phase === "cron-activate";
  const expected = activating ? schedules : [];

  if (activating) {
    await assertActivationEvidence(outDir, spec);
    await runCommand(
      "bun",
      ["run", "--no-install", "wrangler", "triggers", "deploy", "--config", configPath],
      { env: environment },
    );
  } else if (spec.deployment_mode === "update") {
    const pausedPath = path.join(outDir, "wrangler", "automation-paused.json");
    await writeFile(pausedPath, releaseInternals.json({ ...config, triggers: { crons: [] } }), {
      mode: 0o600,
    });
    try {
      await runCommand(
        "bun",
        ["run", "--no-install", "wrangler", "triggers", "deploy", "--config", pausedPath],
        { env: environment },
      );
    } finally {
      await rm(pausedPath, { force: true });
    }
  }

  await pollScheduleSet({
    allowMissingWorker: !activating && spec.deployment_mode === "bootstrap",
    environment,
    expected,
    fetchImpl,
    pause,
    pollAttempts,
    pollIntervalMs,
    spec,
    workerName: config.name,
  });
  const evidence = {
    approvals,
    git_sha: spec.git_sha,
    phase,
    plan_digest: planDigest,
    release_id: spec.release_id,
    schedule_set_digest: scheduleSetDigest(expected),
    schema_version: 1,
    status: activating ? "active" : "empty",
    worker: "automation",
  };
  await writeEvidence(
    outDir,
    activating ? "automation-cron-active.json" : "automation-cron-paused.json",
    evidence,
  );
  return evidence;
}
