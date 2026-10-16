import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { parseJsonc } from "../lib/jsonc.mjs";

import {
  KNOWN_QUEUE_WORKLOADS,
  parseQueueArguments,
  replayPayload,
  runQueueCommand,
} from "./queue-ops.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function terraformWorkloadNames(source) {
  const marker = "workloads = {";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "Terraform workloads local is missing");
  const start = markerIndex + marker.length - 1;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.notEqual(end, -1, "Terraform workloads local is unclosed");
  return [...source.slice(start + 1, end).matchAll(/^    "([^"]+)" = \{$/gm)]
    .map((match) => match[1])
    .sort();
}

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_API_TOKEN: "secret-token",
};
const queues = [
  { queue_id: "target-id", queue_name: "meltiply-publish-tiktok-staging" },
  {
    queue_id: "source-id",
    queue_name: "meltiply-publish-tiktok-staging-dlq",
  },
];

function apiResponse(result, status = 200) {
  return new Response(
    JSON.stringify({
      errors: status < 400 ? [] : [{ message: "request failed" }],
      result,
      success: status < 400,
    }),
    { headers: { "Content-Type": "application/json" }, status },
  );
}

function fetchSequence(results) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ init, url });
    const result = results.shift();
    if (!result) throw new Error(`unexpected fetch: ${url}`);
    return result;
  };
  return { calls, fetchImpl };
}

function replayOptions(apply = false) {
  return parseQueueArguments([
    "replay-dlq",
    "--environment",
    "staging",
    "--workload",
    "publish-tiktok",
    "--operator",
    "on-call@example.test",
    "--reason",
    "incident INC-123 provider recovered",
    ...(apply ? ["--apply", "--confirm", "replay publish-tiktok staging"] : []),
  ]);
}

test("Terraform, staging Wrangler, and queue operations share one workload set", async () => {
  const [terraformSource, wranglerSource] = await Promise.all([
    readFile(resolve(repositoryRoot, "infra/cloudflare/main.tf"), "utf8"),
    readFile(resolve(repositoryRoot, "workers/automation/wrangler.jsonc"), "utf8"),
  ]);
  const wrangler = parseJsonc(wranglerSource);
  const producers = wrangler.queues.producers;
  const knownWorkloads = [...KNOWN_QUEUE_WORKLOADS].sort();
  const wranglerWorkloads = producers
    .map(({ queue }) => {
      const match = /^meltiply-(.+)-staging$/.exec(queue);
      assert.ok(match, `unexpected staging Queue name: ${queue}`);
      return match[1];
    })
    .sort();

  assert.equal(
    new Set(producers.map(({ binding }) => binding)).size,
    producers.length,
    "staging Queue bindings must be unique",
  );
  assert.deepEqual(terraformWorkloadNames(terraformSource), knownWorkloads);
  assert.deepEqual(wranglerWorkloads, knownWorkloads);
});

test("argument parsing keeps replay dry-run by default and requires exact apply confirmation", () => {
  assert.equal(replayOptions().apply, false);
  assert.equal(
    parseQueueArguments([
      "metrics",
      "--",
      "--environment",
      "staging",
      "--workload",
      "publish-tiktok",
    ]).workload,
    "publish-tiktok",
  );
  assert.throws(
    () =>
      parseQueueArguments([
        "metrics",
        "--environment",
        "staging",
        "--workload",
        "publish-tiktok",
        "--apply",
      ]),
    /only valid for replay-dlq/,
  );
  assert.throws(
    () =>
      parseQueueArguments([
        "replay-dlq",
        "--environment",
        "staging",
        "--workload",
        "publish-tiktok",
        "--operator",
        "operator",
        "--reason",
        "incident recovered",
        "--max-backlog",
        "10",
      ]),
    /unknown option/,
  );
  assert.throws(
    () => parseQueueArguments(["metrics", "--environment", "staging", "--workload", "billing"]),
    /workload must be one of/,
  );
  assert.throws(
    () =>
      parseQueueArguments([
        "replay-dlq",
        "--environment",
        "staging",
        "--workload",
        "publish-tiktok",
        "--operator",
        "operator",
        "--reason",
        "incident recovered",
        "--apply",
        "--confirm",
        "wrong",
      ]),
    /requires --confirm/,
  );
  assert.equal(replayOptions(true).apply, true);
});

test("metrics fails health on workload age and any DLQ backlog", async () => {
  const { calls, fetchImpl } = fetchSequence([
    apiResponse(queues),
    apiResponse({
      backlog_bytes: 2048,
      backlog_count: 5,
      oldest_message_timestamp_ms: Date.parse("2026-01-01T00:00:00Z"),
    }),
    apiResponse({
      backlog_bytes: 128,
      backlog_count: 1,
      oldest_message_timestamp_ms: Date.parse("2026-01-01T00:01:00Z"),
    }),
  ]);
  const options = parseQueueArguments([
    "metrics",
    "--environment",
    "staging",
    "--workload",
    "publish-tiktok",
    "--max-backlog",
    "10",
    "--max-age-seconds",
    "30",
  ]);
  const result = await runQueueCommand(options, {
    environment,
    fetchImpl,
    now: () => Date.parse("2026-01-01T00:02:00Z"),
  });

  assert.equal(result.healthy, false);
  assert.deepEqual(result.alerts, ["workload_age", "dead_letter_backlog"]);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith("/target-id/metrics"));
  assert.ok(calls[2].url.endsWith("/source-id/metrics"));
});

test("dry-run hashes JSON messages and immediately retries their leases", async () => {
  const encodedBody = Buffer.from(
    JSON.stringify({ event_id: "event-1", secret: "never-log-me" }),
  ).toString("base64");
  const { calls, fetchImpl } = fetchSequence([
    apiResponse(queues),
    apiResponse({
      messages: [
        {
          attempts: 4,
          body: encodedBody,
          id: "message-1",
          lease_id: "lease-1",
          metadata: { "CF-Content-Type": "json" },
          timestamp_ms: 1,
        },
      ],
    }),
    apiResponse({ ackCount: 0, retryCount: 1 }),
  ]);
  const result = await runQueueCommand(replayOptions(), {
    environment,
    fetchImpl,
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  });

  assert.equal(result.applied, false);
  assert.equal(result.outcome, "dry_run");
  assert.equal(result.message_count, 1);
  assert.equal(result.messages[0].digest.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /never-log-me|secret-token/);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith("/source-id/messages/pull"));
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    acks: [],
    retries: [{ lease_id: "lease-1" }],
  });
});

test("apply pushes decoded JSON before acknowledging the DLQ lease", async () => {
  const body = { event_id: "event-1", type: "outbox.event", version: 1 };
  const { calls, fetchImpl } = fetchSequence([
    apiResponse(queues),
    apiResponse({
      messages: [
        {
          attempts: 5,
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
          id: "message-1",
          lease_id: "lease-1",
          metadata: { "CF-Content-Type": "json" },
          timestamp_ms: 1,
        },
      ],
    }),
    apiResponse({ metadata: { metrics: { backlog_count: 1 } } }),
    apiResponse({ ackCount: 1, retryCount: 0 }),
  ]);
  const result = await runQueueCommand(replayOptions(true), {
    environment,
    fetchImpl,
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  });

  assert.equal(result.applied, true);
  assert.equal(result.outcome, "completed");
  assert.ok(calls[2].url.endsWith("/target-id/messages"));
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    body,
    content_type: "json",
  });
  assert.ok(calls[3].url.endsWith("/source-id/messages/ack"));
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    acks: [{ lease_id: "lease-1" }],
    retries: [],
  });
});

test("apply reports partial replay only after settling every pulled lease", async () => {
  const messages = ["message-1", "message-2"].map((id, index) => ({
    attempts: 3,
    body: JSON.stringify({ event_id: id }),
    id,
    lease_id: `lease-${index + 1}`,
    metadata: { "CF-Content-Type": "json" },
    timestamp_ms: index + 1,
  }));
  const { calls, fetchImpl } = fetchSequence([
    apiResponse(queues),
    apiResponse({ messages }),
    apiResponse({ metadata: {} }),
    apiResponse({}, 503),
    apiResponse({ ackCount: 1, retryCount: 1 }),
  ]);

  const result = await runQueueCommand(replayOptions(true), {
    environment,
    fetchImpl,
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  });

  assert.equal(result.outcome, "partial");
  assert.equal(result.error_code, "push_failed");
  assert.equal(result.replayed_count, 1);
  assert.equal(result.retried_count, 1);
  assert.equal(result.unsettled_count, 0);
  assert.deepEqual(JSON.parse(calls[4].init.body), {
    acks: [{ lease_id: "lease-1" }],
    retries: [{ lease_id: "lease-2" }],
  });
});

test("unsupported content fails closed and is never transformed", () => {
  assert.throws(
    () =>
      replayPayload({
        body: "opaque",
        lease_id: "lease-1",
        metadata: { "CF-Content-Type": "v8" },
      }),
    /cannot be safely replayed/,
  );
});
