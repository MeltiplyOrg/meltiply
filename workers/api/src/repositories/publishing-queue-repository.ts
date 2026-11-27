import type { components } from "@meltiply/contracts/schema";
import type { DatabaseError } from "@meltiply/domain";
import type { Effect } from "effect";

import type { PostServiceError } from "../post-types";
import type {
  PublishingQueue,
  QueuedDistribution,
  QueueMutationInput,
  QueueOwner,
  QueueRow,
} from "../publishing-queue-rules";
import type { TenantRepositoryProvider, TenantTransaction } from "./tenant-repository";

type Schemas = components["schemas"];

export interface LockedQueuedPost {
  brandProfileId: string;
  queueId: string | null;
  released(): Effect.Effect<Schemas["Post"], PostServiceError>;
}

export interface PublishingQueueQueries {
  queuesAfter(
    brandProfileId: string,
    cursor: string | null,
    count: number,
  ): Effect.Effect<PublishingQueue[], DatabaseError>;
  queue(id: string): Effect.Effect<QueueRow | null, DatabaseError>;
  queueOwner(id: string): Effect.Effect<QueueOwner | null, DatabaseError>;
  insertQueue(
    organizationId: string,
    input: QueueMutationInput,
  ): Effect.Effect<PublishingQueue, DatabaseError>;
  updateQueue(
    id: string,
    changes: Pick<QueueRow, "name" | "slots" | "timezone">,
  ): Effect.Effect<PublishingQueue, DatabaseError>;
  hasPendingMemberships(
    queueId: string,
    settled: readonly Schemas["DistributionStatus"][],
  ): Effect.Effect<boolean, DatabaseError>;
  retireQueue(id: string): Effect.Effect<void, DatabaseError>;
  lockQueuedPost(postId: string): Effect.Effect<LockedQueuedPost, PostServiceError>;
  lockPostDistributions(postId: string): Effect.Effect<QueuedDistribution[], DatabaseError>;
  cancelUnstartedDistributions(ids: readonly string[]): Effect.Effect<void, DatabaseError>;
  withdrawPublishCommands(ids: readonly string[]): Effect.Effect<void, DatabaseError>;
  releaseQueueMembership(postId: string): Effect.Effect<void, DatabaseError>;
}

export type PublishingQueueTransaction = TenantTransaction & PublishingQueueQueries;

export type PublishingQueueRepositoryProvider =
  TenantRepositoryProvider<PublishingQueueTransaction>;
