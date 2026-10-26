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

const worker = createAutomationHandler();
beforeEach(() => {
  // Unoverridden hourly units still run their production queries in the
  // scheduled tests; an empty result keeps that work from throwing.
  withSystemTransactionEffect.mockReturnValue(Effect.succeed({ rows: [] }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Registry whose single adapter is eligible for every provider sync workload, so
 * the hourly sweep issues its analytics, comments and token refresh claims.
 */
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
    const workflowEnv = {
      ...env,
      REPLY_WORKFLOW: { createBatch },
    } as unknown as typeof env;

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
    // Un-overridden units run their production claim queries; the canned
    // transaction reports zero claimed rows so only the relay unit fails.
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation({
          query: vi.fn(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        } as unknown as EffectTransactionClient),
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
    // The un-overridden distribution-sweep unit runs its production claim
    // query; the canned transaction reports zero claimed rows so it succeeds.
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation({
          query: vi.fn(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        } as unknown as EffectTransactionClient),
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
    });

    await expect(
      handler.scheduled?.(
        undefined as unknown as ScheduledController,
        env,
        createExecutionContext(),
      ),
    ).rejects.toThrow("private-cron-value");

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
    // The un-overridden distribution-sweep unit runs its production claim
    // query; the canned transaction reports zero claimed rows so it succeeds.
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> =>
        operation({
          query: vi.fn(() =>
            Effect.succeed({
              rowCount: 0,
              rows: [{ claimed_count: 0, inserted_count: 0 }],
            }),
          ),
        } as unknown as EffectTransactionClient),
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
    });
    await expect(
      handler.scheduled?.(
        undefined as unknown as ScheduledController,
        env,
        createExecutionContext(),
      ),
    ).rejects.toThrow("distribution scan failed");

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

  /**
   * A durable `scheduled` row as the consumer re-reads it under lock. A
   * Distribution no longer embeds one Asset's identity: it names its Post and
   * carries the resolved ordered `media` candidates frozen at claim time, so
   * later Post edits cannot mutate the attempt.
   */
  function scheduledRow(scheduledAt: Date): Record<string, unknown> {
    return {
      access_token: "encrypted-access",
      attempt_count: 0,
      attachment_ids: null,
      billing_status: "active",
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

  /**
   * Resolver stub for the frozen `video/mp4` object `scheduledRow` carries. The
   * publish path refuses a descriptor whose MIME type, byte length, transfer
   * mode, or delivery URL disagrees with the frozen object, so the stub has to
   * answer with exactly those verified facts.
   */
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
  ) => Effect.Effect<{ rowCount: number; rows: unknown[] }, unknown>;

  function recordingTransaction(
    query: RecordingQuery,
  ): NonNullable<DistributionProcessingDependencies["transaction"]> {
    const transaction: NonNullable<DistributionProcessingDependencies["transaction"]> = <A, E, R>(
      _env: AutomationEnv,
      operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient);
    return vi.fn(transaction) as unknown as NonNullable<
      DistributionProcessingDependencies["transaction"]
    >;
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
              // The claim query coalesces composition.media to '[]', so a real
              // claim row always carries a non-null media array.
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
    const transaction = vi.fn(
      <A, E, R>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
    );

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
          providerRegistry: {
            get: () => undefined,
          } as unknown as ProviderRegistry,
          transaction: transaction as unknown as NonNullable<
            DistributionProcessingDependencies["transaction"]
          >,
        },
      ),
    );

    expect(result).toBe("processed");
    // One transaction for lease claiming plus one for outcome recording.
    expect(transaction).toHaveBeenCalledTimes(2);
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
      // The crash drops the provider operation identity before it is persisted,
      // so the stalled row carries no lookup evidence.
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
              billing_status: "active",
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
          // The prepare transition shares one statement for every operation;
          // the bound operation parameter decides which counter moves.
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
          // The stalled claim must arm reconciliation, never a fresh publish.
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
      // First transaction is prepare (updates status to 'processing' and increments attempt_count)
      // Second transaction during initial attempt fails (simulating crash during outcome recording)
      if (shouldFail && transactionCalls === 2) {
        return Effect.die(new Error("simulated queue handler crash"));
      }
      return operation({ query } as unknown as EffectTransactionClient);
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
    // The fixture mirrors the production ProviderAdapter contract: the
    // capability descriptor and transfer modes are what validateTarget and the
    // media resolver read before the adapter's publish is invoked, so the
    // simulated crash lands on outcome recording after exactly one publish.
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

    // The stalled scan must move the row to reconciliation and arm a reconcile
    // trigger — never reset to queued or emit a second publish command.
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

    // Reconciliation runs through the durable reconcile trigger; with no
    // persisted provider evidence the outcome is a terminal, actionable
    // failure — and the publish adapter is never invoked a second time.
    expect(outcome).toBe("processed");
    expect(lookupPublication).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(distributionState.status).toBe("failed");
    expect(distributionState.failure_code).toBe("provider_lookup_evidence_unavailable");
  });

  it("protects active processing distributions inside the grace period", async () => {
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
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
    );

    const claimed = await Effect.runPromise(enqueueDueDistributions(env));
    expect(claimed).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /status = 'processing'[\s\S]+updated_at <= now\(\) - \(\$2 \* INTERVAL '1 second'\)/,
    );
  });
  it("keeps a lost reconcile trigger recoverable through the claim statement", async () => {
    const executedQueries: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      executedQueries.push({ params, sql });
      return Effect.succeed({
        rowCount: 1,
        rows: [{ claimed_count: 0, inserted_count: 0 }],
      });
    });
    withSystemTransactionEffect.mockImplementation(
      <A, E, R>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
    );

    await Effect.runPromise(enqueueDueDistributions(env));
    const sql = executedQueries[0]?.sql ?? "";

    // The claim clears next_attempt_at once a reconcile event is armed, so a
    // reconcile-eligible row whose armed event can no longer deliver must stay
    // claimable through the missing-live-event fallback (#256).
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("e.topic = 'distribution.reconcile.requested'");
    expect(sql).toContain("e.state IN ('pending', 'leased', 'failed')");
    // A dedupe-key conflict against a dead or stale-published event revives it
    // as pending with a fresh attempt budget instead of stranding the row.
    expect(sql).toContain("ON CONFLICT (org_id, topic, dedupe_key) DO UPDATE");
    expect(sql).toContain("outbox_events.state = 'dead'");
    expect(sql).toContain("outbox_events.state = 'published'");
    expect(sql).toContain("attempt_count = 0");
    expect(executedQueries[0]?.params).toEqual([
      100,
      distributionProcessingGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);
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

    // An adapter without lookupPublication yields the deterministic,
    // non-retryable provider_lookup_unavailable failure.
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
          providerRegistry: {
            get: () => ({
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
              retryPolicy: {
                baseDelaySeconds: 60,
                maxAttempts: 5,
                maxDelaySeconds: 3_600,
              },
            }),
          } as unknown as ProviderRegistry,
          transaction: recordingTransaction(query),
        },
      ),
    );

    expect(outcome).toBe("processed");
    expect(updates).toHaveLength(1);
    // A non-retryable lookup failure can never be rearmed, so the row lands in
    // a terminal failed disposition — never needs_reconciliation with a NULL
    // next attempt (#256).
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
              // The durable count already reflects this delivery's claim, so
              // the armed key names the next attempt exactly like the scanner.
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
    // The armed trigger must share the scanner's reconcile:<attempt> identity
    // so a duplicate re-arm dedupes instead of claiming an independent
    // reconciliation budget slot (#256).
    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0]?.params?.[2]).toBe(`distribution:${distributionId}:reconcile:5`);
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

  /**
   * A Threads adapter whose publish call is observable per test. The capability
   * accepts the `video/mp4` object the frozen composition carries and declares
   * the remote-ingest transfer mode it is delivered through, so claim-time
   * selection freezes that object and the publish path can hand it over.
   */
  function threadsRegistry(
    publish: (...args: unknown[]) => Promise<ProviderOperationResult>,
  ): ProviderRegistry {
    return {
      get: () => ({
        capability: {
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
        publish,
        retryPolicy: {
          baseDelaySeconds: 60,
          maxAttempts: 5,
          maxDelaySeconds: 3_600,
        },
        transferModes: ["remote_ingest"],
      }),
    } as unknown as ProviderRegistry;
  }

  /**
   * Drives one publish delivery against a queued row, answering the cached
   * budget read with `budget` (no row when null).
   */
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
      // Ninety minutes out: the park is capped at one window.
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
        ([sql]) =>
          String(sql).includes("INSERT INTO outbox_events") &&
          String(sql).includes("distribution.publish.requested"),
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
              // The durable schedule sits later than this stale trigger.
              scheduled_at: new Date(now.getTime() + 3_600_000),
            },
          ],
        });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });
    const transaction = recordingTransaction(query);

    const result = await Effect.runPromise(
      processDistributionMessage(env, publishMessage(), {
        now: () => now,
        providerRegistry: {
          get: () => undefined,
        } as unknown as ProviderRegistry,
        transaction,
      }),
    );

    expect(result).toBe("skipped");
    expect(transaction).toHaveBeenCalledTimes(1);
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
        providerRegistry: {
          get: () => undefined,
        } as unknown as ProviderRegistry,
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
      // Lease claims return rows to deliver; none are claimed here so the sweep
      // performs no Queue send.
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
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
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

    // The retired per-minute expression claims nothing at all.
    await handler.scheduled?.(
      {
        cron: "* * * * *",
        noRetry: vi.fn(),
        scheduledTime: Date.parse("2040-01-01T00:00:00Z"),
      },
      env,
      createExecutionContext(),
    );
    expect(executedQueries.filter(({ sql }) => sql.includes("SKIP LOCKED"))).toHaveLength(0);

    // Hourly tier: every Due claim plus the Outbox relay.
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

    // Hourly due-distribution-scan
    expect(dueDistributionClaim?.sql).toContain("FROM distributions");
    expect(dueDistributionClaim?.sql).toContain("LIMIT $1");
    expect(dueDistributionClaim?.params).toEqual([
      100,
      distributionProcessingGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);

    // Hourly distribution-sweep
    expect(distributionSweepClaim?.sql).toContain("FROM distributions");
    expect(distributionSweepClaim?.sql).toContain("LIMIT $1");
    expect(distributionSweepClaim?.params).toEqual([
      100,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);

    // Hourly provider-sync-sweep (analytics, comments, token_refresh)
    expect(analyticsSweepClaim?.sql).toContain("FROM distributions");
    expect(analyticsSweepClaim?.sql).toContain("analytics_next_sync_at");
    expect(analyticsSweepClaim?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);

    expect(commentsSweepClaim?.sql).toContain("FROM distributions");
    expect(commentsSweepClaim?.sql).toContain("comments_next_sync_at");
    expect(commentsSweepClaim?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);

    expect(tokenRefreshSweepClaim?.sql).toContain("FROM platform_accounts");
    expect(tokenRefreshSweepClaim?.sql).toContain("token_refresh_next_attempt_at");
    expect(tokenRefreshSweepClaim?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);

    // Hourly reply-reconciliation
    expect(replyClaim?.sql).toContain("FROM comments");
    expect(replyClaim?.sql).toContain("LIMIT $1");
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
            // Equal to the horizon: still inside the platform limit.
            claimedRow(302, new Date(base + 86_400_000)),
            // Beyond the horizon: the stale command must never send.
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
    // Each message carries its own delay derived from the durable schedule.
    expect(sent[0]?.delaySeconds).toBe(Math.max(0, Math.ceil((base + 600_000 - sentAtMs) / 1000)));
    expect(sent[1]?.delaySeconds).toBeLessThanOrEqual(86_400);
    // Bodies stay identifier-only triggers.
    for (const { body } of sent) {
      expect(body.payload).toEqual({
        distribution_id: distributionId,
      });
      expect(body.version).toBe(1);
      expect(body.topic).toBe("distribution.publish.requested");
      expect(Object.keys(body)).not.toContain("scheduled_at");
    }
    // The beyond-horizon command finalizes without a send.
    expect(new Set(query.mock.calls[1]?.[1]?.[0] as string[])).toEqual(
      new Set([eventId(301), eventId(302), eventId(303)]),
    );
  });
});

describe("Hourly distribution recovery sweep", () => {
  it("executes the bound recovery query with parameterization and without transitioning source rows", async () => {
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
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
    );

    const count = await Effect.runPromise(sweepDueDistributions(env));
    expect(count).toBe(2);

    expect(executedQueries).toHaveLength(1);
    const [sweepQuery] = executedQueries;
    expect(sweepQuery?.params).toEqual([
      100,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
    ]);

    const sql = sweepQuery?.sql ?? "";
    expect(sql).toContain("FROM distributions");
    expect(sql).toContain("LIMIT $1");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("ORDER BY scheduled_at, id");
    expect(sql).toContain("INSERT INTO outbox_events");
    expect(sql).toContain("'distribution.publish.requested'");
    expect(sql).toContain("'distribution'");
    expect(sql).toContain("ON CONFLICT DO NOTHING");

    // Source rows must not be transitioned away from 'scheduled'.
    expect(sql).not.toContain("UPDATE distributions");
    expect(sql).not.toContain("SET status =");

    // Predicate enforces in-horizon bounds and exclusion of active in-flight work.
    expect(sql).toContain("status = 'scheduled'");
    expect(sql).toContain("scheduled_at <= now() + ($3 * INTERVAL '1 second')");
    expect(sql).toContain("scheduled_at > now() - ($2 * INTERVAL '1 second')");
    expect(sql).toContain("scheduled_at <= now() - ($2 * INTERVAL '1 second')");
    expect(sql).toContain("state IN ('pending', 'leased', 'failed')");

    // Recovery keys use an hourly bucket: concurrent/same-hour sweeps dedupe,
    // while a later hour can recover a second lost trigger.
    expect(sql).toContain(":recovery:");
    expect(sql).toContain("extract(epoch from now()) / 3600");
    expect(sql).toContain(":distribution.publish.requested:at:");
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
      ): Effect.Effect<A, E, R> => operation({ query } as unknown as EffectTransactionClient),
    );

    await Effect.runPromise(sweepDueDistributions(env, 42, 600, 43_200));
    expect(executedQueries[0]?.params).toEqual([42, 600, 43_200]);
  });
});
