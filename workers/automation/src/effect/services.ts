import { Context, Effect, Layer } from "effect";
import type { Platform } from "@meltiply/domain";
import type { AutomationEnv } from "../env";
import { replyWorkflowPayload, type OutboxMessage, type ProviderSyncMessage } from "../messages";

interface QueuePublisherShape {
  readonly send: (
    queue: Queue<unknown>,
    message: OutboxMessage | ProviderSyncMessage,
    options?: { delaySeconds?: number },
  ) => Effect.Effect<void, Error>;
  readonly sendBatch: (
    queue: Queue<unknown>,
    messages: ReadonlyArray<{
      body: OutboxMessage | ProviderSyncMessage;
      delaySeconds?: number;
    }>,
  ) => Effect.Effect<void, Error>;
}

export class QueuePublisher extends Context.Service<QueuePublisher, QueuePublisherShape>()(
  "QueuePublisher",
) {}

interface PublishQueueResolverShape {
  readonly queueFor: (platform: Platform) => Effect.Effect<Queue<unknown>, Error>;
}

export class PublishQueueResolver extends Context.Service<
  PublishQueueResolver,
  PublishQueueResolverShape
>()("PublishQueueResolver") {}

interface ReplyWorkflowDispatcherShape {
  readonly enqueue: (message: OutboxMessage) => Effect.Effect<"enqueued", Error>;
}

export class ReplyWorkflowDispatcher extends Context.Service<
  ReplyWorkflowDispatcher,
  ReplyWorkflowDispatcherShape
>()("ReplyWorkflowDispatcher") {}

export function createQueuePublisherLive(): Layer.Layer<QueuePublisher> {
  return Layer.succeed(QueuePublisher, {
    send: (queue, message, options) =>
      Effect.tryPromise({
        catch: (cause) => (cause instanceof Error ? cause : new Error("queue send failed")),
        try: () =>
          options?.delaySeconds !== undefined && options.delaySeconds !== null
            ? queue.send(message, { delaySeconds: options.delaySeconds })
            : queue.send(message),
      }),
    sendBatch: (queue, messages) =>
      Effect.tryPromise({
        catch: (cause) => (cause instanceof Error ? cause : new Error("queue send batch failed")),
        try: () =>
          queue.sendBatch(
            messages.map((entry) =>
              entry.delaySeconds !== undefined && entry.delaySeconds !== null
                ? {
                    body: entry.body,
                    delaySeconds: entry.delaySeconds,
                  }
                : { body: entry.body },
            ),
          ),
      }),
  });
}

export function createPublishQueueResolverLive(
  queueFor: (platform: Platform) => Queue<unknown>,
): Layer.Layer<PublishQueueResolver> {
  return Layer.succeed(PublishQueueResolver, {
    queueFor: (platform) =>
      Effect.try({
        catch: () => new Error(`${platform} publish Queue binding is unavailable`),
        try: () => queueFor(platform),
      }),
  });
}

export function createReplyWorkflowDispatcherLive(
  env: AutomationEnv,
): Layer.Layer<ReplyWorkflowDispatcher> {
  return Layer.succeed(ReplyWorkflowDispatcher, {
    enqueue: (message) => {
      const workflow = env.REPLY_WORKFLOW;
      if (!workflow) {
        return Effect.fail(new Error("reply Workflow binding is unavailable"));
      }
      return Effect.map(
        Effect.tryPromise({
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("reply Workflow createBatch failed"),
          try: () =>
            workflow.createBatch([
              {
                id: `reply-${message.event_id}`,
                params: replyWorkflowPayload(message),
                retention: {
                  errorRetention: "7 days",
                  successRetention: "1 day",
                },
              },
            ]),
        }),
        () => "enqueued" as const,
      );
    },
  });
}

export function createQueuePublisherTest(
  impl?: Partial<QueuePublisherShape>,
): Layer.Layer<QueuePublisher> {
  return Layer.succeed(QueuePublisher, {
    send: impl?.send ?? (() => Effect.fail(new Error("QueuePublisher.send is not configured"))),
    sendBatch:
      impl?.sendBatch ??
      (() => Effect.fail(new Error("QueuePublisher.sendBatch is not configured"))),
  });
}

export function createPublishQueueResolverTest(
  impl?: Partial<PublishQueueResolverShape>,
): Layer.Layer<PublishQueueResolver> {
  return Layer.succeed(PublishQueueResolver, {
    queueFor:
      impl?.queueFor ??
      (() => Effect.fail(new Error("PublishQueueResolver.queueFor is not configured"))),
  });
}

export function createReplyWorkflowDispatcherTest(
  impl?: Partial<ReplyWorkflowDispatcherShape>,
): Layer.Layer<ReplyWorkflowDispatcher> {
  return Layer.succeed(ReplyWorkflowDispatcher, {
    enqueue:
      impl?.enqueue ??
      (() => Effect.fail(new Error("ReplyWorkflowDispatcher.enqueue is not configured"))),
  });
}
