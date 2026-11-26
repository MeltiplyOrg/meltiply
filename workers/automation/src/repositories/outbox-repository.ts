import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "../database";
import type { AutomationEnv } from "../env";

export interface OutboxRow extends Record<string, unknown> {
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

export interface OutboxFailureUpdate {
  readonly delaySeconds: number;
  readonly id: string;
  readonly lastError: string;
}

export interface OutboxRepository {
  readonly claim: (
    batchSize: number,
    maximumAttempts: number,
    leaseSeconds: number,
  ) => Effect.Effect<OutboxRow[], DatabaseError>;
  readonly markPublished: (eventIds: readonly string[]) => Effect.Effect<void, DatabaseError>;
  readonly markFailed: (
    updates: readonly OutboxFailureUpdate[],
    maximumAttempts: number,
  ) => Effect.Effect<number, DatabaseError>;
}

export function createPostgresOutboxRepository(env: AutomationEnv): OutboxRepository {
  return {
    claim: (batchSize, maximumAttempts, leaseSeconds) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.map(
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
        ),
      ),

    markPublished: (eventIds) =>
      eventIds.length === 0
        ? Effect.void
        : withSystemTransactionEffect(env, (client) =>
            Effect.asVoid(
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
            ),
          ),

    markFailed: (updates, maximumAttempts) =>
      updates.length === 0
        ? Effect.succeed(0)
        : withSystemTransactionEffect(env, (client) =>
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
                [
                  updates.map((u) => u.id),
                  updates.map((u) => u.delaySeconds),
                  updates.map((u) => u.lastError),
                  maximumAttempts,
                ],
              ),
              (result) => result.rows.filter(({ state }) => state === "dead").length,
            ),
          ),
  };
}

export interface FakeOutboxEvent extends OutboxRow {
  last_error: string | null;
  state: "pending" | "leased" | "published" | "failed" | "dead";
}

export class FakeOutboxStore {
  readonly events: FakeOutboxEvent[] = [];
  readonly publishedIds: string[][] = [];
  readonly failedUpdates: OutboxFailureUpdate[][] = [];
  markPublishedError: DatabaseError | null = null;
}

export function createFakeOutboxRepository(store: FakeOutboxStore): OutboxRepository {
  return {
    claim: (batchSize, maximumAttempts) =>
      Effect.sync(() => {
        const claimed: OutboxRow[] = [];
        for (const event of store.events) {
          if (claimed.length >= batchSize) break;
          if (
            (event.state === "pending" || event.state === "failed") &&
            event.attempt_count < maximumAttempts
          ) {
            event.state = "leased";
            event.attempt_count += 1;
            claimed.push(structuredClone(event));
          }
        }
        return claimed;
      }),

    markPublished: (eventIds) => {
      if (store.markPublishedError) {
        const err = store.markPublishedError;
        store.markPublishedError = null;
        return Effect.fail(err);
      }
      return Effect.sync(() => {
        store.publishedIds.push([...eventIds]);
        const ids = new Set(eventIds);
        for (const event of store.events) {
          if (ids.has(event.id) && event.state === "leased") {
            event.state = "published";
            event.last_error = null;
          }
        }
      });
    },

    markFailed: (updates, maximumAttempts) =>
      Effect.sync(() => {
        store.failedUpdates.push([...updates]);
        let dead = 0;
        for (const update of updates) {
          const event = store.events.find(
            (entry) => entry.id === update.id && entry.state === "leased",
          );
          if (!event) continue;
          event.last_error = update.lastError;
          if (event.attempt_count >= maximumAttempts) {
            event.state = "dead";
            dead += 1;
          } else {
            event.state = "failed";
          }
        }
        return dead;
      }),
  };
}
