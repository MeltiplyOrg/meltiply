import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import { CoreApiError, type TenantServiceError } from "./api-errors";
import type { IdempotentResult } from "./core-types";
import { isPendingDistribution, settledDistributionStatuses } from "./distribution-service";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect, idempotentMutation } from "./idempotency";
import {
  isQueueInScope,
  mapQueue,
  queueChanges,
  queueConfigurationRoleError,
  queueNotFound,
  queuePage,
  queueRemovalError,
  queueRemovalRoleError,
  type PublishingQueue,
  type QueueMutationInput,
} from "./publishing-queue-rules";
import { postgresPublishingQueueRepository } from "./repositories/postgres-publishing-queue-repository";
import type {
  PublishingQueueRepositoryProvider,
  PublishingQueueTransaction,
} from "./repositories/publishing-queue-repository";
import { requireSupportedTimezone } from "./repositories/tenant-repository";
import type { QueueConfiguration } from "./validation";

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

function readQueue(tx: PublishingQueueTransaction, id: string, brandProfileId?: string) {
  return Effect.gen(function* () {
    const row = yield* tx.queue(id);
    if (!isQueueInScope(row, brandProfileId)) return yield* Effect.fail(queueNotFound());
    yield* tx.requireActiveBrandProfile(row.org_id, row.brand_profile_id);
    return row;
  });
}

function retireQueue(tx: PublishingQueueTransaction, id: string, brandProfileId: string) {
  return Effect.gen(function* () {
    const owner = yield* tx.queueOwner(id);
    if (!isQueueInScope(owner, brandProfileId)) return yield* Effect.fail(queueNotFound());
    yield* tx.requireActiveBrandProfile(owner.org_id, owner.brand_profile_id);
    if (yield* tx.hasPendingMemberships(id, settledDistributionStatuses)) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "queue_has_pending_posts",
          "Remove pending Posts before deleting this Queue. In-flight work must settle first.",
        ),
      );
    }
    yield* tx.retireQueue(id);
    return null;
  });
}

export function createPublishingQueueApiService({
  repository = postgresPublishingQueueRepository,
}: {
  repository?: PublishingQueueRepositoryProvider;
} = {}): PublishingQueueApiService {
  const runMutation = <Value>(
    env: ApiWorkerEnv,
    session: SessionClaims,
    action: "create" | "update" | "delete",
    id: string | undefined,
    input: QueueMutationInput,
    key: string,
    execute: (
      tx: PublishingQueueTransaction,
      organizationId: string,
    ) => Effect.Effect<Value, TenantServiceError>,
  ): Effect.Effect<IdempotentResult<Value>, TenantServiceError> =>
    Effect.gen(function* () {
      const hash = yield* hashIdempotencyRequestEffect(JSON.stringify({ action, id, input }));
      return yield* repository(env).transaction(session, (tx) =>
        Effect.gen(function* () {
          const organizationId = yield* tx.activeOrganizationId();
          const rejection = queueConfigurationRoleError(yield* tx.activeRole());
          if (rejection) return yield* Effect.fail(rejection);
          const status = action === "create" ? 201 : action === "delete" ? 204 : 200;
          return yield* idempotentMutation<Value, TenantServiceError>(
            tx,
            organizationId,
            `queue-${action}`,
            key,
            hash,
            status,
            () =>
              Effect.gen(function* () {
                yield* tx.lockOrganization(organizationId);
                yield* tx.requireActiveBrandProfile(organizationId, input.brand_profile_id);
                if (input.timezone !== undefined) {
                  yield* requireSupportedTimezone(tx, input.timezone);
                }
                return yield* execute(tx, organizationId);
              }),
          );
        }),
      );
    });

  return {
    list(env, session, brandProfileId, limit, cursor) {
      return repository(env).transaction(session, (tx) =>
        Effect.gen(function* () {
          const organizationId = yield* tx.activeOrganizationId();
          yield* tx.requireActiveBrandProfile(organizationId, brandProfileId);
          const rows = yield* tx.queuesAfter(brandProfileId, cursor ?? null, limit + 1);
          return queuePage(rows, limit);
        }),
      );
    },
    get(env, session, id) {
      return repository(env).transaction(session, (tx) =>
        readQueue(tx, id).pipe(Effect.map(mapQueue)),
      );
    },
    createQueue(env, session, input, key) {
      return runMutation(env, session, "create", undefined, input, key, (tx, organizationId) =>
        tx.insertQueue(organizationId, input),
      );
    },
    updateQueue(env, session, id, input, key) {
      return runMutation(env, session, "update", id, input, key, (tx) =>
        Effect.flatMap(readQueue(tx, id, input.brand_profile_id), (current) =>
          tx.updateQueue(id, queueChanges(current, input)),
        ),
      );
    },
    deleteQueue(env, session, id, input, key) {
      return runMutation(env, session, "delete", id, input, key, (tx) =>
        retireQueue(tx, id, input.brand_profile_id),
      );
    },
    removePost(env, session, queueId, postId, brandProfileId, key) {
      return Effect.gen(function* () {
        const hash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ queueId, postId, brandProfileId }),
        );
        return yield* repository(env).transaction(session, (tx) =>
          Effect.gen(function* () {
            const organizationId = yield* tx.activeOrganizationId();
            const rejection = queueRemovalRoleError(yield* tx.activeRole());
            if (rejection) return yield* Effect.fail(rejection);
            return yield* idempotentMutation<Schemas["Post"], TenantServiceError>(
              tx,
              organizationId,
              "queue-remove-post",
              key,
              hash,
              200,
              () =>
                Effect.gen(function* () {
                  yield* tx.lockOrganization(organizationId);
                  const post = yield* tx.lockQueuedPost(postId);
                  if (post.brandProfileId !== brandProfileId || post.queueId !== queueId) {
                    return yield* Effect.fail(
                      new CoreApiError(404, "not_found", "The Post is not a member of this Queue."),
                    );
                  }
                  yield* tx.requireActiveBrandProfile(organizationId, brandProfileId);
                  const outcomes = yield* tx.lockPostDistributions(postId);
                  const blocked = queueRemovalError(outcomes, isPendingDistribution);
                  if (blocked) return yield* Effect.fail(blocked);
                  const ids = outcomes.map((row) => row.id);
                  yield* tx.cancelUnstartedDistributions(ids);
                  yield* tx.withdrawPublishCommands(ids);
                  yield* tx.releaseQueueMembership(postId);
                  return yield* post.released();
                }),
            );
          }),
        );
      });
    },
  };
}
