import type { components } from "@meltiply/contracts/schema";
import { isoDateTime, type DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { requireActiveBrandProfileEffect } from "./brand-profile-guard";
import { CoreApiError } from "./core-types";
import type { EffectTransactionClient } from "./database";

type Schemas = components["schemas"];
export type PublishingQueue = Schemas["PublishingQueue"];
export type QueueMembership = Schemas["QueueMembership"];
export interface QueueRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  brand_profile_id: string;
  name: string;
  timezone: string;
  slots: PublishingQueue["slots"];
  created_at: Date | string;
  updated_at: Date | string;
}

/** Projects a validated stored Queue; retired plans remain available only through historical membership. */
export function mapQueue(row: QueueRow): PublishingQueue {
  return {
    id: row.id,
    brand_profile_id: row.brand_profile_id,
    name: row.name,
    timezone: row.timezone,
    slots: row.slots,
    created_at: isoDateTime(row.created_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

/** Reads an active, tenant-visible Queue and validates its active Brand Profile; callers serialize mutations with the organization lock. */
export function readQueueEffect(
  client: EffectTransactionClient,
  id: string,
  brandProfileId?: string,
) {
  return Effect.gen(function* () {
    const result = yield* client.query<QueueRow>(
      "SELECT * FROM publishing_queues WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const row = result.rows[0];
    if (!row || (brandProfileId !== undefined && row.brand_profile_id !== brandProfileId))
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The Queue was not found in this Brand Profile."),
      );
    yield* requireActiveBrandProfileEffect(client, row.org_id, row.brand_profile_id);
    return row;
  });
}

/** Reads one active membership in the current tenant, or null after release. Its saved name and UTC instant remain unchanged by Queue configuration edits. */
function readQueueMembershipEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<QueueMembership | null, DatabaseError> {
  return client
    .query<{ queue_id: string; queue_name: string; assigned_at: Date | string }>(
      "SELECT queue_id, queue_name, assigned_at FROM publishing_queue_memberships WHERE post_id = $1 AND released_at IS NULL",
      [postId],
    )
    .pipe(
      Effect.map((result) => {
        const row = result.rows[0];
        return row
          ? {
              queue_id: row.queue_id,
              queue_name: row.queue_name,
              assigned_at: isoDateTime(row.assigned_at),
            }
          : null;
      }),
    );
}

/** Reserves the earliest strictly future unoccupied instant under the existing organization/Post locks. Each slot advances only past occupied, elapsed or nonexistent occurrences; the indexed unique constraint arbitrates any missed race. PostgreSQL chooses the post-transition offset on overlaps; round-trip validation skips gaps. */
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
    if (membership) {
      if (
        membership.queue_id === queueId &&
        new Date(membership.assigned_at).getTime() > now.getTime()
      ) {
        return new Date(membership.assigned_at);
      }
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "queue_membership_exists",
          "Remove this Post from its Queue before changing plans or reusing an elapsed reservation.",
        ),
      );
    }
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

/** Rejects manual per-Post/per-Channel rescheduling while a Queue owns its instant; explicit removal is the only cutover. */
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

/** Releases a reservation after safely cancelling/deleting its pending work; no later reservation is moved. */
export function releaseQueueMembershipEffect(client: EffectTransactionClient, postId: string) {
  return client
    .query(
      "UPDATE publishing_queue_memberships SET released_at = now() WHERE post_id = $1 AND released_at IS NULL",
      [postId],
    )
    .pipe(Effect.asVoid);
}
