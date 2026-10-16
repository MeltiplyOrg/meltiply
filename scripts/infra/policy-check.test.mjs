import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPlanPolicy, checkStaticPolicy } from "./policy-check.mjs";

test("checked-in infrastructure satisfies static policy", async () => {
  const result = await checkStaticPolicy();
  assert.deepEqual(result.failures, []);
  assert.ok(result.files.length >= 25);
});

test("plan policy rejects secret-bearing and public storage resources", () => {
  const failures = checkPlanPolicy({
    resource_changes: [
      {
        address: "cloudflare_hyperdrive_config.unsafe",
        type: "cloudflare_hyperdrive_config",
        change: { actions: ["create"], after: {} },
      },
      {
        address: "cloudflare_r2_custom_domain.assets",
        type: "cloudflare_r2_custom_domain",
        change: { actions: ["create"], after: {} },
      },
      {
        address: "cloudflare_queue_consumer.no_dlq",
        type: "cloudflare_queue_consumer",
        change: {
          actions: ["create"],
          after: {
            dead_letter_queue: null,
            settings: {
              batch_size: 10,
              max_concurrency: 2,
              max_retries: 3,
              max_wait_time_ms: 5_000,
              retry_delay: 5,
              visibility_timeout_ms: 30_000,
            },
            type: "worker",
          },
        },
      },
    ],
  });

  assert.equal(failures.length, 3);
});

test("plan policy accepts bounded resources with a DLQ", () => {
  const failures = checkPlanPolicy({
    resource_changes: [
      {
        address: "cloudflare_queue_consumer.publish_tiktok",
        type: "cloudflare_queue_consumer",
        change: {
          actions: ["create"],
          after: {
            dead_letter_queue: "meltiply-publish-tiktok-staging-dlq",
            settings: {
              batch_size: 5,
              max_concurrency: 1,
              max_retries: 5,
              max_wait_time_ms: 5_000,
              retry_delay: 5,
              visibility_timeout_ms: 60_000,
            },
            type: "worker",
          },
        },
      },
      {
        address: "cloudflare_queue_consumer.publish_tiktok_dlq_pull",
        type: "cloudflare_queue_consumer",
        change: {
          actions: ["create"],
          after: { dead_letter_queue: null, type: "http_pull" },
        },
      },
      {
        address: "cloudflare_r2_bucket.assets",
        type: "cloudflare_r2_bucket",
        change: { actions: ["create"], after: {} },
      },
      {
        address: "cloudflare_queue.publish_tiktok",
        type: "cloudflare_queue",
        change: {
          actions: ["create"],
          after: {
            settings: {
              delivery_paused: false,
              message_retention_period: 1_209_600,
            },
          },
        },
      },
    ],
  });

  assert.deepEqual(failures, []);
});

test("plan policy accepts explicitly paused Queue delivery during rollout", () => {
  const failures = checkPlanPolicy({
    resource_changes: [
      {
        address: "cloudflare_queue.publish_tiktok",
        type: "cloudflare_queue",
        change: {
          actions: ["create"],
          after: {
            settings: {
              delivery_paused: true,
              message_retention_period: 1_209_600,
            },
          },
        },
      },
    ],
  });

  assert.deepEqual(failures, []);
});

test("plan policy rejects implicit delivery state, short-lived, or unbounded Queue resources", () => {
  const failures = checkPlanPolicy({
    resource_changes: [
      {
        address: "cloudflare_queue.unsafe",
        type: "cloudflare_queue",
        change: {
          actions: ["update"],
          after: {
            settings: {
              delivery_paused: null,
              message_retention_period: 60,
            },
          },
        },
      },
      {
        address: "cloudflare_queue_consumer.unsafe",
        type: "cloudflare_queue_consumer",
        change: {
          actions: ["update"],
          after: {
            dead_letter_queue: "unsafe-dlq",
            settings: {
              batch_size: 101,
              max_concurrency: null,
              max_retries: 0,
              max_wait_time_ms: 60_001,
              retry_delay: -1,
              visibility_timeout_ms: 999,
            },
            type: "worker",
          },
        },
      },
    ],
  });

  assert.deepEqual(failures, [
    "cloudflare_queue.unsafe: Queue delivery state must be explicitly boolean",
    "cloudflare_queue.unsafe: Queue retention must be between four and fourteen days",
    "cloudflare_queue_consumer.unsafe: batch_size must be an integer between 1 and 100",
    "cloudflare_queue_consumer.unsafe: max_concurrency must be an integer between 1 and 20",
    "cloudflare_queue_consumer.unsafe: max_retries must be an integer between 1 and 100",
    "cloudflare_queue_consumer.unsafe: max_wait_time_ms must be an integer between 0 and 60000",
    "cloudflare_queue_consumer.unsafe: retry_delay must be an integer between 0 and 43200",
    "cloudflare_queue_consumer.unsafe: visibility_timeout_ms must be an integer between 1000 and 43200000",
  ]);
});
