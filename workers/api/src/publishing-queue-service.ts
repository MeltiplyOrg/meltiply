import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import { CoreApiError, type TenantServiceError } from "./api-errors";
import { requireActiveWorkspaceAdminEffect } from "./authorization";
import { requireActiveBrandProfileEffect } from "./brand-profile-guard";
import type { IdempotentResult } from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect,
  type EffectTransactionClient,
} from "./database";
import {
  deletePendingDistributionOutboxEffect,
  isPendingDistribution,
  providerOwnedDistributionSql,
  settledDistributionStatuses,
} from "./distribution-service";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { withIdempotentMutation } from "./idempotent-mutation";
import { lockOrganizationEffect } from "./organization-lock";
import { assembleSinglePostEffect, lockPostEffect } from "./post-service";
import {
  mapQueue,
  queueColumns,
  readQueueEffect,
  releaseQueueMembershipEffect,
  type PublishingQueue,
  type QueueRow,
} from "./publishing-queue-store";
import { validateIanaTimezoneEffect, type QueueConfiguration } from "./validation";

type Schemas = components["schemas"];
type QueuePatchInput = Pick<QueueConfiguration, "brand_profile_id"> &
  Partial<Omit<QueueConfiguration, "brand_profile_id">>;
type QueueScopeInput = Pick<QueueConfiguration, "brand_profile_id">;

export interface PublishingQueueApiService {
  list(
    env: ApiWorkerEnv,
    session: SessionClaims,
    brandProfileId: string,
    limit: number,
    cursor?: string,
  ): Effect.Effect<Schemas["QueueListResponse"], TenantServiceError>;
  get(
    env: ApiWorkerEnv,
    session: SessionClaims,
    id: string,
  ): Effect.Effect<PublishingQueue, TenantServiceError>;
  createQueue(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: QueueConfiguration,
    key: string,
  ): Effect.Effect<IdempotentResult<PublishingQueue>, TenantServiceError>;
  updateQueue(
    env: ApiWorkerEnv,
    session: SessionClaims,
    id: string,
    input: QueuePatchInput,
    key: string,
  ): Effect.Effect<IdempotentResult<PublishingQueue>, TenantServiceError>;
  deleteQueue(
    env: ApiWorkerEnv,
    session: SessionClaims,
    id: string,
    input: QueueScopeInput,
    key: string,
  ): Effect.Effect<IdempotentResult<null>, TenantServiceError>;
  removePost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    queueId: string,
    postId: string,
    brandProfileId: string,
    key: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, TenantServiceError>;
}

function runQueueAdminMutation<T>(
  env: ApiWorkerEnv,
  session: SessionClaims,
  action: "create" | "update" | "delete",
  id: string | undefined,
  brandProfileId: string,
  payload: unknown,
  status: number,
  key: string,
  run: (
    tx: EffectTransactionClient,
    organizationId: string,
  ) => Effect.Effect<T, TenantServiceError>,
): Effect.Effect<IdempotentResult<T>, TenantServiceError> {
  return Effect.gen(function* () {
    const hash = yield* hashIdempotencyRequestEffect(
      JSON.stringify({ action, id, input: payload }),
    );
    return yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const organizationId = yield* activeOrganizationIdEffect(client);
        yield* requireActiveWorkspaceAdminEffect(
          client,
          "Only Workspace Admins can configure Queues.",
        );
        return yield* withIdempotentMutation<T, TenantServiceError>(
          client,
          organizationId,
          `queue-${action}`,
          key,
          hash,
          status,
          (tx) =>
            Effect.gen(function* () {
              yield* lockOrganizationEffect(tx, organizationId);
              yield* requireActiveBrandProfileEffect(tx, organizationId, brandProfileId);
              return yield* run(tx, organizationId);
            }),
        );
      }),
    );
  });
}

export function createPublishingQueueApiService(): PublishingQueueApiService {
  return {
    list(env, session, brandProfileId, limit, cursor) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const organizationId = yield* activeOrganizationIdEffect(client);
          yield* requireActiveBrandProfileEffect(client, organizationId, brandProfileId);
          const rows = yield* client.query<QueueRow>(
            `SELECT ${queueColumns} FROM publishing_queues WHERE brand_profile_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
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

    get(env, session, id) {
      return withTenantTransactionEffect(env, session, (client) =>
        readQueueEffect(client, id).pipe(Effect.map(mapQueue)),
      );
    },

    createQueue(env, session, input, key) {
      return runQueueAdminMutation(
        env,
        session,
        "create",
        undefined,
        input.brand_profile_id,
        input,
        201,
        key,
        (tx, organizationId) =>
          Effect.gen(function* () {
            yield* validateIanaTimezoneEffect(tx, input.timezone);
            const result = yield* tx.query<QueueRow>(
              `INSERT INTO publishing_queues (org_id, brand_profile_id, name, timezone, slots) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${queueColumns}`,
              [
                organizationId,
                input.brand_profile_id,
                input.name,
                input.timezone,
                JSON.stringify(input.slots),
              ],
            );
            return mapQueue(result.rows[0]!);
          }),
      );
    },

    updateQueue(env, session, id, input, key) {
      return runQueueAdminMutation(
        env,
        session,
        "update",
        id,
        input.brand_profile_id,
        input,
        200,
        key,
        (tx) =>
          Effect.gen(function* () {
            if (input.timezone !== undefined) {
              yield* validateIanaTimezoneEffect(tx, input.timezone);
            }
            const current = yield* readQueueEffect(tx, id, input.brand_profile_id);
            const result = yield* tx.query<QueueRow>(
              `UPDATE publishing_queues SET name = $2, timezone = $3, slots = $4::jsonb, updated_at = now() WHERE id = $1 RETURNING ${queueColumns}`,
              [
                id,
                input.name ?? current.name,
                input.timezone ?? current.timezone,
                JSON.stringify(input.slots ?? current.slots),
              ],
            );
            return mapQueue(result.rows[0]!);
          }),
      );
    },

    deleteQueue(env, session, id, input, key) {
      return runQueueAdminMutation(
        env,
        session,
        "delete",
        id,
        input.brand_profile_id,
        input,
        204,
        key,
        (tx) =>
          Effect.gen(function* () {
            yield* readQueueEffect(tx, id, input.brand_profile_id);
            const pending = yield* tx.query<{ exists: boolean }>(
              `SELECT EXISTS (
                SELECT 1 FROM publishing_queue_memberships m
                 WHERE m.queue_id = $1 AND m.released_at IS NULL
                   AND (NOT EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id)
                     OR EXISTS (SELECT 1 FROM distributions d WHERE d.post_id = m.post_id
                       AND d.status <> ALL($2::text[])))
              ) AS exists`,
              [id, settledDistributionStatuses],
            );
            if (pending.rows[0]?.exists) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "queue_has_pending_posts",
                  "Remove pending Posts before deleting this Queue. In-flight work must settle first.",
                ),
              );
            }
            yield* tx.query(
              "UPDATE publishing_queues SET deleted_at = now(), updated_at = now() WHERE id = $1",
              [id],
            );
            return null;
          }),
      );
    },

    removePost(env, session, queueId, postId, brandProfileId, key) {
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
            if (!["admin", "editor"].includes(role.rows[0]?.role ?? "")) {
              return yield* Effect.fail(
                new CoreApiError(403, "forbidden_role", "Your Workspace role is read-only."),
              );
            }
            return yield* withIdempotentMutation<Schemas["Post"], TenantServiceError>(
              client,
              organizationId,
              "queue-remove-post",
              key,
              hash,
              200,
              (tx) =>
                Effect.gen(function* () {
                  yield* lockOrganizationEffect(tx, organizationId);
                  const post = yield* lockPostEffect(tx, postId, true);
                  if (
                    post.brand_profile_id !== brandProfileId ||
                    post.queue_membership?.queue_id !== queueId
                  ) {
                    return yield* Effect.fail(
                      new CoreApiError(404, "not_found", "The Post is not a member of this Queue."),
                    );
                  }
                  yield* requireActiveBrandProfileEffect(tx, organizationId, brandProfileId);
                  const outcomes = yield* tx.query<{
                    id: string;
                    status: Schemas["DistributionStatus"];
                    owned: boolean;
                  }>(
                    `SELECT d.id, d.status, ${providerOwnedDistributionSql("d", true)} AS owned
                      FROM distributions d WHERE d.post_id = $1 ORDER BY d.id FOR UPDATE`,
                    [postId],
                  );
                  if (
                    outcomes.rows.some(
                      (row) =>
                        row.owned ||
                        !(isPendingDistribution(row.status) || row.status === "cancelled"),
                    )
                  ) {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "queue_post_in_flight",
                        "Only unclaimed pending Posts can be removed. Provider-owned outcomes remain unchanged.",
                      ),
                    );
                  }
                  const ids = outcomes.rows.map((row) => row.id);
                  yield* tx.query(
                    "UPDATE distributions SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[]) AND status IN ('scheduled', 'queued')",
                    [ids],
                  );
                  yield* deletePendingDistributionOutboxEffect(tx, ids);
                  yield* releaseQueueMembershipEffect(tx, postId);
                  return yield* assembleSinglePostEffect(tx, {
                    ...post,
                    queue_membership: null,
                  });
                }),
            );
          }),
        );
      });
    },
  };
}
