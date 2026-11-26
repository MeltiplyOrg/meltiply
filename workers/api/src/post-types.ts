import type { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { DatabaseError, ActiveOrganizationRequiredError } from "@meltiply/domain";
import type {
  FacebookPublishOptions,
  InstagramPostType,
  InstagramTrialGraduation,
  TikTokPrivacyLevel,
  TikTokPublishOptions,
  YouTubePublishOptions,
} from "@meltiply/providers";

import type { CoreApiError, IdempotentResult } from "./core-types";
import type { ApiWorkerEnv } from "./env";

type Schemas = components["schemas"];

interface PostFilters {
  brandProfileId?: string;
  queueId?: string;
  queueWindow?: { start: Date; end: Date };
  limit: number;
  offset: number;
  status?: Schemas["PostStatus"];
}

export interface PostProviderOptions {
  threads?: components["schemas"]["ThreadsPostOptions"];
  facebook?: FacebookPublishOptions;
  instagram?: {
    content?: components["schemas"]["InstagramContentOptions"];
    mediaOptions?: components["schemas"]["InstagramContentOptions"][];
    postType?: InstagramPostType;
    trialGraduation?: InstagramTrialGraduation;
    trialReel?: boolean;
  };
  tiktok?: Omit<TikTokPublishOptions, "privacyLevel"> & {
    privacyLevel?: TikTokPrivacyLevel;
    discloseCommercialContent?: boolean;
  };
  youtube?: Partial<YouTubePublishOptions>;
}

interface PostTargetInput {
  attachmentIds?: string[] | null;
  descriptionOverride?: string | null;
  hashtags?: string[];
  platformAccountId: string;
  providerOptions?: PostProviderOptions;
  signature?: string | null;
  titleOverride?: string | null;
}

interface CreatePostInput {
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
}

interface UpdatePostInput {
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
}

type SchedulePostInput = {
  brandProfileId: string;
  targets?: PostTargetInput[];
} & ({ scheduledAt: Date | null; queueId?: never } | { queueId: string; scheduledAt?: never });
interface DeletePostInput {
  brandProfileId: string;
}

export type PostServiceError = CoreApiError | ActiveOrganizationRequiredError | DatabaseError;

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
