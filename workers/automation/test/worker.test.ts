import type { EffectTransactionClient } from "@meltiply/database";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { distributionProcessingGraceSeconds } from "../src/distribution";
import { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds } from "../src/due-work";
import {
  classifyJobError,
  createPublishQueueResolverLive,
  createPublishQueueResolverTest,
  createQueuePublisherLive,
  createQueuePublisherTest,
  PublishQueueResolver,
  QueuePublisher,
  RetryableJobError,
} from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { AutomationEntrypoint, createAutomationHandler } from "../src/index";
import type { OutboxMessage } from "../src/messages";
import { sweepDueProviderJobs } from "../src/provider-sync";
import { logRecords } from "./log-records";
import { fakeQueue, fakeReplyWorkflow, fakeTransactionClient } from "./test-doubles";

const worker = createAutomationHandler();

beforeEach(() => {
  withSystemTransactionEffect.mockReturnValue(Effect.succeed({ rows: [] }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function engagementRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const adapter: ProviderAdapter = {
    capability: {
      accepted_mime_types: [],
      analytics: true,
      asset_types: [],
      comments: true,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: [],
      notes: [],
      platform: "threads",
      publish: false,
      reply: false,
    },
    listAnalytics: async () => ({ items: [] }),
    listComments: async () => ({ items: [] }),
    refreshAccessToken: async () => ({
      accessToken: "access",
      expiresAt: "2040-01-01T00:00:00Z",
      scopes: [],
    }),
    transferModes: [],
  };
  registry.register("threads", adapter);
  return registry;
}

function idleAssetMaintenance() {
  return Effect.succeed({
    cleanup_errors: 0,
    expired_sessions: 0,
    orphan_assets_claimed: 0,
    reconciliation_events: 0,
    stale_writing_objects_deleted: 0,
    terminal_sessions_reclaimed: 0,
    usage_rows: 0,
  });
}

describe("Automation Worker foundation", () => {
  it("exposes an internal liveness response", async () => {
    const response = await exports.default.fetch("http://automation.internal/");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: "automation",
      status: "ok",
    });
  });

  it("acks unsupported queue messages without retrying them", async () => {
    const batch = createMessageBatch("meltiply-unsupported-test", [
      {
        attempts: 1,
        body: { type: "distribution.publish" },
        id: "message-unsupported",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual(["message-unsupported"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("acks durable asset work and retries transient failures individually", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const process = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed("processed" as const))
      .mockReturnValueOnce(Effect.fail(classifyJobError(new Error("token=private-r2-value"))));
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process,
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
    });
    const body = {
      aggregate_id: "00000000-0000-4000-8000-000000000001",
      event_id: "00000000-0000-4000-8000-000000000101",
      organization_id: "00000000-0000-4000-8000-000000000201",
      payload: {
        asset_id: "00000000-0000-4000-8000-000000000001",
      },
      topic: "asset.processing.requested",
      type: "outbox.event",
      version: 1,
    } as const;
    const batch = createMessageBatch("meltiply-asset-processing-test", [
      {
        attempts: 1,
        body,
        id: "asset-success",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        attempts: 2,
        body: { ...body, event_id: "event-two" },
        id: "asset-retry",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await handler.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toEqual(["asset-success"]);
    expect(result.retryMessages).toEqual([{ msgId: "asset-retry" }]);
    expect(process).toHaveBeenCalledTimes(2);
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "queue_job_failed",
          event: "asset_job",
        }),
        error: expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "Error",
        }),
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-r2-value");
  });

  it("starts an idempotent bounded reply Workflow with identifier-only state", async () => {
    const createBatch = vi.fn(async () => []);
    const handler = createAutomationHandler();
    const body = {
      aggregate_id: "00000000-0000-4000-8000-000000000001",
      event_id: "00000000-0000-4000-8000-000000000102",
      organization_id: "00000000-0000-4000-8000-000000000201",
      payload: {
        comment_id: "00000000-0000-4000-8000-000000000001",
        text: "This must not enter Workflow state",
      },
      request_id: "request-reply-1",
      topic: "comment.reply.requested",
      type: "outbox.event" as const,
      version: 1 as const,
    };
    const batch = createMessageBatch("meltiply-replies-test", [
      {
        attempts: 1,
        body,
        id: "reply-workflow-message",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const workflowEnv: AutomationEnv = {
      ...env,
      REPLY_WORKFLOW: fakeReplyWorkflow(createBatch),
    };

    const context = createExecutionContext();
    await handler.queue?.(batch, workflowEnv, context);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["reply-workflow-message"]);
    expect(createBatch).toHaveBeenCalledWith([
      {
        id: "reply-00000000-0000-4000-8000-000000000102",
        params: {
          comment_id: "00000000-0000-4000-8000-000000000001",
          event_id: "00000000-0000-4000-8000-000000000102",
          organization_id: "00000000-0000-4000-8000-000000000201",
          request_id: "request-reply-1",
          type: "reply.workflow",
          version: 1,
        },
        retention: {
          errorRetention: "7 days",
          successRetention: "1 day",
        },
      },
    ]);
    expect(JSON.stringify(createBatch.mock.calls)).not.toContain(
      "This must not enter Workflow state",
    );
  });

  it("rejects unrelated object-shaped and notification messages without processing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const process = vi.fn().mockReturnValue(Effect.succeed("processed" as const));
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process,
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
    });
    const body = {
      account: "cloudflare-account",
      action: "PutObject" as const,
      bucket: "meltiply-assets-local",
      eventTime: "2026-01-01T00:00:00Z",
      object: {
        eTag: "etag-1",
        key: "org/asset/source.png",
        size: 42,
      },
    };
    const batch = createMessageBatch("meltiply-asset-processing-test", [
      {
        attempts: 1,
        body,
        id: "r2-object-created",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await handler.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toEqual(["r2-object-created"]);
    expect(result.retryMessages).toEqual([]);
    expect(process).not.toHaveBeenCalled();
    expect(logRecords(warn)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "unknown_message_type",
          event: "unsupported_queue_message",
          job: "unsupported",
          message_id: "r2-object-created",
          outcome: "rejected",
        }),
      }),
    );
  });

  it("routes provider sync messages to their durable processor", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const processProviderSync = vi.fn().mockReturnValue(Effect.succeed("processed" as const));
    const handler = createAutomationHandler({
      providerSyncProcessor: processProviderSync,
    });
    const body = {
      event_id: "00000000-0000-4000-8000-000000000301",
      request_id: "00000000-0000-4000-8000-000000000301",
      target_id: "00000000-0000-4000-8000-000000000302",
      type: "provider.sync" as const,
      version: 1 as const,
      workload: "analytics" as const,
    };
    const batch = createMessageBatch("meltiply-analytics-test", [
      {
        attempts: 1,
        body,
        id: "analytics-sync",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await handler.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["analytics-sync"]);
    expect(processProviderSync).toHaveBeenCalledWith(env, body);
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "provider_sync_job",
          job: "analytics",
          latency_ms: expect.any(Number),
          outcome: "processed",
          retry_class: "none",
        }),
        job_id: "00000000-0000-4000-8000-000000000301",
        request_id: "00000000-0000-4000-8000-000000000301",
        service: "automation",
        trace_id: "00000000-0000-4000-8000-000000000301",
      }),
    );
  });

  it("logs safe diagnostics when scheduled work fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation(
          fakeTransactionClient(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        ),
    );
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
      relay: () => Effect.fail(classifyJobError(new TypeError("password=private-cron-value"))),
    });

    const ctx = createExecutionContext();
    await expect(
      handler.scheduled?.(
        {
          cron: "0 * * * *",
          noRetry: vi.fn(),
          scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
        },
        env,
        ctx,
      ),
    ).rejects.toThrow("private-cron-value");
    await waitOnExecutionContext(ctx);
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "scheduled_job_failed",
          event: "automation_scheduled",
          scheduled_work: "outbox-relay",
        }),
        error: expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "TypeError",
        }),
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-cron-value");
  });

  it("reports a failing unit without silently skipping the remaining tiers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation(
          fakeTransactionClient(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        ),
    );
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(() =>
          Effect.sync(() => {
            calls.push("asset-maintenance");
            return {
              cleanup_errors: 0,
              expired_sessions: 0,
              orphan_assets_claimed: 0,
              reconciliation_events: 0,
              stale_writing_objects_deleted: 0,
              terminal_sessions_reclaimed: 0,
              usage_rows: 0,
            };
          }),
        ),
      }),
      enqueueDue: () =>
        Effect.suspend(() => {
          calls.push("due-distribution-scan");
          return Effect.fail(classifyJobError(new TypeError("password=private-cron-value")));
        }),
      enqueueDueReplyReconciliations: () =>
        Effect.sync(() => {
          calls.push("reply-reconciliation");
          return 1;
        }),
      sweepProviderDue: () =>
        Effect.sync(() => {
          calls.push("provider-sync-sweep");
          return { analytics: 0, comments: 0, token_refresh: 0 };
        }),
      relay: () =>
        Effect.sync(() => {
          calls.push("outbox-relay");
          return { claimed: 0, dead: 0, failed: 0, published: 0 };
        }),
      runRetention: () =>
        Effect.sync(() => {
          calls.push("retention");
          return { deleted: 0, errors: 0 };
        }),
      deliverImprovementReports: () =>
        Effect.succeed({
          claimed: 0,
          delivered: 0,
          discarded: 0,
          failed: 0,
          released: 0,
          skipped: 0,
        }),
      enqueueDailyUsageReport: () => Effect.succeed({ considered: 0, queued: 0 }),
    });

    const ctx = createExecutionContext();
    await expect(handler.scheduled(undefined, env, ctx)).rejects.toThrow("private-cron-value");
    await waitOnExecutionContext(ctx);

    expect(calls).toEqual([
      "due-distribution-scan",
      "outbox-relay",
      "asset-maintenance",
      "provider-sync-sweep",
      "reply-reconciliation",
      "retention",
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "scheduled_job_failed",
          event: "automation_scheduled",
          outcome: "failed",
          scheduled_work: "due-distribution-scan",
        }),
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-cron-value");
  });

  it("reports every failing unit and still runs the independent work", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runRetention = vi.fn(() => Effect.succeed({ deleted: 2, errors: 0 }));
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation(
          fakeTransactionClient(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        ),
    );
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
      enqueueDue: () => Effect.fail(classifyJobError(new TypeError("distribution scan failed"))),
      enqueueDueReplyReconciliations: vi.fn(() => Effect.succeed(0)),
      sweepProviderDue: () => Effect.fail(classifyJobError(new TypeError("provider scan failed"))),
      relay: vi.fn(() =>
        Effect.succeed({
          claimed: 0,
          dead: 0,
          failed: 0,
          published: 0,
        }),
      ),
      runRetention,
      deliverImprovementReports: () =>
        Effect.succeed({
          claimed: 0,
          delivered: 0,
          discarded: 0,
          failed: 0,
          released: 0,
          skipped: 0,
        }),
      enqueueDailyUsageReport: () => Effect.succeed({ considered: 0, queued: 0 }),
    });
    const ctx = createExecutionContext();
    await expect(handler.scheduled(undefined, env, ctx)).rejects.toThrow(
      "distribution scan failed",
    );
    await waitOnExecutionContext(ctx);

    expect(error).toHaveBeenCalledTimes(2);
    const reportedWork = logRecords(error).map(
      (record) => (record.context as { scheduled_work?: unknown } | undefined)?.scheduled_work,
    );
    expect(reportedWork).toEqual(["due-distribution-scan", "provider-sync-sweep"]);
    expect(runRetention).toHaveBeenCalledWith(env);
  });
});

describe("Due work scheduled claim protocol", () => {
  it("drives descriptor-selected claims across scheduled cron tiers", async () => {
    const executedQueries: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      executedQueries.push({ params, sql });
      if (sql.includes("AS event_id")) {
        return Effect.succeed({ rowCount: 0, rows: [] });
      }
      return Effect.succeed({
        rowCount: 1,
        rows: [{ claimed_count: 0, inserted_count: 0 }],
      });
    });
    withSystemTransactionEffect.mockImplementation(
      <A, E, R>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        operation(
          fakeTransactionClient((sql, params) => query(sql, params ? [...params] : undefined)),
        ),
    );

    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
      relay: vi.fn(() =>
        Effect.succeed({
          claimed: 0,
          dead: 0,
          failed: 0,
          published: 0,
        }),
      ),
      runRetention: vi.fn(() => Effect.succeed({ deleted: 0, errors: 0 })),
      sweepProviderDue: (automationEnv) =>
        Effect.provide(
          sweepDueProviderJobs(automationEnv, {
            providerRegistry: engagementRegistry(),
          }),
          createQueuePublisherLive(),
        ),
    });

    const skipCtx = createExecutionContext();
    await handler.scheduled?.(
      {
        cron: "* * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      skipCtx,
    );
    await waitOnExecutionContext(skipCtx);
    expect(executedQueries).toHaveLength(0);

    const hourlyCtx = createExecutionContext();
    await handler.scheduled?.(
      {
        cron: "0 * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      hourlyCtx,
    );
    await waitOnExecutionContext(hourlyCtx);

    const hourlyClaims = executedQueries.filter(({ sql }) => sql.includes("SKIP LOCKED"));
    expect(hourlyClaims).toHaveLength(6);

    const [
      dueDistributionClaim,
      distributionSweepClaim,
      analyticsSweepClaim,
      commentsSweepClaim,
      tokenRefreshSweepClaim,
      replyClaim,
    ] = hourlyClaims;

    const hourlyProviderSyncBounds = [
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ];
    expect(dueDistributionClaim?.params).toEqual([
      100,
      distributionProcessingGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);
    expect(distributionSweepClaim?.params).toEqual([
      100,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);
    expect(analyticsSweepClaim?.params).toEqual(hourlyProviderSyncBounds);
    expect(commentsSweepClaim?.params).toEqual(hourlyProviderSyncBounds);
    expect(tokenRefreshSweepClaim?.params).toEqual(hourlyProviderSyncBounds);
    expect(replyClaim?.params).toEqual([50, 10, maximumDelayedDeliverySeconds]);
  });
});

describe("Scheduled entry delayed delivery", () => {
  it("sends scheduled publishes with bounded delays and suppresses beyond-horizon commands", async () => {
    const base = Date.parse("2026-08-24T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base);
    const distributionId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const eventId = (number: number) =>
      `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
    const claimedRow = (number: number, scheduledAt: Date | null) => ({
      aggregate_id: distributionId,
      attempt_count: 1,
      id: eventId(number),
      next_attempt_at: null,
      org_id: organizationId,
      payload: { distribution_id: distributionId, version: 1 },
      platform: "facebook",
      scheduled_at: scheduledAt,
      topic: "distribution.publish.requested",
    });
    const batches: MessageSendRequest<OutboxMessage>[][] = [];
    let sentAtMs = 0;
    const recordedQueue = {
      sendBatch: async (messages: MessageSendRequest<OutboxMessage>[]) => {
        sentAtMs = Date.now();
        batches.push(messages);
        return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
      },
    };

    const query = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({
          rows: [
            claimedRow(301, new Date(base + 600_000)),
            claimedRow(302, new Date(base + 86_400_000)),
            claimedRow(303, new Date(base + 90_000_000)),
          ],
        }),
      )
      .mockReturnValue(Effect.succeed({ rows: [] }));
    withSystemTransactionEffect.mockImplementation(
      <A, E, R>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => operation({ query }),
    );

    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
      enqueueDue: vi.fn(() => Effect.succeed(0)),
      enqueueDueReplyReconciliations: vi.fn(() => Effect.succeed(0)),
      runRetention: vi.fn(() => Effect.succeed({ deleted: 0, errors: 0 })),
      sweepAccountAnalytics: vi.fn(() => Effect.succeed({ failed: 0, recorded: 0, scanned: 0 })),
      sweepDue: vi.fn(() => Effect.succeed(0)),
      sweepProviderDue: vi.fn(() =>
        Effect.succeed({
          analytics: 0,
          comments: 0,
          token_refresh: 0,
        }),
      ),
    });

    const ctx = createExecutionContext();
    await handler.scheduled?.(
      {
        cron: "0 * * * *",
        noRetry: vi.fn(),
        scheduledTime: base,
      },
      { ...env, FACEBOOK_PUBLISH_QUEUE: recordedQueue } as typeof env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(batches).toHaveLength(1);
    const sent = batches[0] ?? [];
    expect(sent.map(({ body }) => body.event_id)).toEqual([eventId(301), eventId(302)]);
    expect(sent[0]?.delaySeconds).toBe(Math.max(0, Math.ceil((base + 600_000 - sentAtMs) / 1000)));
    expect(sent[1]?.delaySeconds).toBeGreaterThan(86_390);
    expect(sent[1]?.delaySeconds).toBeLessThanOrEqual(86_400);
    for (const { body } of sent) {
      expect(body.payload).toEqual({
        distribution_id: distributionId,
      });
      expect(body.version).toBe(1);
      expect(body.topic).toBe("distribution.publish.requested");
      expect(Object.keys(body)).not.toContain("scheduled_at");
    }
    expect(new Set(query.mock.calls[1]?.[1]?.[0] as string[])).toEqual(
      new Set([eventId(301), eventId(302), eventId(303)]),
    );
  });
});

describe("eager outbox relay through the Automation entrypoint", () => {
  it("relays a bounded batch and cannot double-deliver against a live lease", async () => {
    const eventId = "00000000-0000-4000-8000-000000000020";
    const query = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({
          rows: [
            {
              aggregate_id: "00000000-0000-4000-8000-000000000002",
              attempt_count: 1,
              id: eventId,
              next_attempt_at: null,
              org_id: "00000000-0000-4000-8000-000000000001",
              payload: { request_id: "request-outbox-test" },
              platform: null,
              scheduled_at: null,
              topic: "asset.processing.requested",
            },
          ],
        }),
      )
      .mockReturnValue(Effect.succeed({ rows: [] }));
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) => operation({ query }),
    );
    const batches: MessageSendRequest<OutboxMessage>[][] = [];
    const queue = fakeQueue({
      sendBatch: async (messages) => {
        batches.push([...(messages as Iterable<MessageSendRequest<OutboxMessage>>)]);
        return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
      },
    });
    const entrypoint = new AutomationEntrypoint({} as ExecutionContext, {
      ASSET_PROCESSING_QUEUE: queue,
      ENVIRONMENT: "test",
      VERSION: "test",
    });

    await expect(entrypoint.relayOutbox()).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });
    expect((batches[0] ?? []).map((message) => message.body.event_id)).toEqual([eventId]);
    expect(query.mock.calls[0]?.[1]).toEqual([50, 10, 120]);
  });
});

describe("channel revocation queue dispatch", () => {
  it("acks a processed revocation and retries a retryable provider failure", async () => {
    const processChannelRevocation = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed("processed" as const))
      .mockReturnValueOnce(
        Effect.fail(
          new RetryableJobError({
            cause: "ProviderAdapterError",
            message: "provider_transient: provider request failed",
          }),
        ),
      );
    const handler = createAutomationHandler({
      channelRevocationProcessor: processChannelRevocation,
    });
    const body: OutboxMessage = {
      aggregate_id: "00000000-0000-4000-8000-000000000002",
      event_id: "00000000-0000-4000-8000-0000000000aa",
      organization_id: "00000000-0000-4000-8000-000000000001",
      payload: {
        access_token: "enc:ciphertext-token",
        brand_profile_id: "00000000-0000-4000-8000-000000000003",
        platform: "tiktok",
        platform_account_id: "00000000-0000-4000-8000-000000000002",
      },
      topic: "channel.revocation.requested",
      type: "outbox.event",
      version: 1,
    };
    const batch = createMessageBatch("meltiply-channel-revocation-test", [
      {
        attempts: 1,
        body,
        id: "revocation-success",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        attempts: 2,
        body: { ...body, event_id: "00000000-0000-4000-8000-0000000000bb" },
        id: "revocation-retry",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const context = createExecutionContext();
    await handler.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toEqual(["revocation-success"]);
    expect(result.retryMessages).toEqual([{ msgId: "revocation-retry" }]);
    expect(processChannelRevocation).toHaveBeenCalledTimes(2);
  });
});

describe("automation queue duplicate delivery", () => {
  const automationEnv: AutomationEnv = { ...env };
  const body = {
    aggregate_id: "00000000-0000-4000-8000-000000000001",
    event_id: "00000000-0000-4000-8000-000000000101",
    organization_id: "00000000-0000-4000-8000-000000000201",
    payload: {
      asset_id: "00000000-0000-4000-8000-000000000001",
    },
    topic: "asset.processing.requested",
    type: "outbox.event",
    version: 1,
  } as const;

  function batch(messageId: string) {
    return createMessageBatch("meltiply-asset-processing-test", [
      {
        attempts: 1,
        body,
        id: messageId,
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
  }

  it("acks a redelivered message without retrying it", async () => {
    const process = vi.fn().mockReturnValue(Effect.succeed("processed" as const));
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process,
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
    });

    const first = batch("asset-duplicate");
    const firstContext = createExecutionContext();
    await handler.queue?.(first, automationEnv, firstContext);
    expect(await getQueueResult(first, firstContext)).toMatchObject({
      explicitAcks: ["asset-duplicate"],
      retryMessages: [],
    });

    const second = batch("asset-duplicate");
    const secondContext = createExecutionContext();
    await handler.queue?.(second, automationEnv, secondContext);
    expect(await getQueueResult(second, secondContext)).toMatchObject({
      explicitAcks: ["asset-duplicate"],
      retryMessages: [],
    });
  });

  it("retries a transport TypeError and acks the redelivery on success", async () => {
    const process = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(classifyJobError(new TypeError("fetch failed"))))
      .mockReturnValueOnce(Effect.succeed("processed" as const));
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process,
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
    });

    const first = batch("asset-flaky");
    const firstContext = createExecutionContext();
    await handler.queue?.(first, automationEnv, firstContext);
    expect(await getQueueResult(first, firstContext)).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: "asset-flaky" }],
    });

    const second = batch("asset-flaky");
    const secondContext = createExecutionContext();
    await handler.queue?.(second, automationEnv, secondContext);
    expect(await getQueueResult(second, secondContext)).toMatchObject({
      explicitAcks: ["asset-flaky"],
      retryMessages: [],
    });
  });

  it("retries failed queue publishing and acks a successful redelivery", async () => {
    const destination = {
      metrics: vi.fn(),
      send: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(undefined),
      sendBatch: vi.fn(),
    } satisfies Queue<unknown>;
    const layers = Layer.merge(
      createPublishQueueResolverLive(() => destination),
      createQueuePublisherLive(),
    );
    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: () =>
          Effect.mapError(
            Effect.provide(
              Effect.gen(function* () {
                const resolver = yield* PublishQueueResolver;
                const publisher = yield* QueuePublisher;
                const queue = yield* resolver.queueFor("threads");
                yield* publisher.send(queue, body);
                return "processed" as const;
              }),
              layers,
            ),
            classifyJobError,
          ),
        runMaintenance: vi.fn(idleAssetMaintenance),
      }),
    });

    const first = batch("publish-failed");
    const firstContext = createExecutionContext();
    await handler.queue?.(first, automationEnv, firstContext);
    expect(await getQueueResult(first, firstContext)).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: "publish-failed" }],
    });

    const second = batch("publish-failed");
    const secondContext = createExecutionContext();
    await handler.queue?.(second, automationEnv, secondContext);
    expect(await getQueueResult(second, secondContext)).toMatchObject({
      explicitAcks: ["publish-failed"],
      retryMessages: [],
    });
  });

  it.each(["routing", "send", "sendBatch"] as const)(
    "retries work when test %s is unconfigured",
    async (missing) => {
      const destination = {
        metrics: vi.fn(),
        send: vi.fn(),
        sendBatch: vi.fn(),
      } satisfies Queue<unknown>;
      const layers = Layer.merge(
        createPublishQueueResolverTest(
          missing === "routing"
            ? undefined
            : {
                queueFor: () => Effect.succeed(destination),
              },
        ),
        createQueuePublisherTest(
          missing === "send" ? { sendBatch: () => Effect.void } : { send: () => Effect.void },
        ),
      );
      const handler = createAutomationHandler({
        assetProcessorFor: () => ({
          process: () =>
            Effect.mapError(
              Effect.provide(
                Effect.gen(function* () {
                  const resolver = yield* PublishQueueResolver;
                  const publisher = yield* QueuePublisher;
                  const queue = yield* resolver.queueFor("threads");
                  if (missing === "sendBatch") {
                    yield* publisher.sendBatch(queue, [{ body }]);
                  } else {
                    yield* publisher.send(queue, body);
                  }
                  return "processed" as const;
                }),
                layers,
              ),
              classifyJobError,
            ),
          runMaintenance: vi.fn(idleAssetMaintenance),
        }),
      });
      const delivery = batch("unconfigured");
      const context = createExecutionContext();
      await handler.queue?.(delivery, automationEnv, context);
      expect(await getQueueResult(delivery, context)).toMatchObject({
        explicitAcks: [],
        retryMessages: [{ msgId: "unconfigured" }],
      });
    },
  );
});
