import type { EffectTransactionClient } from "@meltiply/database";
import { Effect } from "effect";

import { assembleSinglePostEffect, lockPostEffect } from "../post-service";
import { mapQueue, type QueuedDistribution, type QueueRow } from "../publishing-queue-rules";
import {
  queueColumns,
  releaseQueueMembershipEffect,
  selectQueueEffect,
  selectQueueOwnerEffect,
} from "../publishing-queue-store";
import { postgresTenantRepository } from "./postgres-tenant-repository";
import type { PublishingQueueQueries } from "./publishing-queue-repository";

function publishingQueueQueries(client: EffectTransactionClient): PublishingQueueQueries {
  const written = (sql: string, values: readonly unknown[]) =>
    client.query<QueueRow>(sql, values).pipe(Effect.map((result) => mapQueue(result.rows[0]!)));
  return {
    queuesAfter: (brandProfileId, cursor, count) =>
      client
        .query<QueueRow>(
          `SELECT ${queueColumns} FROM publishing_queues WHERE brand_profile_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
          [brandProfileId, cursor, count],
        )
        .pipe(Effect.map((result) => result.rows.map(mapQueue))),
    queue: (id) => selectQueueEffect(client, id),
    queueOwner: (id) => selectQueueOwnerEffect(client, id),
    insertQueue: (organizationId, input) =>
      written(
        `INSERT INTO publishing_queues (org_id, brand_profile_id, name, timezone, slots) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${queueColumns}`,
        [
          organizationId,
          input.brand_profile_id,
          input.name,
          input.timezone,
          JSON.stringify(input.slots),
        ],
      ),
    updateQueue: (id, changes) =>
      written(
        `UPDATE publishing_queues SET name = $2, timezone = $3, slots = $4::jsonb, updated_at = now() WHERE id = $1 RETURNING ${queueColumns}`,
        [id, changes.name, changes.timezone, JSON.stringify(changes.slots)],
      ),
    hasPendingMemberships: (queueId, settled) =>
      client
        .query<{ exists: boolean }>(
          `SELECT EXISTS (
                    SELECT 1 FROM publishing_queue_memberships m
                     WHERE m.queue_id = $1 AND m.released_at IS NULL
                       AND (NOT EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id)
                         OR EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id
                           AND d.status <> ALL($2::text[])))
                  ) AS exists`,
          [queueId, settled],
        )
        .pipe(Effect.map((result) => result.rows[0]?.exists === true)),
    retireQueue: (id) =>
      client
        .query(
          "UPDATE publishing_queues SET deleted_at = now(), updated_at = now() WHERE id = $1",
          [id],
        )
        .pipe(Effect.asVoid),
    lockQueuedPost: (postId) =>
      lockPostEffect(client, postId, true).pipe(
        Effect.map((post) => ({
          brandProfileId: post.brand_profile_id,
          queueId: post.queue_membership?.queue_id ?? null,
          released: () => assembleSinglePostEffect(client, { ...post, queue_membership: null }),
        })),
      ),
    lockPostDistributions: (postId) =>
      client
        .query<QueuedDistribution>(
          `SELECT d.id, d.status,
                  (d.attempt_count > 0 OR d.provider_operation_id IS NOT NULL
                   OR d.last_attempt_at IS NOT NULL OR d.published_at IS NOT NULL
                   OR d.platform_post_id IS NOT NULL OR d.cancel_requested_at IS NOT NULL
                   OR EXISTS (SELECT 1 FROM provider_operations p WHERE p.distribution_id = d.id)
                   OR EXISTS (SELECT 1 FROM outbox_events e WHERE e.aggregate_id = d.id
                               AND e.topic = 'distribution.publish.requested' AND e.state = 'leased')) AS owned
                  FROM distributions d WHERE d.post_id = $1 ORDER BY d.id FOR UPDATE`,
          [postId],
        )
        .pipe(Effect.map((result) => result.rows)),
    cancelUnstartedDistributions: (ids) =>
      client
        .query(
          "UPDATE distributions SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[]) AND status IN ('scheduled', 'queued')",
          [ids],
        )
        .pipe(Effect.asVoid),
    withdrawPublishCommands: (ids) =>
      client
        .query(
          "DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[]) AND topic = 'distribution.publish.requested' AND state IN ('pending', 'failed')",
          [ids],
        )
        .pipe(Effect.asVoid),
    releaseQueueMembership: (postId) => releaseQueueMembershipEffect(client, postId),
  };
}

export const postgresPublishingQueueRepository = postgresTenantRepository(publishingQueueQueries);
