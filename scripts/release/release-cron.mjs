import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { assertReleaseBound, readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { readBoundedResponseBody } from "./release-http.mjs";
import { stableJson } from "../lib/stable-json.mjs";
import { exactKeys, plainObject } from "./validation.mjs";

const controlCharactersPattern = /[\u0000-\u001f\u007f]/;
const unsafeApiTokenPattern = /[\u0000-\u0020\u007f]/;

const phaseNames = new Set(["cron-activate", "cron-pause"]);
const maximumResponseBytes = 64 * 1024;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function cronSet(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > 16) throw new TypeError(`${name} has too many schedules`);
  const schedules = value.map((schedule, index) => {
    if (
      typeof schedule !== "string" ||
      schedule.length === 0 ||
      schedule.length > 256 ||
      schedule.trim() !== schedule ||
      controlCharactersPattern.test(schedule)
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

export function scheduleSetDigest(schedules) {
  return sha256(stableJson(cronSet(schedules, "Cron schedules")));
}

export function parseScheduleResponse(source) {
  let response;
  try {
    response = JSON.parse(source);
  } catch {
    throw new TypeError("Cloudflare schedules response must be valid JSON");
  }
  plainObject(response, "Cloudflare schedules response");
  exactKeys(
    response,
    new Set(["errors", "messages", "result", "success"]),
    "Cloudflare schedules response",
    { allowMissing: true },
  );
  const result = plainObject(response.result, "Cloudflare schedules response result");
  exactKeys(result, new Set(["schedules"]), "Cloudflare schedules response result", {
    allowMissing: true,
  });
  if (response.success !== true || !Array.isArray(result.schedules)) {
    throw new TypeError("Cloudflare schedules response is unsuccessful");
  }
  return cronSet(
    result.schedules.map((entry, index) => {
      const schedule = plainObject(
        entry,
        `Cloudflare schedules response result.schedules[${index}]`,
      );
      exactKeys(
        schedule,
        new Set(["created_on", "cron", "modified_on"]),
        `Cloudflare schedules response result.schedules[${index}]`,
        { allowMissing: true },
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

function apiToken(environment) {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    token.trim() !== token ||
    unsafeApiTokenPattern.test(token)
  ) {
    throw new TypeError("CLOUDFLARE_API_TOKEN is required for Cron proof");
  }
  return token;
}

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

async function assertActivationEvidence(outDir, spec) {
  assertReleaseBound(
    await readJsonFile(
      path.join(outDir, "worker-automation-deployment.json"),
      "Automation deployment evidence",
    ),
    "Automation deployment evidence",
    spec,
  );
  const smokeName =
    spec.deployment_mode === "bootstrap" ? "smoke-live.json" : "smoke-live-100.json";
  const smoke = assertReleaseBound(
    await readJsonFile(path.join(outDir, smokeName), "live smoke evidence"),
    "live smoke evidence",
    spec,
  );
  if (smoke.status !== "passed") {
    throw new TypeError("live smoke evidence is not successful");
  }
}

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
    await writeFile(pausedPath, stableJson({ ...config, triggers: { crons: [] } }), {
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
