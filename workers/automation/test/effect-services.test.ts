import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { makeJobContext } from "../src/effect/job-context";
import { jobScope } from "../src/effect/scope";
import {
  createReplyWorkflowDispatcherLive,
  createReplyWorkflowDispatcherTest,
  PublishQueueResolver,
  QueuePublisher,
  ReplyWorkflowDispatcher,
} from "../src/effect/services";
import { replyWorkflowPayload, type OutboxMessage } from "../src/messages";

const message: OutboxMessage = {
  aggregate_id: "00000000-0000-4000-8000-000000000001",
  event_id: "00000000-0000-4000-8000-000000000102",
  organization_id: "00000000-0000-4000-8000-000000000201",
  payload: { comment_id: "00000000-0000-4000-8000-000000000001" },
  request_id: "request-reply-1",
  topic: "comment.reply.requested",
  type: "outbox.event",
  version: 1,
};

// Resolves the dispatcher service from the provided layer and runs one
// enqueue, so each test asserts on the same program a handler would run.
function enqueueProgram(body: OutboxMessage) {
  return Effect.gen(function* () {
    const dispatcher = yield* ReplyWorkflowDispatcher;
    return yield* dispatcher.enqueue(body);
  });
}

describe("createReplyWorkflowDispatcherTest", () => {
  // An unconfigured test layer must not silently accept undispatched replies;
  // the default enqueue fails so tests surface the missing override.
  it("fails explicitly when enqueue is not configured", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherTest())),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("ReplyWorkflowDispatcher.enqueue is not configured");
  });

  it("returns the stubbed enqueue result", async () => {
    const enqueue = vi.fn(() => Effect.succeed("enqueued" as const));
    const result = await Effect.runPromise(
      Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherTest({ enqueue })),
    );
    expect(result).toBe("enqueued");
    expect(enqueue).toHaveBeenCalledWith(message);
  });
});

describe("createReplyWorkflowDispatcherLive", () => {
  it("enqueues one workflow batch derived from the outbox message", async () => {
    const createBatch = vi.fn(async () => []);
    const automationEnv = {
      ENVIRONMENT: "test",
      REPLY_WORKFLOW: { createBatch },
      VERSION: "1",
    } as unknown as AutomationEnv;

    const result = await Effect.runPromise(
      Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherLive(automationEnv)),
    );

    expect(result).toBe("enqueued");
    expect(createBatch).toHaveBeenCalledWith([
      {
        id: `reply-${message.event_id}`,
        params: replyWorkflowPayload(message),
        retention: {
          errorRetention: "7 days",
          successRetention: "1 day",
        },
      },
    ]);
  });

  it("fails with the unavailable error when REPLY_WORKFLOW is unbound", async () => {
    const automationEnv = {
      ENVIRONMENT: "test",
      VERSION: "1",
    } as AutomationEnv;

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherLive(automationEnv)),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("reply Workflow binding is unavailable");
  });
});

describe("jobScope runtime layer", () => {
  // The scope layer must satisfy the service tags automation programs yield:
  // publisher delivery, platform queue routing, and reply dispatch.
  it("provides QueuePublisher, PublishQueueResolver, and ReplyWorkflowDispatcher", async () => {
    const threadsQueue = {
      metrics: vi.fn(),
      send: vi.fn(async () => ({
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
      })),
      sendBatch: vi.fn(async () => ({
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
      })),
    } satisfies Queue<unknown>;
    const createBatch = vi.fn(async () => []);
    const scopeEnv = {
      ENVIRONMENT: "test",
      REPLY_WORKFLOW: { createBatch },
      THREADS_PUBLISH_QUEUE: threadsQueue,
      VERSION: "1",
    } as unknown as AutomationEnv;

    const scope = jobScope(
      scopeEnv,
      makeJobContext({
        jobId: "job-1",
        source: "queue",
        traceId: "trace-1",
      }),
    );

    const program = Effect.gen(function* () {
      const publisher = yield* QueuePublisher;
      const resolver = yield* PublishQueueResolver;
      const dispatcher = yield* ReplyWorkflowDispatcher;
      const queue = yield* resolver.queueFor("threads");
      yield* publisher.send(queue, message);
      return yield* dispatcher.enqueue(message);
    });

    const result = await Effect.runPromise(Effect.provide(program, scope.runtimeLayer));

    expect(result).toBe("enqueued");
    expect(threadsQueue.send).toHaveBeenCalledWith(message);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });
});
