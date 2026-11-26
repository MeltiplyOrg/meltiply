import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeJobContext } from "../src/effect/job-context";
import { jobScope } from "../src/effect/scope";
import {
  createReplyWorkflowDispatcherLive,
  createReplyWorkflowDispatcherTest,
  PublishQueueResolver,
  QueuePublisher,
  ReplyWorkflowDispatcher,
} from "../src/effect/services";
import type { AutomationEnv } from "../src/env";
import { replyWorkflowPayload, type OutboxMessage } from "../src/messages";
import { fakeQueue, fakeReplyWorkflow } from "./test-doubles";

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

function enqueueProgram(body: OutboxMessage) {
  return Effect.flatMap(ReplyWorkflowDispatcher, (dispatcher) => dispatcher.enqueue(body));
}

describe("createReplyWorkflowDispatcherTest", () => {
  it("fails explicitly when enqueue is not configured", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherTest())),
    );

    expect(error.message).toEqual("ReplyWorkflowDispatcher.enqueue is not configured");
  });

  it("invokes the provided stub and returns its result", async () => {
    const received: OutboxMessage[] = [];
    const result = await Effect.runPromise(
      Effect.provide(
        enqueueProgram(message),
        createReplyWorkflowDispatcherTest({
          enqueue: (body) => {
            received.push(body);
            return Effect.succeed("enqueued" as const);
          },
        }),
      ),
    );

    expect(result).toEqual("enqueued");
    expect(received).toEqual([message]);
  });
});

describe("createReplyWorkflowDispatcherLive", () => {
  it("enqueues one workflow batch derived from the outbox message", async () => {
    const batches: unknown[] = [];
    const automationEnv: AutomationEnv = {
      ENVIRONMENT: "test",
      REPLY_WORKFLOW: fakeReplyWorkflow(async (batch) => {
        batches.push(batch);
        return [];
      }),
      VERSION: "1",
    };

    const result = await Effect.runPromise(
      Effect.provide(enqueueProgram(message), createReplyWorkflowDispatcherLive(automationEnv)),
    );

    expect(result).toEqual("enqueued");
    expect(batches).toEqual([
      [
        {
          id: `reply-${message.event_id}`,
          params: replyWorkflowPayload(message),
          retention: {
            errorRetention: "7 days",
            successRetention: "1 day",
          },
        },
      ],
    ]);
  });

  it("fails when REPLY_WORKFLOW is unbound", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          enqueueProgram(message),
          createReplyWorkflowDispatcherLive({ ENVIRONMENT: "test", VERSION: "1" }),
        ),
      ),
    );

    expect(error.message).toEqual("reply Workflow binding is unavailable");
  });
});

describe("jobScope", () => {
  it("provides QueuePublisher, PublishQueueResolver, and ReplyWorkflowDispatcher", async () => {
    const sent: unknown[] = [];
    const batches: unknown[] = [];
    const scopeEnv: AutomationEnv = {
      ENVIRONMENT: "test",
      REPLY_WORKFLOW: fakeReplyWorkflow(async (batch) => {
        batches.push(batch);
        return [];
      }),
      THREADS_PUBLISH_QUEUE: fakeQueue({
        send: async (body) => {
          sent.push(body);
          return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
        },
      }),
      VERSION: "1",
    };

    const scope = jobScope(
      scopeEnv,
      makeJobContext({ jobId: "job-1", source: "queue", traceId: "trace-1" }),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const publisher = yield* QueuePublisher;
          const resolver = yield* PublishQueueResolver;
          const dispatcher = yield* ReplyWorkflowDispatcher;
          const queue = yield* resolver.queueFor("threads");
          yield* publisher.send(queue, message);
          return yield* dispatcher.enqueue(message);
        }),
        scope.runtimeLayer,
      ),
    );

    expect(result).toEqual("enqueued");
    expect(sent).toEqual([message]);
    expect(batches).toHaveLength(1);
  });
});
