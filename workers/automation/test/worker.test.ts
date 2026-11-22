import { Effect } from "effect";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderOperationResult,
} from "@meltiply/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import {
  distributionProcessingGraceSeconds,
  enqueueDueDistributions,
  processDistributionMessage,
  sweepDueDistributions,
  type DistributionProcessingDependencies,
} from "../src/distribution";
import { maximumDelayedDeliverySeconds, overdueRecoveryGraceSeconds } from "../src/due-work";
import { classifyJobError, createQueuePublisherLive } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { createAutomationHandler } from "../src/index";
import { sweepDueProviderJobs } from "../src/provider-sync";
import { logRecords } from "./log-records";
import {
  fakeProviderAdapter,
  fakeProviderRegistry,
  fakeReplyWorkflow,
  fakeTransactionClient,
} from "./test-doubles";

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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
      }),
      relay: () => Effect.fail(classifyJobError(new TypeError("password=private-cron-value"))),
    });

    await expect(
      handler.scheduled?.(
        {
          cron: "0 * * * *",
          noRetry: vi.fn(),
          scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
        },
        env,
        createExecutionContext(),
      ),
    ).rejects.toThrow("private-cron-value");
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

    await expect(handler.scheduled(undefined, env, createExecutionContext())).rejects.toThrow(
      "private-cron-value",
    );

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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
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
    await expect(handler.scheduled(undefined, env, createExecutionContext())).rejects.toThrow(
      "distribution scan failed",
    );

    expect(error).toHaveBeenCalledTimes(2);
    const reportedWork = logRecords(error).map(
      (record) => (record.context as { scheduled_work?: unknown } | undefined)?.scheduled_work,
    );
    expect(reportedWork).toEqual(["due-distribution-scan", "provider-sync-sweep"]);
    expect(runRetention).toHaveBeenCalledWith(env);
  });
});

describe("Distribution message processing", () => {
  const distributionId = "00000000-0000-4000-8000-000000000001";
  const organizationId = "00000000-0000-4000-8000-000000000002";

  function publishMessage() {
    return {
      aggregate_id: distributionId,
      event_id: "00000000-0000-4000-8000-000000000104",
      organization_id: organizationId,
      payload: { distribution_id: distributionId },
      topic: "distribution.publish.requested" as const,
      type: "outbox.event" as const,
      version: 1 as const,
    };
  }

  function scheduledRow(scheduledAt: Date): Record<string, unknown> {
    return {
      access_token: "encrypted-access",
      attempt_count: 0,
      attachment_ids: null,
      connection_status: "connected",
      description_override: null,
      hashtags: [],
      id: distributionId,
      media: [
        {
          asset_id: "00000000-0000-4000-8000-000000000010",
          asset_type: "video",
          candidates: [
            {
              content_type: "video/mp4",
              duration_sec: 30,
              etag: "etag-rendition",
              file_size: 1_024,
              height: 1080,
              object_id: "00000000-0000-4000-8000-000000000030",
              object_key: `${organizationId}/00000000-0000-4000-8000-000000000010/rendition.mp4`,
              width: 1920,
            },
          ],
          content_type: "video/mp4",
          duration_sec: 30,
          file_size: 1_024,
          height: 1080,
          position: 0,
          width: 1920,
        },
      ],
      org_id: organizationId,
      plan: "free",
      platform: "threads",
      platform_account_id: "00000000-0000-4000-8000-000000000020",
      platform_post_id: null,
      platform_user_id: "user-threads",
      post_default_text: "Hello",
      post_id: "00000000-0000-4000-8000-000000000011",
      post_title: "Launch Post",
      provider_operation_id: null,
      provider_options: null,
      provider_poll_attempts: 0,
      reconciliation_attempt_count: 0,
      scheduled_at: scheduledAt,
      status: "scheduled",
      title_override: null,
      token_expires_at: null,
    };
  }

  function frozenMediaResolver() {
    return vi.fn(async () => ({
      contentType: "video/mp4",
      fileSize: 1_024,
      mode: "remote_ingest" as const,
      url: "https://r2.example/signed-object",
    }));
  }

  type RecordingQuery = (
    sql: string,
    params?: unknown[],
  ) => Effect.Effect<{ rowCount: number; rows: Record<string, unknown>[] }, never>;

  function recordingTransaction(
    query: RecordingQuery,
    onCall?: () => void,
  ): NonNullable<DistributionProcessingDependencies["transaction"]> {
    const client = fakeTransactionClient((sql, params) =>
      query(sql, params ? [...params] : undefined),
    );
    return (_env, operation) => {
      onCall?.();
      return operation(client);
    };
  }

  it("records outcomes through an injectable transaction", async () => {
    const query = vi.fn((sql: string) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              access_token: "encrypted-access",
              attempt_count: 0,
              attachment_ids: null,
              id: "00000000-0000-4000-8000-000000000001",
              media: [],
              org_id: "00000000-0000-4000-8000-000000000002",
              platform: "threads",
              platform_account_id: null,
              platform_post_id: null,
              platform_user_id: null,
              provider_operation_id: null,
              reconciliation_attempt_count: 0,
              status: "cancel_requested",
              token_expires_at: null,
            },
          ],
        });
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });
    const transactionCalls = vi.fn();
    const transaction = recordingTransaction(query, transactionCalls);

    const result = await Effect.runPromise(
      processDistributionMessage(
        env,
        {
          aggregate_id: "00000000-0000-4000-8000-000000000001",
          event_id: "00000000-0000-4000-8000-000000000103",
          organization_id: "00000000-0000-4000-8000-000000000002",
          payload: {},
          topic: "distribution.cancel.requested",
          type: "outbox.event" as const,
          version: 1 as const,
        },
        {
          providerRegistry: new ProviderRegistry(),
          transaction,
        },
      ),
    );

    expect(result).toBe("processed");
    expect(transactionCalls).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("UPDATE provider_operations")),
    ).toBe(true);
  });

  it("reconciles a stalled in-progress distribution after worker loss instead of publishing again", async () => {
    const distributionState: {
      attempt_count: number;
      failure_code: string | null;
      failure_retryable: boolean | null;
      platform_post_id: string | null;
      provider_operation_id: string | null;
      reconciliation_attempt_count: number;
      status: string;
      updated_at: Date;
    } = {
      attempt_count: 0,
      failure_code: null,
      failure_retryable: null,
      platform_post_id: null,
      provider_operation_id: null,
      reconciliation_attempt_count: 0,
      status: "queued",
      updated_at: new Date("2026-01-01T00:00:00Z"),
    };
    const outboxEvents: Array<{
      aggregate_id: string;
      dedupe_key: string;
      id: string;
      topic: string;
    }> = [];

    const query = vi.fn((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              access_token: "encrypted-access",
              attempt_count: distributionState.attempt_count,
              attachment_ids: null,
              connection_status: "connected",
              description_override: null,
              hashtags: [],
              id: "00000000-0000-4000-8000-000000000001",
              media: [
                {
                  asset_id: "00000000-0000-4000-8000-000000000010",
                  asset_type: "video",
                  candidates: [
                    {
                      content_type: "video/mp4",
                      duration_sec: 30,
                      etag: "etag-rendition",
                      file_size: 1_024,
                      height: 1080,
                      object_id: "00000000-0000-4000-8000-000000000030",
                      object_key:
                        "20000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000010/vid1.mp4",
                      width: 1920,
                    },
                  ],
                  content_type: "video/mp4",
                  duration_sec: 30,
                  file_size: 1_024,
                  height: 1080,
                  position: 0,
                  width: 1920,
                },
              ],
              org_id: "00000000-0000-4000-8000-000000000002",
              plan: "creator",
              platform: "youtube",
              platform_account_id: "00000000-0000-4000-8000-000000000020",
              platform_post_id: distributionState.platform_post_id,
              platform_user_id: "user-yt",
              post_default_text: "Test body",
              post_id: "00000000-0000-4000-8000-000000000011",
              post_title: "Test Title",
              provider_operation_id: distributionState.provider_operation_id,
              provider_options: null,
              provider_poll_attempts: 0,
              reconciliation_attempt_count: distributionState.reconciliation_attempt_count,
              scheduled_at: new Date("2026-08-24T00:00:00Z"),
              status: distributionState.status,
              title_override: null,
              token_expires_at: null,
            },
          ],
        });
      }
      if (sql.includes("UPDATE distributions") && sql.includes("SET status = CASE")) {
        if (sql.includes("WHEN $2 = 'publish' THEN 'processing'")) {
          if (params?.[1] === "publish") {
            distributionState.status = "processing";
            distributionState.attempt_count += 1;
          } else if (params?.[1] === "reconcile") {
            distributionState.reconciliation_attempt_count += 1;
          }
          return Effect.succeed({ rowCount: 1, rows: [] });
        }
        if (sql.includes("WHEN status = 'cancel_requested' THEN status ELSE $2")) {
          distributionState.status = params?.[1] as string;
          distributionState.platform_post_id =
            (params?.[3] as string | null) ?? distributionState.platform_post_id;
          distributionState.failure_code = (params?.[5] as string | null) ?? null;
          distributionState.failure_retryable = (params?.[6] as boolean | null) ?? null;
          return Effect.succeed({
            rowCount: 1,
            rows: [{ analytics_event_id: null, comments_event_id: null }],
          });
        }
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      if (sql.includes("UPDATE provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (
        sql.includes("WITH due AS") &&
        sql.includes("INSERT INTO outbox_events") &&
        sql.includes("status = 'processing'")
      ) {
        const graceSeconds = (params?.[1] as number) ?? distributionProcessingGraceSeconds;
        expect(graceSeconds).toBe(300);
        if (distributionState.status === "processing") {
          distributionState.status = "needs_reconciliation";
          distributionState.failure_code = "provider_outcome_ambiguous";
          distributionState.failure_retryable = false;
          outboxEvents.push({
            aggregate_id: "00000000-0000-4000-8000-000000000001",
            dedupe_key: `distribution:00000000-0000-4000-8000-000000000001:reconcile:${distributionState.reconciliation_attempt_count + 1}`,
            id: "event-reconcile-1",
            topic: "distribution.reconcile.requested",
          });
          return Effect.succeed({
            rowCount: 1,
            rows: [{ claimed_count: 1, inserted_count: 1 }],
          });
        }
        return Effect.succeed({
          rowCount: 1,
          rows: [{ claimed_count: 0, inserted_count: 0 }],
        });
      }
      if (sql.includes("INSERT INTO outbox_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    let shouldFail = true;
    let transactionCalls = 0;
    const transaction: NonNullable<DistributionProcessingDependencies["transaction"]> = <A, E, R>(
      _env: AutomationEnv,
      operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      transactionCalls += 1;
      if (shouldFail && transactionCalls === 2) {
        return Effect.die(new Error("simulated queue handler crash"));
      }
      return operation(
        fakeTransactionClient((sql, params) => query(sql, params ? [...params] : undefined)),
      );
    };

    withSystemTransactionEffect.mockImplementation(transaction);

    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-recovered",
      providerUrl: "https://youtube.example/post-recovered",
    }));
    const lookupPublication = vi.fn(async () => ({
      state: "not_found" as const,
    }));
    const mockProviderRegistry = new ProviderRegistry();
    mockProviderRegistry.register("youtube", {
      capability: {
        accepted_mime_types: ["video/mp4"],
        analytics: false,
        asset_types: ["video"],
        comments: false,
        connect_available: false,
        max_caption_length: 5_000,
        max_file_size: 25 * 1024 * 1024,
        max_hashtags: 15,
        max_media_count: null,
        max_video_duration_sec: 180,
        min_media_count: null,
        multi_asset_types: [],
        notes: [],
        platform: "youtube",
        publish: true,
        reply: false,
      },
      lookupPublication,
      publish,
      retryPolicy: {
        baseDelaySeconds: 15,
        maxAttempts: 5,
        maxDelaySeconds: 300,
      },
      transferModes: ["remote_ingest"],
    });

    const initialMessage = {
      aggregate_id: "00000000-0000-4000-8000-000000000001",
      event_id: "00000000-0000-4000-8000-000000000101",
      organization_id: "00000000-0000-4000-8000-000000000002",
      payload: { distribution_id: "00000000-0000-4000-8000-000000000001" },
      topic: "distribution.publish.requested",
      type: "outbox.event" as const,
      version: 1 as const,
    };

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, initialMessage, {
          decryptToken: async () => "token",
          mediaFor: async () => ({
            contentType: "video/mp4",
            fileSize: 1024,
            mode: "remote_ingest" as const,
            url: "https://r2.example/video.mp4",
          }),
          providerRegistry: mockProviderRegistry,
          transaction,
        }),
      ),
    ).rejects.toThrow("simulated queue handler crash");

    expect(distributionState.status).toBe("processing");
    expect(distributionState.attempt_count).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);

    const handler = createAutomationHandler({
      assetProcessorFor: () => ({
        process: vi.fn(() => Effect.succeed("processed" as const)),
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
      }),
      enqueueDue: (automationEnv) => enqueueDueDistributions(automationEnv),
      sweepProviderDue: () =>
        Effect.succeed({
          analytics: 0,
          comments: 0,
          token_refresh: 0,
        }),
    });
    await handler.scheduled?.(
      {
        cron: "0 * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      createExecutionContext(),
    );

    expect(distributionState.status).toBe("needs_reconciliation");
    expect(distributionState.failure_code).toBe("provider_outcome_ambiguous");
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.topic).toBe("distribution.reconcile.requested");
    expect(outboxEvents[0]?.dedupe_key).toBe(
      "distribution:00000000-0000-4000-8000-000000000001:reconcile:1",
    );

    shouldFail = false;
    const reconcileMessage = {
      aggregate_id: "00000000-0000-4000-8000-000000000001",
      event_id: "00000000-0000-4000-8000-000000000102",
      organization_id: "00000000-0000-4000-8000-000000000002",
      payload: { distribution_id: "00000000-0000-4000-8000-000000000001" },
      topic: "distribution.reconcile.requested",
      type: "outbox.event" as const,
      version: 1 as const,
    };

    const outcome = await Effect.runPromise(
      processDistributionMessage(env, reconcileMessage, {
        decryptToken: async () => "token",
        providerRegistry: mockProviderRegistry,
        transaction,
      }),
    );

    expect(outcome).toBe("processed");
    expect(lookupPublication).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(distributionState.status).toBe("failed");
    expect(distributionState.failure_code).toBe("provider_lookup_evidence_unavailable");
  });

  it("binds the processing grace and the delivery horizon into the due claim", async () => {
    const query = vi.fn((_sql: string, params?: unknown[]) => {
      expect(params).toEqual([
        100,
        distributionProcessingGraceSeconds,
        maximumDelayedDeliverySeconds,
      ]);
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

    const claimed = await Effect.runPromise(enqueueDueDistributions(env));
    expect(claimed).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails a reconciliation delivery terminally when the lookup failure is not retryable", async () => {
    const updates: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              ...scheduledRow(new Date("2026-08-24T00:00:00Z")),
              provider_operation_id: "operation-1",
              reconciliation_attempt_count: 2,
              status: "needs_reconciliation",
            },
          ],
        });
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      if (
        sql.includes("UPDATE distributions") &&
        sql.includes("WHEN status = 'cancel_requested' THEN status ELSE $2")
      ) {
        updates.push({ params, sql });
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              analytics_event_id: null,
              comments_event_id: null,
              reconciliation_attempt_count: 3,
              status: "failed",
            },
          ],
        });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    const outcome = await Effect.runPromise(
      processDistributionMessage(
        env,
        {
          aggregate_id: distributionId,
          event_id: "00000000-0000-4000-8000-000000000105",
          organization_id: organizationId,
          payload: { distribution_id: distributionId },
          topic: "distribution.reconcile.requested",
          type: "outbox.event" as const,
          version: 1 as const,
        },
        {
          decryptToken: async () => "token",
          providerRegistry: fakeProviderRegistry({
            threads: fakeProviderAdapter("threads", {
              retryPolicy: {
                baseDelaySeconds: 60,
                maxAttempts: 5,
                maxDelaySeconds: 3_600,
              },
            }),
          }),
          transaction: recordingTransaction(query),
        },
      ),
    );

    expect(outcome).toBe("processed");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params?.[1]).toBe("failed");
    expect(updates[0]?.params?.[5]).toBe("provider_lookup_unavailable");
    expect(updates[0]?.params?.[8]).toBeNull();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO outbox_events")),
    ).toBe(false);
  });

  it("arms the next reconcile trigger with the scanner dedupe key format", async () => {
    const outboxInserts: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              ...scheduledRow(new Date("2026-08-24T00:00:00Z")),
              provider_operation_id: "operation-1",
              provider_poll_attempts: 0,
              reconciliation_attempt_count: 3,
              status: "needs_reconciliation",
            },
          ],
        });
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      if (
        sql.includes("UPDATE distributions") &&
        sql.includes("WHEN status = 'cancel_requested' THEN status ELSE $2")
      ) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              analytics_event_id: null,
              comments_event_id: null,
              reconciliation_attempt_count: 4,
              status: "needs_reconciliation",
            },
          ],
        });
      }
      if (sql.includes("INSERT INTO outbox_events")) {
        outboxInserts.push({ params, sql });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    const lookupPublication = vi.fn(async () => ({
      result: {
        failure: {
          classification: "ambiguous" as const,
          code: "provider_outcome_ambiguous",
          message: "The provider outcome is ambiguous.",
          retryable: false,
        },
        outcome: "unknown" as const,
      },
      state: "unknown" as const,
    }));
    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: 5,
        max_media_count: null,
        max_video_duration_sec: null,
        min_media_count: null,
        multi_asset_types: [],
        notes: [],
        platform: "threads",
        publish: true,
        reply: false,
      },
      lookupPublication,
      publish: vi.fn(async () => ({ outcome: "confirmed_success" as const })),
      retryPolicy: {
        baseDelaySeconds: 60,
        maxAttempts: 10,
        maxDelaySeconds: 3_600,
      },
      transferModes: ["remote_ingest"],
    });

    const outcome = await Effect.runPromise(
      processDistributionMessage(
        env,
        {
          aggregate_id: distributionId,
          event_id: "00000000-0000-4000-8000-000000000106",
          organization_id: organizationId,
          payload: { distribution_id: distributionId },
          topic: "distribution.reconcile.requested",
          type: "outbox.event" as const,
          version: 1 as const,
        },
        {
          decryptToken: async () => "token",
          providerRegistry: registry,
          random: () => 0.5,
          transaction: recordingTransaction(query),
        },
      ),
    );

    expect(outcome).toBe("processed");
    expect(lookupPublication).toHaveBeenCalledTimes(1);
    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0]?.params?.[4]).toBe(`distribution:${distributionId}:reconcile:5`);
  });
  it("publishes a due scheduled row exactly once from its delayed trigger", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const state = { attempt_count: 0, status: "scheduled" };
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-scheduled",
      providerUrl: "https://threads.example/post-scheduled",
    }));
    const query = vi.fn((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              ...scheduledRow(new Date(now.getTime() - 1_000)),
              attempt_count: state.attempt_count,
              status: state.status,
            },
          ],
        });
      }
      if (sql.includes("UPDATE distributions") && sql.includes("SET status = CASE")) {
        if (sql.includes("WHEN $2 = 'publish' THEN 'processing'")) {
          state.status = "processing";
          state.attempt_count += 1;
        }
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (params && params.includes("publish")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    const result = await Effect.runPromise(
      processDistributionMessage(env, publishMessage(), {
        decryptToken: async () => "token",
        mediaFor: frozenMediaResolver(),
        now: () => now,
        providerRegistry: threadsRegistry(publish),
        transaction: recordingTransaction(query),
      }),
    );

    expect(result).toBe("processed");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("processing");
    expect(state.attempt_count).toBe(1);
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO provider_operations")),
    ).toHaveLength(1);
  });

  function threadsRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
    return fakeProviderRegistry({
      threads: fakeProviderAdapter("threads", {
        capability: {
          ...fakeProviderAdapter("threads").capability,
          accepted_mime_types: ["video/mp4"],
          analytics: false,
          asset_types: ["image", "video"],
          comments: false,
          connect_available: false,
          max_caption_length: 500,
          max_file_size: null,
          max_hashtags: 5,
          max_media_count: null,
          max_video_duration_sec: null,
          min_media_count: null,
          multi_asset_types: [],
          notes: [],
          platform: "threads",
          publish: true,
          reply: false,
        },
        lookupPublication: async () => ({ state: "not_found" }),
        publish,
        retryPolicy: {
          baseDelaySeconds: 60,
          maxAttempts: 5,
          maxDelaySeconds: 3_600,
        },
        transferModes: ["remote_ingest"],
      }),
    });
  }

  async function publishAgainstBudget(
    now: Date,
    budget: Record<string, unknown> | null,
    publishResult: ProviderOperationResult = {
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    },
  ) {
    const publish = vi.fn(async () => publishResult);
    const decryptToken = vi.fn(async () => "token");
    const respond: RecordingQuery = (sql) => {
      if (sql.includes("INSERT INTO async_job_events")) {
        return Effect.succeed({ rowCount: 1, rows: [] });
      }
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              ...scheduledRow(new Date(now.getTime() - 1_000)),
              attempt_count: 2,
              status: "queued",
            },
          ],
        });
      }
      if (sql.includes("FROM rate_limit_budgets")) {
        return Effect.succeed({
          rowCount: budget ? 1 : 0,
          rows: budget ? [budget] : [],
        });
      }
      if (sql.includes("INSERT INTO provider_operations")) {
        return Effect.succeed({ rowCount: 1, rows: [{ id: "op-1" }] });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    };
    const query = vi.fn(respond);
    const outcome = await Effect.runPromise(
      processDistributionMessage(env, publishMessage(), {
        decryptToken,
        mediaFor: frozenMediaResolver(),
        now: () => now,
        providerRegistry: threadsRegistry(publish),
        transaction: recordingTransaction(query),
      }),
    );
    return { decryptToken, outcome, publish, query };
  }

  it("parks a publish while the cached rate limit budget is exhausted", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const { decryptToken, outcome, publish, query } = await publishAgainstBudget(now, {
      percent_used: 100,
      remaining: 0,
      resets_at: new Date(now.getTime() + 5_400_000),
    });

    expect(outcome).toBe("skipped");
    expect(publish).not.toHaveBeenCalled();
    expect(decryptToken).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO provider_operations")),
    ).toBe(false);
    const park = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("SET status = 'queued'") && String(sql).includes("next_attempt_at"),
    );
    expect(park?.[0]).not.toMatch(/attempt_count = attempt_count \+ 1/);
    expect(park?.[0]).toMatch(/status = 'queued'/);
    expect(park?.[0]).toMatch(/failure_code = NULL/);
    expect(park?.[1]).toEqual([distributionId, 3_600]);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes("INSERT INTO outbox_events") &&
          Array.isArray(params) &&
          params[1] === "distribution.publish.requested",
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes("UPDATE async_job_events") &&
          Array.isArray(params) &&
          params[1] === "skipped",
      ),
    ).toBe(true);
  });

  it("publishes while the cached rate limit budget keeps headroom", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const { outcome, publish, query } = await publishAgainstBudget(now, {
      percent_used: 40,
      remaining: 50,
      resets_at: new Date(now.getTime() + 600_000),
    });

    expect(outcome).toBe("processed");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("failure_code = 'rate_limit_budget_exhausted'"),
      ),
    ).toBe(false);
  });

  it("caches the throttle window when a publish confirms a rate limit failure", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const { outcome, query } = await publishAgainstBudget(now, null, {
      failure: {
        classification: "rate_limit" as const,
        code: "rate_limit",
        message: "Too many requests.",
        retryAfterSeconds: 900,
        retryable: true,
      },
      outcome: "confirmed_failure" as const,
    });

    expect(outcome).toBe("processed");
    const cached = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO rate_limit_budgets"),
    );
    expect(cached?.[1]).toEqual(["threads", "user-threads", 0, 100, 900]);
  });

  it("no-ops an early delivery after a schedule moved later", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const query = vi.fn((sql: string) => {
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              id: distributionId,
              org_id: organizationId,
              status: "scheduled",
              scheduled_at: new Date(now.getTime() + 3_600_000),
            },
          ],
        });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });
    const transactionCalls = vi.fn();
    const transaction = recordingTransaction(query, transactionCalls);

    const result = await Effect.runPromise(
      processDistributionMessage(env, publishMessage(), {
        now: () => now,
        providerRegistry: new ProviderRegistry(),
        transaction,
      }),
    );

    expect(result).toBe("skipped");
    expect(transactionCalls).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO provider_operations")),
    ).toBe(false);
  });

  it("no-ops a queued delivery for a cancelled distribution", async () => {
    const now = new Date("2026-08-24T00:00:00Z");
    const query = vi.fn((sql: string) => {
      if (sql.includes("FROM distributions AS distribution")) {
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              id: distributionId,
              org_id: organizationId,
              status: "cancelled",
              scheduled_at: new Date(now.getTime() - 1_000),
            },
          ],
        });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    const result = await Effect.runPromise(
      processDistributionMessage(env, publishMessage(), {
        now: () => now,
        providerRegistry: new ProviderRegistry(),
        transaction: recordingTransaction(query),
      }),
    );

    expect(result).toBe("skipped");
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO provider_operations")),
    ).toBe(false);
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
        rowCount: 0,
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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
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

    await handler.scheduled?.(
      {
        cron: "* * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      createExecutionContext(),
    );
    expect(executedQueries).toHaveLength(0);

    await handler.scheduled?.(
      {
        cron: "0 * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      createExecutionContext(),
    );

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
        runMaintenance: vi.fn(() =>
          Effect.succeed({
            cleanup_errors: 0,
            expired_sessions: 0,
            orphan_assets_claimed: 0,
            reconciliation_events: 0,
            stale_writing_objects_deleted: 0,
            terminal_sessions_reclaimed: 0,
            usage_rows: 0,
          }),
        ),
      }),
      enqueueDue: vi.fn(() => Effect.succeed(0)),
      enqueueDueReplyReconciliations: vi.fn(() => Effect.succeed(0)),
      sweepAccountAnalytics: vi.fn(() => Effect.succeed({ failed: 0, recorded: 0, scanned: 0 })),
      sweepProviderDue: vi.fn(() =>
        Effect.succeed({
          analytics: 0,
          comments: 0,
          token_refresh: 0,
        }),
      ),
      runRetention: vi.fn(() => Effect.succeed({ deleted: 0, errors: 0 })),
    });

    await handler.scheduled?.(
      {
        cron: "0 * * * *",
        noRetry: vi.fn(),
        scheduledTime: base,
      },
      { ...env, FACEBOOK_PUBLISH_QUEUE: recordedQueue } as typeof env,
      createExecutionContext(),
    );

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

describe("Hourly distribution recovery sweep", () => {
  it("claims overdue scheduled rows in one bound statement and returns its count", async () => {
    const executedQueries: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      executedQueries.push({ params, sql });
      return Effect.succeed({
        rowCount: 1,
        rows: [{ claimed_count: 2 }],
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

    const count = await Effect.runPromise(sweepDueDistributions(env));
    expect(count).toBe(2);

    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0]?.params).toEqual([
      100,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);
  });

  it("accepts custom bounds and thresholds", async () => {
    const executedQueries: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      executedQueries.push({ params, sql });
      return Effect.succeed({
        rowCount: 1,
        rows: [{ claimed_count: 0 }],
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

    await Effect.runPromise(sweepDueDistributions(env, 42, 600, 43_200));
    expect(executedQueries[0]?.params).toEqual([42, 600, 43_200]);
  });
});
