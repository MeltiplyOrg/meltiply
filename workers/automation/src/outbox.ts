import { Cause, Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError, Platform } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";

import { maximumDelayedDeliverySeconds } from "@meltiply/domain";
import { withSystemTransactionEffect } from "./database";
import {
  classifyJobError,
  PublishQueueResolver,
  QueuePublisher,
  type AutomationJobError,
} from "./effect/index";
import type { AutomationEnv } from "./env";
import { safeErrorMessage } from "./errors";
import { sanitizeNotificationPayload, type OutboxMessage } from "./messages";
import { nextDelaySeconds, QUEUE_RETRY_POLICY } from "./retry-policy";

interface OutboxRow extends Record<string, unknown> {
  aggregate_id: string;
  attempt_count: number;
  id: string;
  next_attempt_at: Date | string | null;
  org_id: string;
  payload: Record<string, unknown>;
  platform: Platform | null;
  scheduled_at: Date | string | null;
  topic: string;
}

interface PendingOutboxMessage {
  message: OutboxMessage;
  row: OutboxRow;
  delaySeconds: number | null;
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

const maximumAttempts = 10;
const leaseSeconds = 120;

function claimOutbox(
  client: EffectTransactionClient,
  batchSize: number,
): Effect.Effect<OutboxRow[], DatabaseError> {
  return Effect.map(
    client.query<OutboxRow>(
      `WITH exhausted AS (
         UPDATE outbox_events
         SET state = 'dead',
             available_at = NULL,
             lease_expires_at = NULL,
             last_error = 'The relay lease expired on the final delivery attempt.',
             updated_at = now()
         WHERE id IN (
           SELECT id
           FROM outbox_events
           WHERE state = 'leased'
             AND attempt_count >= $2
             AND lease_expires_at <= now()
           ORDER BY lease_expires_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
       ), candidates AS (
         SELECT event.id,
                CASE WHEN event.topic LIKE 'distribution.%'
                  THEN distribution.platform
                  ELSE NULL
                END AS platform,
        CASE WHEN event.topic LIKE 'distribution.%'
                  THEN distribution.scheduled_at
                  ELSE NULL
                END AS scheduled_at,
                CASE WHEN event.topic LIKE 'distribution.%'
                  THEN distribution.next_attempt_at
                  ELSE NULL
                END AS next_attempt_at
         FROM outbox_events AS event
         LEFT JOIN distributions AS distribution
           ON event.aggregate_type = 'distribution'
          AND distribution.id = event.aggregate_id
         WHERE event.attempt_count < $2
           AND (
             (event.state IN ('pending', 'failed') AND event.available_at <= now())
             OR (event.state = 'leased' AND event.lease_expires_at <= now())
           )
         ORDER BY event.available_at, event.created_at, event.id
         LIMIT $1
         FOR UPDATE OF event SKIP LOCKED
       )
       UPDATE outbox_events AS event
       SET state = 'leased',
           attempt_count = event.attempt_count + 1,
           lease_expires_at = now() + ($3 * INTERVAL '1 second'),
           last_error = NULL,
           updated_at = now()
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING
         event.id, event.org_id, event.topic, event.aggregate_id,
        event.payload, event.attempt_count, candidates.platform,
        candidates.scheduled_at, candidates.next_attempt_at`,
      [batchSize, maximumAttempts, leaseSeconds],
    ),
    (result) => result.rows,
  );
}

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

function markPublished(
  env: AutomationEnv,
  eventIds: readonly string[],
): Effect.Effect<void, DatabaseError> {
  if (eventIds.length === 0) return Effect.void;
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE outbox_events
       SET state = 'published',
           published_at = now(),
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = now()
       WHERE id = ANY($1::uuid[]) AND state = 'leased'`,
      [eventIds],
    ),
  ).pipe(Effect.asVoid);
}

function markFailed(
  env: AutomationEnv,
  messages: readonly FailedOutboxMessage[],
): Effect.Effect<number, DatabaseError> {
  if (messages.length === 0) return Effect.succeed(0);
  const eventIds = messages.map(({ row }) => row.id);
  const delays = messages.map(
    ({ row }) =>
      nextDelaySeconds(QUEUE_RETRY_POLICY, row.attempt_count) ?? QUEUE_RETRY_POLICY.maxSeconds,
  );
  const errors = messages.map(({ cause }) => safeErrorMessage(cause, "unknown relay error"));
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(
      client.query<{ state: string }>(
        `UPDATE outbox_events AS event
         SET state = CASE WHEN event.attempt_count >= $4 THEN 'dead' ELSE 'failed' END,
             available_at = CASE
               WHEN event.attempt_count >= $4 THEN NULL
               ELSE now() + (updates.delay_seconds * INTERVAL '1 second')
             END,
             lease_expires_at = NULL,
             last_error = updates.last_error,
             updated_at = now()
         FROM unnest(
           $1::uuid[],
           $2::integer[],
           $3::text[]
         ) AS updates(id, delay_seconds, last_error)
         WHERE event.id = updates.id AND event.state = 'leased'
         RETURNING event.state`,
        [eventIds, delays, errors, maximumAttempts],
      ),
      (result) => result.rows.filter(({ state }) => state === "dead").length,
    ),
  );
}

function messageFor(row: OutboxRow): OutboxMessage {
  return {
    attempt: row.attempt_count,
    aggregate_id: row.aggregate_id,
    event_id: row.id,
    organization_id: row.org_id,
    payload: safePayload(row),
    topic: row.topic,
    type: "outbox.event",
    version: 1,
    request_id: typeof row.payload.request_id === "string" ? row.payload.request_id : null,
  };
}

function boundedDelay(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds));
}

function publishDelaySeconds(row: OutboxRow): number | null {
  const dueAt =
    row.topic === "distribution.publish.requested"
      ? (row.scheduled_at ?? row.next_attempt_at)
      : row.next_attempt_at;
  if (row.topic.startsWith("distribution.") && dueAt) {
    return boundedDelay((new Date(dueAt).getTime() - Date.now()) / 1000);
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
): Effect.Effect<OutboxRelayResult, AutomationJobError, QueuePublisher | PublishQueueResolver> {
  return Effect.gen(function* () {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      yield* Effect.fail(
        classifyJobError(new RangeError("outbox batch size must be between 1 and 100")),
      );
    }
    const rows = yield* withSystemTransactionEffect(env, (client) =>
      claimOutbox(client, batchSize),
    ).pipe(Effect.mapError(classifyJobError));
    const result: OutboxRelayResult = {
      claimed: rows.length,
      dead: 0,
      failed: 0,
      published: 0,
    };

    const queueGroups = new Map<Queue<unknown>, PendingOutboxMessage[]>();
    const publishedWithoutQueue: PendingOutboxMessage[] = [];
    const failed: FailedOutboxMessage[] = [];

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
        const delaySeconds = publishDelaySeconds(row);
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
        markPublished(
          env,
          published.map(({ row }) => row.id),
        ).pipe(Effect.mapError(classifyJobError)),
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
      result.dead = yield* markFailed(env, failed).pipe(Effect.mapError(classifyJobError));
      result.failed = failed.length;
    }
    return result;
  });
}
