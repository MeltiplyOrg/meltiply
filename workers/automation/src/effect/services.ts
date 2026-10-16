import { Context, Effect, Layer } from "effect";
import type { Platform } from "@meltiply/domain";
import type { AutomationEnv } from "../env";
import { replyWorkflowPayload, type OutboxMessage, type ProviderSyncMessage } from "../messages";

/**
 * Effect service shape for Cloudflare Queue publishing from automation jobs.
 * Publishing stays a service (not a bare env binding) so retry/DLQ paths and
 * delayed-delivery scheduling are injectable in tests.
 */
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

/**
 * Effect service tag for Cloudflare Queue publishing.
 */
export class QueuePublisher extends Context.Service<QueuePublisher, QueuePublisherShape>()(
  "QueuePublisher",
) {}

/**
 * Effect service shape resolving dedicated per-platform publish queues.
 * Keeps provider queue routing inside a service so distribution/outbox
 * programs select a platform without branching on env bindings inline.
 */
interface PublishQueueResolverShape {
  readonly queueFor: (platform: Platform) => Effect.Effect<Queue<unknown>, Error>;
}

/**
 * Effect service tag for per-platform publish queue resolution.
 */
export class PublishQueueResolver extends Context.Service<
  PublishQueueResolver,
  PublishQueueResolverShape
>()("PublishQueueResolver") {}

/**
 * Effect service shape for dispatching reply workflow instances.
 * Reply delivery runs inside a durable Cloudflare Workflow rather than a
 * queue consumer, so enqueueing stays behind a service to keep the optional
 * binding injectable and the failure contract explicit in tests.
 */
interface ReplyWorkflowDispatcherShape {
  readonly enqueue: (message: OutboxMessage) => Effect.Effect<"enqueued", Error>;
}

/**
 * Effect service tag for reply Workflow instance dispatch.
 */
export class ReplyWorkflowDispatcher extends Context.Service<
  ReplyWorkflowDispatcher,
  ReplyWorkflowDispatcherShape
>()("ReplyWorkflowDispatcher") {}

/**
 * Builds the live QueuePublisher layer over Cloudflare Queue bindings.
 * Pg-free: sending needs only the Queue binding, so unit tests and handlers
 * share this factory without evaluating the database client.
 *
 * @returns Layer providing QueuePublisher with no requirements.
 */
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

/**
 * Builds the live PublishQueueResolver layer over per-platform queue bindings.
 * Pg-free: resolution reads env bindings only, so handlers share this factory
 * without evaluating the database client.
 *
 * @param queueFor - Platform-to-Queue resolution callback (publishingQueueFor bound to env).
 * @returns Layer providing PublishQueueResolver with no requirements.
 */
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

/**
 * Builds the live ReplyWorkflowDispatcher layer over the REPLY_WORKFLOW binding.
 * Models the reply enqueue branch as a service so queue handlers compose the
 * dispatch instead of touching the Workflow binding inline. A missing binding
 * fails the Effect ("reply Workflow binding is unavailable") rather than
 * throwing outside the program; a bound workflow starts one instance per
 * outbox event with id `reply-<event_id>` and the bounded retention policy
 * (7-day error, 1-day success) the queue handler previously applied inline.
 * Pg-free: dispatch needs only the Workflow binding, so unit tests and
 * handlers share this factory without evaluating the database client.
 *
 * @param env - Automation worker environment bindings.
 * @returns Layer providing ReplyWorkflowDispatcher with no requirements.
 */
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

/**
 * Supplies injectable queue publishing methods without accessing live bindings.
 * Partial overrides mirror the application's test-layer convention; omitted
 * methods fail explicitly so tests cannot accidentally accept undelivered work.
 */
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

/**
 * Supplies injectable platform routing without reading environment bindings.
 * Omitted routing fails explicitly; callers can override only queueFor while
 * composing this layer with a test publisher for isolated delivery scenarios.
 */
export function createPublishQueueResolverTest(
  impl?: Partial<PublishQueueResolverShape>,
): Layer.Layer<PublishQueueResolver> {
  return Layer.succeed(PublishQueueResolver, {
    queueFor:
      impl?.queueFor ??
      (() => Effect.fail(new Error("PublishQueueResolver.queueFor is not configured"))),
  });
}

/**
 * Supplies an injectable reply-workflow enqueue without touching the binding.
 * An omitted enqueue fails explicitly so tests cannot silently accept
 * undispatched reply work; mirrors the test-layer convention in this module.
 */
export function createReplyWorkflowDispatcherTest(
  impl?: Partial<ReplyWorkflowDispatcherShape>,
): Layer.Layer<ReplyWorkflowDispatcher> {
  return Layer.succeed(ReplyWorkflowDispatcher, {
    enqueue:
      impl?.enqueue ??
      (() => Effect.fail(new Error("ReplyWorkflowDispatcher.enqueue is not configured"))),
  });
}
