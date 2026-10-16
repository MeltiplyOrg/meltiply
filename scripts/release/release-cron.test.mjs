import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseScheduleResponse,
  pollScheduleSet,
  scheduleSetDigest,
  transitionAutomationCron,
} from "./release-cron.mjs";

const gitSha = "a".repeat(40);
const planDigest = "b".repeat(64);
const canonicalCrons = ["* * * * *", "0 0 * * *"];

function spec(deploymentMode = "update") {
  return {
    deployment_mode: deploymentMode,
    git_sha: gitSha,
    release_id: "staging-20260722-a1b2c3d4",
    runtime: { r2_account_id: "c".repeat(32) },
  };
}

function response(result, status = 200) {
  return new Response(
    JSON.stringify({
      errors: [],
      messages: [],
      result: { schedules: result },
      success: true,
    }),
    { status },
  );
}

async function releaseDirectory(context, mode = "update") {
  const outDir = await mkdtemp(path.join(tmpdir(), "release-cron-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  await mkdir(path.join(outDir, "wrangler"));
  await writeFile(
    path.join(outDir, "wrangler/automation.json"),
    JSON.stringify({
      name: "meltiply-automation",
      triggers: { crons: canonicalCrons },
    }),
  );
  if (mode === "activate") {
    const evidence = {
      git_sha: gitSha,
      release_id: spec().release_id,
      schema_version: 1,
    };
    await writeFile(
      path.join(outDir, "worker-automation-deployment.json"),
      JSON.stringify(evidence),
    );
    await writeFile(
      path.join(outDir, "smoke-live-100.json"),
      JSON.stringify({ ...evidence, status: "passed" }),
    );
  }
  return outDir;
}

test("the primary Cloudflare schedule fixture is canonical and secret-free", async () => {
  const primary = await readFile(
    new URL("./fixtures/cloudflare-schedules-response.json", import.meta.url),
    "utf8",
  );
  assert.deepEqual(parseScheduleResponse(primary), [canonicalCrons[0]]);
  assert.deepEqual(
    parseScheduleResponse(
      JSON.stringify({
        result: {
          schedules: [{ cron: canonicalCrons[0] }, { cron: canonicalCrons[1] }],
        },
        success: true,
      }),
    ),
    canonicalCrons,
  );
  assert.equal(scheduleSetDigest([]).length, 64);
  assert.throws(
    () =>
      parseScheduleResponse(
        JSON.stringify({
          result: { schedules: [{ cron: "same" }, { cron: "same" }] },
          success: true,
        }),
      ),
    /duplicate schedules/,
  );
});

test("Cron control-plane polling is bounded and exact", async () => {
  let requests = 0;
  const waits = [];
  const attempts = await pollScheduleSet({
    environment: { CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters" },
    expected: canonicalCrons,
    fetchImpl: async () => {
      requests += 1;
      return response(requests === 1 ? [] : canonicalCrons.map((cron) => ({ cron })));
    },
    pause: async (milliseconds) => waits.push(milliseconds),
    pollAttempts: 2,
    pollIntervalMs: 5,
    spec: spec(),
    workerName: "meltiply-automation",
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [5]);
  await assert.rejects(
    pollScheduleSet({
      environment: {
        CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters",
      },
      expected: canonicalCrons,
      fetchImpl: async () => response([]),
      pause: async () => {},
      pollAttempts: 1,
      pollIntervalMs: 0,
      spec: spec(),
      workerName: "meltiply-automation",
    }),
    /did not reach the reviewed state/,
  );

  let clock = 0;
  const boundedWaits = [];
  await assert.rejects(
    pollScheduleSet({
      environment: {
        CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters",
      },
      expected: canonicalCrons,
      fetchImpl: async () => {
        clock += 8;
        return response([]);
      },
      maximumElapsedMs: 10,
      now: () => clock,
      pause: async (milliseconds) => {
        boundedWaits.push(milliseconds);
        clock += milliseconds;
      },
      pollAttempts: 180,
      pollIntervalMs: 5,
      spec: spec(),
      workerName: "meltiply-automation",
    }),
    /did not reach the reviewed state/,
  );
  assert.deepEqual(boundedWaits, [2]);

  await assert.rejects(
    pollScheduleSet({
      environment: {
        CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters",
      },
      expected: [],
      fetchImpl: async () => new Response("x".repeat(64 * 1024 + 1)),
      maximumElapsedMs: 10,
      pause: async () => {},
      pollAttempts: 1,
      pollIntervalMs: 0,
      spec: spec(),
      workerName: "meltiply-automation",
    }),
    /response is too large/,
  );
});

test("update Cron pause deploys an empty set and records only its digest", async (context) => {
  const outDir = await releaseDirectory(context);
  let pausedConfig;
  const result = await transitionAutomationCron({
    approvals: [{ approval_job: { name: "staging-foundation-approval" } }],
    environment: { CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters" },
    fetchImpl: async () => response([]),
    outDir,
    phase: "cron-pause",
    planDigest,
    pollAttempts: 1,
    pollIntervalMs: 0,
    runCommand: async (_command, args) => {
      const configPath = args.at(-1);
      pausedConfig = JSON.parse(await readFile(configPath, "utf8"));
      return { code: 0, stderr: "", stdout: "" };
    },
    spec: spec(),
  });
  assert.deepEqual(pausedConfig.triggers.crons, []);
  assert.equal(result.status, "empty");
  assert.equal(result.schedule_set_digest, scheduleSetDigest([]));
  assert.equal(JSON.stringify(result).includes(canonicalCrons[0]), false);
  await assert.rejects(readFile(path.join(outDir, "wrangler/automation-paused.json")), /ENOENT/);
});

// Activation evidence must reflect the canonical remote schedule, not subprocess argument spelling.
test("Cron activation requires live smoke then proves the canonical set", async (context) => {
  const outDir = await releaseDirectory(context, "activate");
  const result = await transitionAutomationCron({
    approvals: [{ approval_job: { name: "staging-queue-resume-approval" } }],
    environment: { CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters" },
    fetchImpl: async () => response(canonicalCrons.map((cron) => ({ cron }))),
    outDir,
    phase: "cron-activate",
    planDigest,
    pollAttempts: 1,
    pollIntervalMs: 0,
    runCommand: async () => ({ code: 0, stderr: "", stdout: "" }),
    spec: spec(),
  });
  assert.equal(result.status, "active");
  assert.equal(result.schedule_set_digest, scheduleSetDigest(canonicalCrons));
});

test("bootstrap Cron pause accepts an absent Worker without mutating triggers", async (context) => {
  const outDir = await releaseDirectory(context);
  let commandRan = false;
  const result = await transitionAutomationCron({
    approvals: [],
    environment: { CLOUDFLARE_API_TOKEN: "token-with-at-least-20-characters" },
    fetchImpl: async () => response([], 404),
    outDir,
    phase: "cron-pause",
    planDigest,
    pollAttempts: 1,
    pollIntervalMs: 0,
    runCommand: async () => {
      commandRan = true;
    },
    spec: spec("bootstrap"),
  });
  assert.equal(commandRan, false);
  assert.equal(result.status, "empty");
});
