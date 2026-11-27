import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";

import { requireActiveBrandProfileEffect } from "./brand-profile-guard";
import { CoreApiError } from "./api-errors";
import type { EffectTransactionClient } from "./database";
import {
  isQueueInScope,
  mapQueueMembership,
  queueNotFound,
  reservationDecision,
  type QueueMembership,
  type QueueMembershipRow,
  type QueueOwner,
  type QueueRow,
} from "./publishing-queue-rules";

export const queueColumns =
  "id, org_id, brand_profile_id, name, timezone, slots, created_at, updated_at";

export function selectQueueEffect(client: EffectTransactionClient, id: string) {
  return client
    .query<QueueRow>(
      `SELECT ${queueColumns} FROM publishing_queues WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    .pipe(Effect.map((result) => result.rows[0] ?? null));
}

export function selectQueueOwnerEffect(client: EffectTransactionClient, id: string) {
  return client
    .query<QueueOwner>(
      "SELECT org_id, brand_profile_id FROM publishing_queues WHERE id = $1 AND deleted_at IS NULL",
      [id],
    )
    .pipe(Effect.map((result) => result.rows[0] ?? null));
}

function readQueueEffect(client: EffectTransactionClient, id: string, brandProfileId: string) {
  return Effect.gen(function* () {
    const row = yield* selectQueueEffect(client, id);
    if (!isQueueInScope(row, brandProfileId)) return yield* Effect.fail(queueNotFound());
    yield* requireActiveBrandProfileEffect(client, row.org_id, row.brand_profile_id);
    return row;
  });
}

function readQueueMembershipEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<QueueMembership | null, DatabaseError> {
  return client
    .query<QueueMembershipRow>(
      "SELECT queue_id, queue_name, assigned_at FROM publishing_queue_memberships WHERE post_id = $1 AND released_at IS NULL",
      [postId],
    )
    .pipe(Effect.map((result) => mapQueueMembership(result.rows[0])));
}
export function reserveQueueSlotEffect(
  client: EffectTransactionClient,
  organizationId: string,
  brandProfileId: string,
  postId: string,
  queueId: string,
  now: Date,
) {
  return Effect.gen(function* () {
    const queue = yield* readQueueEffect(client, queueId, brandProfileId);
    const membership = yield* readQueueMembershipEffect(client, postId);
    const decision = reservationDecision(membership, queueId, now);
    if (decision.kind === "reuse") return decision.assignedAt;
    if (decision.kind === "reject") return yield* Effect.fail(decision.error);
    const result = yield* client.query<{ assigned_at: Date | string }>(
      `WITH RECURSIVE candidates(wall_time) AS (
         SELECT (($2::timestamptz AT TIME ZONE $3)::date
                  + ((slot.weekday - EXTRACT(DOW FROM $2::timestamptz AT TIME ZONE $3)::integer + 7) % 7))
                + slot.time::time
           FROM jsonb_to_recordset($4::jsonb) AS slot(weekday integer, time text)
         UNION ALL
         SELECT c.wall_time + interval '7 days'
           FROM candidates c
          WHERE (c.wall_time AT TIME ZONE $3) <= $2::timestamptz
             OR ((c.wall_time AT TIME ZONE $3) AT TIME ZONE $3) <> c.wall_time
             OR EXISTS (SELECT 1 FROM publishing_queue_memberships m
                         WHERE m.queue_id = $1 AND m.released_at IS NULL
                           AND m.assigned_at = (c.wall_time AT TIME ZONE $3))
       ), selected AS (
         SELECT MIN(wall_time AT TIME ZONE $3) AS instant FROM candidates c
          WHERE (wall_time AT TIME ZONE $3) > $2::timestamptz
            AND ((wall_time AT TIME ZONE $3) AT TIME ZONE $3) = wall_time
            AND NOT EXISTS (SELECT 1 FROM publishing_queue_memberships m
                             WHERE m.queue_id = $1 AND m.released_at IS NULL
                               AND m.assigned_at = (c.wall_time AT TIME ZONE $3))
       )
       INSERT INTO publishing_queue_memberships (org_id, brand_profile_id, queue_id, post_id, queue_name, assigned_at)
       SELECT $5, $6, $1, $7, $8, instant FROM selected
       RETURNING assigned_at`,
      [
        queueId,
        now.toISOString(),
        queue.timezone,
        JSON.stringify(queue.slots),
        organizationId,
        brandProfileId,
        postId,
        queue.name,
      ],
    );
    return new Date(result.rows[0]!.assigned_at);
  });
}

export function requireNoQueueMembershipEffect(client: EffectTransactionClient, postId: string) {
  return Effect.gen(function* () {
    const membership = yield* readQueueMembershipEffect(client, postId);
    if (membership)
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "queue_membership_exists",
          "Remove this Post from its Queue before manually changing its Schedule.",
        ),
      );
  });
}

export function releaseQueueMembershipEffect(client: EffectTransactionClient, postId: string) {
  return client
    .query(
      "UPDATE publishing_queue_memberships SET released_at = now() WHERE post_id = $1 AND released_at IS NULL",
      [postId],
    )
    .pipe(Effect.asVoid);
}
