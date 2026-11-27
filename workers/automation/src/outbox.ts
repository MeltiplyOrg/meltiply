import { Cause, Effect, Exit } from "effect";
import { maximumDelayedDeliverySeconds } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";

import {
  classifyJobError,
  PublishQueueResolver,
  QueuePublisher,
  type AutomationJobError,
} from "./effect/index";
import type { AutomationEnv } from "./env";
import { safeErrorMessage } from "./errors";
import { sanitizeNotificationPayload, type OutboxMessage } from "./messages";
import {
  createPostgresOutboxRepository,
  type OutboxRepository,
  type OutboxRow,
} from "./repositories/outbox-repository";
import { nextDelaySeconds, QUEUE_RETRY_POLICY } from "./retry-policy";

interface PendingOutboxMessage {
  delaySeconds: number | null;
  message: OutboxMessage;
  row: OutboxRow;
}

interface FailedOutboxMessage {
  cause: unknown;
  row: OutboxRow;
}

export interface OutboxRelayResult {
  claimed: number;
  dead: number;
  failed: number;
  published: number;
}

export interface RelayOutboxOptions {
  readonly now?: () => number;
  readonly repository?: OutboxRepository;
}

const maximumAttempts = 10;
const leaseSeconds = 120;

function safePayload(row: OutboxRow): Record<string, unknown> {
  switch (row.topic) {
    case "asset.upload.created":
    case "asset.processing.requested":
      return {
        asset_id: row.aggregate_id,
        ...(typeof row.payload.session_id === "string"
          ? { session_id: row.payload.session_id }
          : {}),
        ...(row.payload.strategy === "single" || row.payload.strategy === "multipart"
          ? { strategy: row.payload.strategy }
          : {}),
      };
    case "asset.deletion.requested":
      return { asset_id: row.aggregate_id };
    case "channel.revocation.requested":
      return {
        ...(typeof row.payload.access_token === "string"
          ? { access_token: row.payload.access_token }
          : {}),
        ...(typeof row.payload.brand_profile_id === "string"
          ? { brand_profile_id: row.payload.brand_profile_id }
          : {}),
        ...(typeof row.payload.platform === "string" ? { platform: row.payload.platform } : {}),
        platform_account_id: row.aggregate_id,
      };
    case "comment.reply.requested":
      return { comment_id: row.aggregate_id };
    case "notification.delivery.requested":
      return sanitizeNotificationPayload(row.payload);
    case "distribution.publish.requested":
    case "distribution.cancel.requested":
    case "distribution.reconcile.requested":
      return { distribution_id: row.aggregate_id };
    default:
      return {};
  }
}

function queueFor(
  env: AutomationEnv,
  row: OutboxRow,
): Effect.Effect<Queue<unknown> | null, Error, PublishQueueResolver> {
  return Effect.gen(function* () {
    if (row.topic.startsWith("asset.")) {
      if (!env.ASSET_PROCESSING_QUEUE) {
        return yield* Effect.fail(new Error("asset-processing Queue binding is unavailable"));
      }
      return env.ASSET_PROCESSING_QUEUE;
    }
    if (row.topic === "comment.reply.requested") {
      if (!env.REPLIES_QUEUE) {
        return yield* Effect.fail(new Error("replies Queue binding is unavailable"));
      }
      return env.REPLIES_QUEUE;
    }
    if (row.topic === "channel.revocation.requested") {
      if (!env.CHANNEL_REVOCATION_QUEUE) {
        return yield* Effect.fail(new Error("channel-revocation Queue binding is unavailable"));
      }
      return env.CHANNEL_REVOCATION_QUEUE;
    }
    if (row.topic === "notification.delivery.requested") {
      if (!env.NOTIFICATIONS_QUEUE) {
        return yield* Effect.fail(new Error("notifications Queue binding is unavailable"));
      }
      return env.NOTIFICATIONS_QUEUE;
    }
    if (row.topic.startsWith("distribution.")) {
      if (!row.platform) {
        return yield* Effect.fail(
          new Error("distribution platform is unavailable for Queue routing"),
        );
      }
      const resolver = yield* PublishQueueResolver;
      return yield* resolver.queueFor(row.platform);
    }
    if (row.topic.startsWith("telemetry.")) return null;
    return yield* Effect.fail(new Error(`unsupported outbox topic: ${row.topic}`));
  });
}

function messageFor(row: OutboxRow): OutboxMessage {
  return {
    aggregate_id: row.aggregate_id,
    attempt: row.attempt_count,
    event_id: row.id,
    organization_id: row.org_id,
    payload: safePayload(row),
    request_id: typeof row.payload.request_id === "string" ? row.payload.request_id : null,
    topic: row.topic,
    type: "outbox.event",
    version: 1,
  };
}

function boundedDelay(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds));
}

function publishDelaySeconds(row: OutboxRow, nowMs: number): number | null {
  const dueAt =
    row.topic === "distribution.publish.requested"
      ? (row.scheduled_at ?? row.next_attempt_at)
      : row.next_attempt_at;
  if (row.topic.startsWith("distribution.") && dueAt) {
    return boundedDelay((new Date(dueAt).getTime() - nowMs) / 1000);
  }
  if (row.topic === "comment.reply.requested" && typeof row.payload.delay_seconds === "number") {
    return boundedDelay(row.payload.delay_seconds);
  }
  return null;
}

interface DispatchOutcome {
  failed: FailedOutboxMessage[];
  published: PendingOutboxMessage[];
}

function publishQueueMessages(
  queue: Queue<unknown>,
  messages: readonly PendingOutboxMessage[],
): Effect.Effect<DispatchOutcome, Error, QueuePublisher> {
  return Effect.gen(function* () {
    const publisher = yield* QueuePublisher;
    yield* publisher.sendBatch(
      queue,
      messages.map(({ delaySeconds, message }) => ({
        body: message,
        ...(delaySeconds === null ? {} : { delaySeconds }),
      })),
    );
    return { failed: [], published: [...messages] };
  });
}

export function relayOutbox(
  env: AutomationEnv,
  batchSize = 50,
  options: RelayOutboxOptions = {},
): Effect.Effect<OutboxRelayResult, AutomationJobError, QueuePublisher | PublishQueueResolver> {
  const repository = options.repository ?? createPostgresOutboxRepository(env);
  const now = options.now ?? (() => Date.now());
  return Effect.gen(function* () {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      yield* Effect.fail(
        classifyJobError(new RangeError("outbox batch size must be between 1 and 100")),
      );
    }
    const rows = yield* repository
      .claim(batchSize, maximumAttempts, leaseSeconds)
      .pipe(Effect.mapError(classifyJobError));
    const result: OutboxRelayResult = {
      claimed: rows.length,
      dead: 0,
      failed: 0,
      published: 0,
    };

    const queueGroups = new Map<Queue<unknown>, PendingOutboxMessage[]>();
    const publishedWithoutQueue: PendingOutboxMessage[] = [];
    const failed: FailedOutboxMessage[] = [];
    const nowMs = now();

    for (const row of rows) {
      const routed = yield* Effect.exit(queueFor(env, row));
      if (Exit.isFailure(routed)) {
        failed.push({ cause: Cause.squash(routed.cause), row });
        continue;
      }
      try {
        const queue = routed.value;
        const pending = { message: messageFor(row), row };
        if (!queue) {
          publishedWithoutQueue.push({ ...pending, delaySeconds: null });
          continue;
        }
        const delaySeconds = publishDelaySeconds(row, nowMs);
        if (delaySeconds !== null && delaySeconds > maximumDelayedDeliverySeconds) {
          publishedWithoutQueue.push({ ...pending, delaySeconds });
          continue;
        }
        const group = queueGroups.get(queue);
        const queuedPending = { ...pending, delaySeconds };
        if (group) group.push(queuedPending);
        else queueGroups.set(queue, [queuedPending]);
      } catch (cause) {
        failed.push({ cause, row });
      }
    }

    const dispatched = yield* Effect.all(
      [...queueGroups.entries()].map(([queue, messages]) =>
        Effect.catch(
          publishQueueMessages(queue, messages),
          (cause): Effect.Effect<DispatchOutcome> =>
            Effect.succeed({
              failed: messages.map(({ row }) => ({ cause, row })),
              published: [],
            }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    const published = [
      ...publishedWithoutQueue,
      ...dispatched.flatMap(({ published: accepted }) => accepted),
    ];
    failed.push(...dispatched.flatMap(({ failed: rejected }) => rejected));

    if (published.length > 0) {
      const marked = yield* Effect.exit(
        repository
          .markPublished(published.map(({ row }) => row.id))
          .pipe(Effect.mapError(classifyJobError)),
      );
      if (Exit.isFailure(marked)) {
        log(
          "error",
          {
            environment: env.ENVIRONMENT,
            service: "automation",
            trace_id: "outbox-relay",
            version: env.VERSION,
          },
          {
            ...errorDiagnostic(Cause.squash(marked.cause)),
            error_code: "outbox_settlement_failed",
            event: "outbox_settlement_failed",
            job: "outbox_relay",
            outcome: published.length,
            retry_class: "queue_backoff",
            unsettled_events: published.length,
          },
        );
      } else {
        result.published = published.length;
      }
    }
    if (failed.length > 0) {
      const updates = failed.map(({ cause, row }) => ({
        delaySeconds:
          nextDelaySeconds(QUEUE_RETRY_POLICY, row.attempt_count) ?? QUEUE_RETRY_POLICY.maxSeconds,
        id: row.id,
        lastError: safeErrorMessage(cause, "unknown relay error"),
      }));
      result.dead = yield* repository
        .markFailed(updates, maximumAttempts)
        .pipe(Effect.mapError(classifyJobError));
      result.failed = failed.length;
    }
    return result;
  });
}
