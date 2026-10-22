import type { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { DatabaseError, DomainError } from "@meltiply/domain";
import type { ProviderPublishOptions } from "@meltiply/providers";

import type { CoreApiError, IdempotentResult } from "./core-types";
import type { ApiWorkerEnv } from "./env";

type Schemas = components["schemas"];

/**
 * List selector for the Post read surface. Omitting `brandProfileId` selects the
 * workspace-wide aggregate across active Brand Profiles; omitting `status`
 * returns every retained Post.
 */
interface PostFilters {
  brandProfileId?: string;
  queueId?: string;
  limit: number;
  offset: number;
  status?: Schemas["PostStatus"];
}

/**
 * Saved per-Channel settings for one Post target.
 *
 * `attachmentIds` narrows the publication to an ordered subset of the Post's
 * attachments: `null` inherits every Post attachment in Post order, while an
 * empty array publishes this Channel as text-only without splitting the Post.
 */
interface PostTargetInput {
  attachmentIds?: string[] | null;
  descriptionOverride?: string | null;
  hashtags?: string[];
  platformAccountId: string;
  providerOptions?: ProviderPublishOptions;
  titleOverride?: string | null;
}

interface CreatePostInput {
  /** Ordered durable Asset identifiers attached to the new Post. */
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
}

/**
 * Authoritative draft save. Omitted members keep their stored value; supplying
 * `attachmentIds` replaces the complete ordered attachment set and supplying
 * `targets` replaces the complete saved target set. Saving never requires a
 * Channel selection.
 */
interface UpdatePostInput {
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
}

/**
 * Scheduling intent for an existing Post. Exactly one of `scheduledAt`
 * (null publishes immediately) and `queueId` must be supplied. Omitting
 * `targets` uses saved targets; supplying them replaces the saved target set.
 */
type SchedulePostInput = {
  brandProfileId: string;
  targets?: PostTargetInput[];
} & ({ scheduledAt: Date | null; queueId?: never } | { queueId: string; scheduledAt?: never });
/**
 * Scoped delete intent for an existing Post.
 *
 * `brandProfileId` is mandatory: deleting a Post is a mutation, and the caller
 * must name the Brand Profile the Post is expected to belong to, exactly as the
 * save and schedule mutations do. It is checked against the stored owner so a
 * Post can never be deleted from the workspace-wide aggregate view, where no
 * single identity has been selected.
 */
interface DeletePostInput {
  brandProfileId: string;
}

export type PostServiceError = CoreApiError | DomainError | DatabaseError;

/**
 * Effect-first application service owning the durable Post composition surface:
 * one Post identity per composition with ordered attachments, saved per-Channel
 * settings, and independently tracked publication outcomes.
 */
export interface PostApiService {
  createPost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: CreatePostInput,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, PostServiceError>;
  deletePost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    postId: string,
    input: DeletePostInput,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, PostServiceError>;
  getPost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    postId: string,
  ): Effect.Effect<Schemas["Post"], PostServiceError>;
  listPosts(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: PostFilters,
  ): Effect.Effect<Schemas["PostListResponse"], PostServiceError>;
  schedulePost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    postId: string,
    input: SchedulePostInput,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, PostServiceError>;
  updatePost(
    env: ApiWorkerEnv,
    session: SessionClaims,
    postId: string,
    input: UpdatePostInput,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<Schemas["Post"]>, PostServiceError>;
}

export type {
  CreatePostInput,
  DeletePostInput,
  PostFilters,
  PostTargetInput,
  SchedulePostInput,
  UpdatePostInput,
};
