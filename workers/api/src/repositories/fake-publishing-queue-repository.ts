import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import { CoreApiError } from "../core-types";
import {
  mapQueue,
  type QueuedDistribution,
  type QueueMutationInput,
  type QueueRow,
} from "../publishing-queue-rules";
import {
  FakeTenantRepository,
  FakeTenantStore,
  FakeTenantTransaction,
} from "./fake-tenant-repository";
import type { LockedQueuedPost, PublishingQueueTransaction } from "./publishing-queue-repository";

type Schemas = components["schemas"];

export interface FakeQueueRow extends QueueRow {
  deleted_at: string | null;
}

export interface FakeQueuedPost {
  org_id: string;
  post: Schemas["Post"];
}

export interface FakeMembership {
  post_id: string;
  queue_id: string;
  released_at: string | null;
}

export interface FakeQueuedDistribution extends QueuedDistribution {
  post_id: string;
}

export interface FakePublishCommand {
  aggregate_id: string;
  state: "failed" | "leased" | "pending" | "published";
}

export class FakePublishingQueueStore extends FakeTenantStore {
  readonly distributions: FakeQueuedDistribution[] = [];
  readonly memberships: FakeMembership[] = [];
  readonly posts: FakeQueuedPost[] = [];
  readonly publishCommands: FakePublishCommand[] = [];
  readonly queues: FakeQueueRow[] = [];

  constructor(
    readonly now: () => Date,
    readonly newId: () => string,
  ) {
    super();
  }
}

class FakePublishingQueueTransaction
  extends FakeTenantTransaction
  implements PublishingQueueTransaction
{
  constructor(
    private readonly store: FakePublishingQueueStore,
    session: SessionClaims,
  ) {
    super(store, session);
  }

  private visibleQueue(id: string): FakeQueueRow | undefined {
    return this.store.queues.find(
      (queue) =>
        queue.id === id &&
        queue.deleted_at === null &&
        queue.org_id === this.member?.organizationId,
    );
  }

  private activeMembership(postId: string): FakeMembership | undefined {
    return this.store.memberships.find(
      (membership) => membership.post_id === postId && membership.released_at === null,
    );
  }

  queuesAfter(brandProfileId: string, cursor: string | null, count: number) {
    return Effect.sync(() =>
      this.store.queues
        .filter(
          (queue) =>
            queue.brand_profile_id === brandProfileId &&
            this.visibleQueue(queue.id) !== undefined &&
            (cursor === null || queue.id > cursor),
        )
        .toSorted((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, count)
        .map(mapQueue),
    );
  }

  queue(id: string) {
    return Effect.sync(() => {
      const queue = this.visibleQueue(id);
      if (!queue) return null;
      const { deleted_at: _deleted, ...row } = queue;
      return structuredClone(row);
    });
  }

  queueOwner(id: string) {
    return Effect.sync(() => {
      const queue = this.visibleQueue(id);
      return queue ? { brand_profile_id: queue.brand_profile_id, org_id: queue.org_id } : null;
    });
  }

  insertQueue(organizationId: string, input: QueueMutationInput) {
    return Effect.sync(() => {
      const now = this.store.now().toISOString();
      const row: FakeQueueRow = {
        brand_profile_id: input.brand_profile_id,
        created_at: now,
        deleted_at: null,
        id: this.store.newId(),
        name: input.name!,
        org_id: organizationId,
        slots: structuredClone(input.slots!),
        timezone: input.timezone!,
        updated_at: now,
      };
      this.insert(this.store.queues, row);
      return mapQueue(row);
    });
  }

  updateQueue(id: string, changes: Pick<QueueRow, "name" | "slots" | "timezone">) {
    return Effect.sync(() => {
      const row = this.visibleQueue(id)!;
      this.change(row, {
        ...structuredClone(changes),
        updated_at: this.store.now().toISOString(),
      });
      return mapQueue(row);
    });
  }

  hasPendingMemberships(queueId: string, settled: readonly Schemas["DistributionStatus"][]) {
    return Effect.sync(() =>
      this.store.memberships.some((membership) => {
        if (membership.queue_id !== queueId || membership.released_at !== null) return false;
        const outcomes = this.store.distributions.filter(
          (row) => row.post_id === membership.post_id,
        );
        return outcomes.length === 0 || outcomes.some((row) => !settled.includes(row.status));
      }),
    );
  }

  retireQueue(id: string) {
    return Effect.sync(() => {
      const row = this.visibleQueue(id);
      if (row) this.change(row, { deleted_at: this.store.now().toISOString() });
    });
  }

  lockQueuedPost(postId: string): Effect.Effect<LockedQueuedPost, CoreApiError> {
    const queueId = this.activeMembership(postId)?.queue_id ?? null;
    return Effect.flatMap(this.lock(`post:${postId}`), () => {
      const stored = this.store.posts.find(
        (row) => row.post.id === postId && row.org_id === this.member?.organizationId,
      );
      if (!stored) {
        return Effect.fail(new CoreApiError(404, "post_not_found", "The post was not found."));
      }
      return Effect.succeed({
        brandProfileId: stored.post.brand_profile_id,
        queueId,
        released: () =>
          Effect.sync(() => ({
            ...structuredClone(stored.post),
            distributions: stored.post.distributions.map((distribution) => ({
              ...distribution,
              status:
                this.store.distributions.find((row) => row.id === distribution.id)?.status ??
                distribution.status,
            })),
            queue_membership: null,
          })),
      });
    });
  }

  lockPostDistributions(postId: string) {
    return Effect.flatMap(this.lock(`distributions:${postId}`), () =>
      Effect.sync(() =>
        this.store.distributions
          .filter((row) => row.post_id === postId)
          .toSorted((a, b) => (a.id < b.id ? -1 : 1))
          .map(({ id, owned, status }) => ({ id, owned, status })),
      ),
    );
  }

  cancelUnstartedDistributions(ids: readonly string[]) {
    return Effect.sync(() => {
      for (const row of this.store.distributions) {
        if (ids.includes(row.id) && (row.status === "scheduled" || row.status === "queued")) {
          this.change(row, { status: "cancelled" });
        }
      }
    });
  }

  withdrawPublishCommands(ids: readonly string[]) {
    return Effect.sync(() => {
      const withdrawn = this.store.publishCommands.filter(
        (command) =>
          ids.includes(command.aggregate_id) &&
          (command.state === "pending" || command.state === "failed"),
      );
      for (const command of withdrawn) this.remove(this.store.publishCommands, command);
    });
  }

  releaseQueueMembership(postId: string) {
    return Effect.sync(() => {
      const membership = this.activeMembership(postId);
      if (membership) {
        this.change(membership, { released_at: this.store.now().toISOString() });
      }
    });
  }
}

export class FakePublishingQueueRepository extends FakeTenantRepository<FakePublishingQueueTransaction> {
  constructor(readonly store: FakePublishingQueueStore) {
    super((session) => new FakePublishingQueueTransaction(store, session));
  }
}
