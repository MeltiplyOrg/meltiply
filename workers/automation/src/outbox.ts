import { Cause, Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError, Platform } from "@meltiply/domain";

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
import type { OutboxMessage } from "./messages";

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
  /**
   * Delivery delay for one Queue message, or `null` to send without delay.
   * Derived from the durable distribution row at relay time so a command
   * recorded earlier still honors the row's current schedule.
   */
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

/**
 * Claims a batch of due outbox events using `FOR UPDATE SKIP LOCKED` and transitions them to 'leased'.
 *
 * Joins against the distributions table for distribution events to resolve platform and schedule data,
 * sets a 120-second lease expiration, and increments attempt counts.
 *
 * @param client - Transactional database client.
 * @param batchSize - Maximum number of outbox records to claim.
 * @returns Array of claimed outbox event rows.
 */
function claimOutbox(
  client: EffectTransactionClient,
  batchSize: number,
): Effect.Effect<OutboxRow[], DatabaseError> {
  return Effect.map(
    client.query<OutboxRow>(
      `WITH candidates AS (
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

/**
 * Extracts and bounds topic-specific payload attributes from an outbox row.
 *
 * Enforces strict key allowlists for asset, channel, comment, and distribution
 * topics to prevent leaking unvalidated data into queue messages. The channel
 * revocation payload carries the still-encrypted access token: the platform
 * account row is already deleted when the consumer runs, so the ciphertext
 * must travel with the command and is decrypted only at the provider boundary.
 *
 * @param row - Outbox database record.
 * @returns Cleaned and typed payload dictionary.
 */
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
      return {
        ...(typeof row.payload.delivery_key === "string"
          ? { delivery_key: row.payload.delivery_key }
          : {}),
        ...(typeof row.payload.kind === "string" ? { kind: row.payload.kind } : {}),
        ...(typeof row.payload.aggregate_id === "string"
          ? { aggregate_id: row.payload.aggregate_id }
          : {}),
        ...(typeof row.payload.brand_profile_id === "string"
          ? { brand_profile_id: row.payload.brand_profile_id }
          : {}),
        ...(typeof row.payload.channel_name === "string" || row.payload.channel_name === null
          ? { channel_name: row.payload.channel_name }
          : {}),
        ...(typeof row.payload.connection_status === "string"
          ? { connection_status: row.payload.connection_status }
          : {}),
        ...(typeof row.payload.distribution_id === "string"
          ? { distribution_id: row.payload.distribution_id }
          : {}),
        ...(typeof row.payload.platform === "string" ? { platform: row.payload.platform } : {}),
        ...(typeof row.payload.post_id === "string" ? { post_id: row.payload.post_id } : {}),
        version: 1,
      };
    case "distribution.publish.requested":
    case "distribution.cancel.requested":
    case "distribution.reconcile.requested":
      return { distribution_id: row.aggregate_id };
    default:
      return {};
  }
}

/**
 * Resolves the target Cloudflare Queue binding for an outbox event as an Effect.
 *
 * Asset events still route to ASSET_PROCESSING_QUEUE, channel revocations to
 * CHANNEL_REVOCATION_QUEUE, comment replies to REPLIES_QUEUE, and telemetry to
 * no queue; distribution events resolve through the PublishQueueResolver
 * service so per-platform routing is injectable at the job boundary.
 * Resolution failures stay on the error channel so the relay marks only the
 * individual row failed instead of aborting the batch.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Outbox row being routed.
 * @returns Effect producing the target Queue, or null for telemetry/unrouted
 *   topics; fails with Error when a binding is missing, the distribution row
 *   carries no platform, or the topic is unsupported.
 */
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

/**
 * Transitions successfully relayed outbox events to the terminal 'published' state.
 *
 * Clears active leases, records publication timestamps, and nullifies error fields.
 *
 * @param env - Automation worker environment bindings.
 * @param eventIds - Array of outbox event UUIDs to mark published.
 * @returns Effect completing once the events are marked published.
 */
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

/**
 * Updates failed outbox events with exponential backoff delays or transitions them to 'dead'.
 *
 * If attempt counts reach the maximum threshold (10), transitions events to 'dead' for dead-lettering.
 * Otherwise computes exponential backoff delays and sets state back to 'failed'.
 *
 * @param env - Automation worker environment bindings.
 * @param messages - Array of failed outbox messages and their error causes.
 * @returns Effect producing the number of events transitioned to 'dead'.
 */
function markFailed(
  env: AutomationEnv,
  messages: readonly FailedOutboxMessage[],
): Effect.Effect<number, DatabaseError> {
  if (messages.length === 0) return Effect.succeed(0);
  const eventIds = messages.map(({ row }) => row.id);
  const delays = messages.map(({ row }) => Math.min(3_600, 2 ** row.attempt_count * 15));
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

/**
 * Assembles an OutboxMessage contract structure from a database outbox row.
 *
 * @param row - Outbox event record.
 * @returns Formatted outbox message suitable for Cloudflare Queue publication.
 */
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

/**
 * Bounds a delivery delay to a whole, non-negative, finite number of seconds.
 *
 * Derived from durable distribution schedules or delayed reply reconciliation payloads.
 * An unparseable timestamp or a payload holding NaN/Infinity returns null for immediate delivery.
 *
 * @param seconds - Raw calculated delivery delay in seconds.
 * @returns Non-negative integer delay, or null for immediate dispatch.
 */
function boundedDelay(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds));
}

/**
 * Calculates delivery delay in seconds for scheduled publications or delayed comment reply reconciliations.
 *
 * Inspects scheduled publication times or explicit delay seconds in the payload against current time.
 *
 * @param row - Outbox event record.
 * @returns Calculated delay in seconds, or null for immediate delivery.
 */
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

/**
 * Dispatches a batch of pending outbox messages through the QueuePublisher service.
 *
 * Sends one sendBatch of JSON bodies (the binding default) with optional
 * per-message delivery delays. A rejected batch stays on the Effect error
 * channel so the caller can mark the whole group failed.
 *
 * @param queue - Target Cloudflare Queue binding.
 * @param messages - Array of pending outbox messages to publish.
 * @returns Effect resolving to the accepted messages; a sendBatch rejection
 *   fails the Effect with the service's Error.
 */
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

/**
 * Claims and relays pending outbox events to their respective Cloudflare Queues.
 *
 * Effect program: claims a leased batch in one transaction, routes each row
 * (distribution topics through the PublishQueueResolver service, other topics
 * through env bindings), groups by target Queue, and dispatches batches through
 * the QueuePublisher service before settling outbox states (published, failed,
 * dead). Per-row routing and per-Queue send failures mark only the affected
 * rows failed; the batch-claim and markFailed transactions abort the whole
 * program. An out-of-range batchSize fails the program instead of throwing.
 *
 * @param env - Automation worker environment bindings.
 * @param batchSize - Number of outbox events to claim per relay pass (1-100, default 50).
 * @returns Effect resolving to claimed/published/failed/dead counts; fails with
 *   a classified AutomationJobError (a RangeError surfaced as RetryableJobError
 *   when batchSize is invalid, or a classified persistence failure).
 */
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
      // Exit captures routing defects as well as failures, mirroring the
      // previous try/catch: any routing exception marks only this row failed.
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
          // The durable schedule now sits beyond the delivery horizon — for
          // example after a reschedule moved it later. The message is only a
          // trigger, so delivering nothing is safe: finalize the stale command
          // without a send and let the Due work claim pick the row up when it
          // comes due.
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
          // Queue batch acceptance is all-or-nothing from the relay's point of
          // view. Stable event IDs make a later retry safe if the provider
          // accepted a request before returning an ambiguous failure.
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
        failed.push(
          ...published.map(({ row }) => ({
            cause: Cause.squash(marked.cause),
            row,
          })),
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
