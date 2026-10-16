import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAutomationHandler } from "../src/index";
import type { AutomationEnv } from "../src/env";
import {
  AmbiguousJobError,
  classifyJobError,
  createPublishQueueResolverLive,
  createPublishQueueResolverTest,
  createQueuePublisherLive,
  createQueuePublisherTest,
  exitToJobOutcome,
  jobScope,
  queueBackoffDelaySeconds,
  PublishQueueResolver,
  QueuePublisher,
  RetryableJobError,
  runJobProgram,
  TerminalJobError,
} from "../src/effect/index";
import { makeJobContext } from "../src/effect/job-context";
import { unwrapJobError } from "../src/effect/job-errors";
import { JobInProgressError } from "../src/job-lease";

const automationEnv = env as unknown as AutomationEnv;

// Each boundary test receives fresh correlation and logger layers, preventing
// one execution's context from leaking into another test's job.
function scope() {
  return jobScope(
    { ENVIRONMENT: "test", VERSION: "1" },
    makeJobContext({ jobId: "job-1", source: "queue", traceId: "trace-1" }),
  );
}

describe("automation Effect boundary mapping", () => {
  it("maps success to processed", async () => {
    const exit = await runJobProgram(Effect.provide(Effect.succeed("ok"), scope().runtimeLayer));
    expect(exitToJobOutcome(exit)).toEqual({ outcome: "processed" });
  });

  it("maps retryable failures to retry with the queue backoff code", async () => {
    const exit = await runJobProgram(
      Effect.provide(Effect.fail(new RetryableJobError({ message: "boom" })), scope().runtimeLayer),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("retry");
    expect(mapped.diagnostic?.error_code).toBe("queue_job_failed");
  });

  it("preserves the original throw's error type in retry diagnostics", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.tryPromise({
          catch: (cause) => classifyJobError(cause),
          try: () => Promise.reject(new Error("transient failure")),
        }),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("retry");
    expect(mapped.diagnostic?.error).toMatchObject({ name: "Error" });
  });

  // Lease-conflict retries must keep the original error name: classification
  // stores it in the wrapper's `cause`, and unwrapJobError restores it so
  // diagnostics group under "JobInProgressError", not the wrapper tag.
  it("keeps the JobInProgressError name through classification and unwrap", () => {
    const classified = classifyJobError(new JobInProgressError());
    expect(classified).toBeInstanceOf(RetryableJobError);
    expect(classified).toMatchObject({ cause: "JobInProgressError" });
    const unwrapped = unwrapJobError(classified);
    expect(unwrapped).toBeInstanceOf(Error);
    expect(unwrapped.name).toBe("JobInProgressError");
  });

  it("emits the original lease-conflict type in retry diagnostics", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.tryPromise({
          catch: (cause) => classifyJobError(cause),
          try: () => Promise.reject(new JobInProgressError()),
        }),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("retry");
    expect(mapped.diagnostic?.error_code).toBe("queue_job_failed");
    expect(mapped.diagnostic?.error).toMatchObject({
      name: "JobInProgressError",
    });
  });

  it("maps terminal failures to rejected for ack-and-surface handling", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.fail(
          new TerminalJobError({
            cause: "TypeError",
            code: "unknown_message_type",
            message: "unsupported queue message",
          }),
        ),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("rejected");
    expect(mapped.diagnostic?.error_code).toBe("unknown_message_type");
  });

  it("never maps ambiguous provider outcomes to automatic retry", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.fail(
          new AmbiguousJobError({
            code: "provider_call_failed",
            message: "side effect may have committed",
          }),
        ),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("ambiguous");
    expect(mapped.outcome).not.toBe("retry");
  });

  it("classifies ambiguous provider throws as ambiguous, not retryable", () => {
    const thrown = Object.assign(new Error("timeout during publish"), {
      failure: { classification: "ambiguous", code: "provider_timeout" },
    });
    const classified = classifyJobError(thrown);
    expect(classified).toBeInstanceOf(AmbiguousJobError);
  });

  it("maps unexpected defects to retry", async () => {
    const exit = await runJobProgram(
      Effect.provide(Effect.die(new Error("unexpected defect")), scope().runtimeLayer),
    );
    expect(exitToJobOutcome(exit).outcome).toBe("retry");
  });

  it("retries pure interruption with a cancellation diagnostic", async () => {
    const exit = await runJobProgram(Effect.interrupt);
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toBe("retry");
    expect(mapped.diagnostic?.error_code).toBe("queue_job_interrupted");
    expect(mapped.diagnostic?.error).toMatchObject({ name: "Error" });
  });

  it("maintains the queue backoff schedule", () => {
    expect(queueBackoffDelaySeconds(0)).toBe(15);
    expect(queueBackoffDelaySeconds(1)).toBe(30);
    expect(queueBackoffDelaySeconds(2)).toBe(60);
    expect(queueBackoffDelaySeconds(100)).toBe(3_600);
  });
});

describe("automation queue duplicate delivery", () => {
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

  // Reuses the same durable payload with a chosen delivery ID to exercise
  // Cloudflare acknowledgement and redelivery behavior at the worker seam.
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

    const first = batch("asset-duplicate");
    const firstContext = createExecutionContext();
    await handler.queue?.(first, automationEnv, firstContext);
    expect(await getQueueResult(first, firstContext)).toMatchObject({
      explicitAcks: ["asset-duplicate"],
      retryMessages: [],
    });

    // At-least-once redelivery of the same message reprocesses safely and acks.
    const second = batch("asset-duplicate");
    const secondContext = createExecutionContext();
    await handler.queue?.(second, automationEnv, secondContext);
    expect(await getQueueResult(second, secondContext)).toMatchObject({
      explicitAcks: ["asset-duplicate"],
      retryMessages: [],
    });
  });

  // Valid deliveries must survive transport TypeErrors and complete on redelivery;
  // only explicit payload validation failures may take the terminal ack path.
  it("retries a transport TypeError and acks the redelivery on success", async () => {
    const process = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(classifyJobError(new TypeError("fetch failed"))))
      .mockReturnValueOnce(Effect.succeed("processed" as const));
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

  // Queue-binding failures must remain failed Effects until the worker chooses
  // retry; the same payload is acknowledged only after delivery succeeds.
  it("retries failed queue publishing and acks a successful redelivery", async () => {
    const destination = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(undefined),
      sendBatch: vi.fn(),
      metrics: vi.fn(),
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

  // Missing test overrides must not silently acknowledge undelivered work.
  // Each case isolates a distinct unconfigured method while supplying the others.
  it.each(["routing", "send", "sendBatch"] as const)(
    "retries work when test %s is unconfigured",
    async (missing) => {
      const destination = {
        send: vi.fn(),
        sendBatch: vi.fn(),
        metrics: vi.fn(),
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
