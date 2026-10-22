import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { IdempotentResult } from "./core-types";
import type { PostServiceError } from "./post-types";
import { Effect } from "effect";
import { requireActiveBrandProfileEffect } from "./brand-profile-guard";
import { CoreApiError } from "./core-types";
import { activeOrganizationIdEffect, withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";
import { assembleSinglePostEffect, lockPostEffect } from "./post-service";
import {
  mapQueue,
  readQueueEffect,
  releaseQueueMembershipEffect,
  type QueueConfiguration,
  type QueueRow,
  type PublishingQueue,
} from "./publishing-queue-store";

type Schemas = components["schemas"];
type QueueMutationInput = Pick<QueueConfiguration, "brand_profile_id"> &
  Partial<Omit<QueueConfiguration, "brand_profile_id">>;

/** Tenant-scoped recurring-plan operations; writes return replay metadata and retirement returns null. */
export interface PublishingQueueApiService {
  list(
    env: ApiWorkerEnv,
    session: SessionClaims,
    brandProfileId: string,
    limit: number,
    cursor?: string,
  ): Effect.Effect<Schemas["QueueListResponse"], PostServiceError>;
  get(
    env: ApiWorkerEnv,
    session: SessionClaims,
    id: string,
  ): Effect.Effect<PublishingQueue, PostServiceError>;
  mutate(
    env: ApiWorkerEnv,
    session: SessionClaims,
    action: "create" | "update" | "delete",
    id: string | undefined,
    input: QueueMutationInput,
    key: string,
  ): Effect.Effect<IdempotentResult<PublishingQueue | null>, PostServiceError>;
  removePost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    queueId: string,
    postId: string,
    brandProfileId: string,
    key: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, PostServiceError>;
}

/** Creates the tenant-backed Queue interface. Configuration is Admin-only; membership removal is Editor/Admin, transactionally idempotent, and never alters Provider-owned work. */
export function createPublishingQueueApiService(): PublishingQueueApiService {
  return {
    /** Lists at most limit active plans in UUID order within one active Brand Profile; cursor is exclusive. */
    list(
      env: ApiWorkerEnv,
      session: SessionClaims,
      brandProfileId: string,
      limit: number,
      cursor?: string,
    ) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const organizationId = yield* activeOrganizationIdEffect(client);
          yield* requireActiveBrandProfileEffect(client, organizationId, brandProfileId);
          const rows = yield* client.query<QueueRow>(
            "SELECT * FROM publishing_queues WHERE brand_profile_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3",
            [brandProfileId, cursor ?? null, limit + 1],
          );
          const items = rows.rows.slice(0, limit).map(mapQueue);
          return {
            items,
            next_cursor: rows.rows.length > limit ? items[items.length - 1]!.id : null,
          };
        }),
      );
    },
    /** Reads an active plan only when tenant RLS and its active Brand Profile permit it. */
    get(env: ApiWorkerEnv, session: SessionClaims, id: string) {
      return withTenantTransactionEffect(env, session, (client) =>
        readQueueEffect(client, id).pipe(Effect.map(mapQueue)),
      );
    },
    /** Writes configuration once per key under the scheduling lock. Edits freeze reservations; retirement refuses any unresolved Distribution or unfulfilled reservation. */
    mutate(
      env: ApiWorkerEnv,
      session: SessionClaims,
      action: "create" | "update" | "delete",
      id: string | undefined,
      input: QueueMutationInput,
      key: string,
    ) {
      return Effect.gen(function* () {
        const hash = yield* hashIdempotencyRequestEffect(JSON.stringify({ action, id, input }));
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const role = yield* client.query<{ role: string }>(
              "SELECT public.auth_active_org_role() AS role",
            );
            if (role.rows[0]?.role !== "admin")
              return yield* Effect.fail(
                new CoreApiError(
                  403,
                  "workspace_admin_required",
                  "Only Workspace Admins can configure Queues.",
                ),
              );
            const scope = `queue-${action}`;
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              scope,
              key,
              hash,
            );
            if (replay)
              return { replayed: true, value: replay.response_body as PublishingQueue | null };
            yield* lockOrganizationEffect(client, organizationId);
            yield* requireActiveBrandProfileEffect(client, organizationId, input.brand_profile_id);
            if (input.timezone !== undefined) {
              const timezone = yield* client.query<{ valid: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS valid",
                [input.timezone],
              );
              if (!timezone.rows[0]?.valid)
                return yield* Effect.fail(
                  new CoreApiError(422, "validation_error", "Use a supported IANA timezone."),
                );
            }
            let value: PublishingQueue | null = null;
            if (action === "create") {
              const result = yield* client.query<QueueRow>(
                "INSERT INTO publishing_queues (org_id, brand_profile_id, name, timezone, slots) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *",
                [
                  organizationId,
                  input.brand_profile_id,
                  input.name,
                  input.timezone,
                  JSON.stringify(input.slots),
                ],
              );
              value = mapQueue(result.rows[0]!);
            } else {
              const current = yield* readQueueEffect(client, id!, input.brand_profile_id);
              if (action === "delete") {
                const pending = yield* client.query<{ exists: boolean }>(
                  `SELECT EXISTS (
                SELECT 1 FROM publishing_queue_memberships m
                 WHERE m.queue_id = $1 AND m.released_at IS NULL
                   AND (NOT EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id)
                     OR EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id
                       AND d.status NOT IN ('published', 'failed', 'cancelled')))
              ) AS exists`,
                  [id],
                );
                if (pending.rows[0]?.exists)
                  return yield* Effect.fail(
                    new CoreApiError(
                      409,
                      "queue_has_pending_posts",
                      "Remove pending Posts before deleting this Queue. In-flight work must settle first.",
                    ),
                  );
                yield* client.query(
                  "UPDATE publishing_queues SET deleted_at = now(), updated_at = now() WHERE id = $1",
                  [id],
                );
              } else {
                const result = yield* client.query<QueueRow>(
                  "UPDATE publishing_queues SET name = $2, timezone = $3, slots = $4::jsonb, updated_at = now() WHERE id = $1 RETURNING *",
                  [
                    id,
                    input.name ?? current.name,
                    input.timezone ?? current.timezone,
                    JSON.stringify(input.slots ?? current.slots),
                  ],
                );
                value = mapQueue(result.rows[0]!);
              }
            }
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              scope,
              key,
              action === "create" ? 201 : action === "delete" ? 204 : 200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },
    /** Removes only an editable reservation, preserving composition and cancelled Channel history. Distribution row locks arbitrate background claims; consumed leases, attempts and ambiguous outcomes refuse removal. */
    removePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      queueId: string,
      postId: string,
      brandProfileId: string,
      key: string,
    ) {
      return Effect.gen(function* () {
        const hash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ queueId, postId, brandProfileId }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const role = yield* client.query<{ role: string }>(
              "SELECT public.auth_active_org_role() AS role",
            );
            if (!["admin", "editor"].includes(role.rows[0]?.role ?? ""))
              return yield* Effect.fail(
                new CoreApiError(403, "forbidden_role", "Your Workspace role is read-only."),
              );
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "queue-remove-post",
              key,
              hash,
            );
            if (replay) return { replayed: true, value: replay.response_body as Schemas["Post"] };
            yield* lockOrganizationEffect(client, organizationId);
            const post = yield* lockPostEffect(client, postId);
            yield* readQueueEffect(client, queueId, brandProfileId);
            if (
              post.brand_profile_id !== brandProfileId ||
              post.queue_membership?.queue_id !== queueId
            )
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The Post is not a member of this Queue."),
              );
            const outcomes = yield* client.query<{ id: string; status: string; owned: boolean }>(
              `SELECT d.id, d.status,
            (d.attempt_count > 0 OR d.provider_operation_id IS NOT NULL
             OR d.last_attempt_at IS NOT NULL OR d.published_at IS NOT NULL
             OR d.platform_post_id IS NOT NULL OR d.cancel_requested_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM provider_operations p WHERE p.distribution_id = d.id)
             OR EXISTS (SELECT 1 FROM outbox_events e WHERE e.aggregate_id = d.id
                         AND e.topic = 'distribution.publish.requested' AND e.state = 'leased')) AS owned
            FROM distributions d WHERE d.post_id = $1 ORDER BY d.id FOR UPDATE`,
              [postId],
            );
            if (
              outcomes.rows.some(
                (row) => row.owned || !["scheduled", "queued", "cancelled"].includes(row.status),
              )
            )
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "queue_post_in_flight",
                  "Only unclaimed pending Posts can be removed. Provider-owned outcomes remain unchanged.",
                ),
              );
            const ids = outcomes.rows.map((row) => row.id);
            yield* client.query(
              "UPDATE distributions SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[]) AND status IN ('scheduled', 'queued')",
              [ids],
            );
            yield* client.query(
              "DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[]) AND topic = 'distribution.publish.requested' AND state IN ('pending', 'failed')",
              [ids],
            );
            yield* releaseQueueMembershipEffect(client, postId);
            const value = yield* assembleSinglePostEffect(client, {
              ...post,
              queue_membership: null,
            });
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "queue-remove-post",
              key,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },
  };
}
