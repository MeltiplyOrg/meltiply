import type { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";

import { CoreApiError, toCoreApiErrorOrRethrow, type TenantServiceError } from "./api-errors";
import type { ApiWorkerEnv } from "./env";

export { CoreApiError, toCoreApiErrorOrRethrow };

type Schemas = components["schemas"];
type AnalyticsSnapshot = Schemas["AnalyticsSnapshot"];
type AnalyticsSummary = Schemas["AnalyticsSummary"];
type CalendarEvent = Schemas["CalendarEvent"];
type DistributionStatus = Schemas["DistributionStatus"];
type InboxComment = Schemas["InboxComment"];
type InboxResponse = Schemas["InboxResponse"];
type Platform = Schemas["Platform"];
type PlatformAccount = Schemas["PlatformAccount"];
type PlatformCapability = Schemas["PlatformCapability"];
type ReplyStatus = Schemas["ReplyStatus"];

export interface DistributionFilters {
  brandProfileId?: string;
  end?: Date;
  limit: number;
  offset: number;
  platform?: Platform;
  postId?: string;
  start?: Date;
  status?: DistributionStatus;
}

export interface DistributionPatch {
  descriptionOverride?: string | null;
  hashtags?: string[];
  scheduledAt?: Date | null;
  titleOverride?: string | null;
}

export interface InboxFilters {
  brandProfileId?: string;
  distributionId?: string;
  limit: number;
  offset: number;
  platform?: Platform;
  replyStatus?: ReplyStatus;
  unreplied?: boolean;
}

export interface AnalyticsFilters {
  accountId?: string;
  brandProfileId?: string;
  end: Date;
  format?: Schemas["AnalyticsFormat"];
  platform?: Platform;
  start: Date;
}

export interface AnalyticsPostsFilters extends AnalyticsFilters {
  limit: number;
  metric: Schemas["AnalyticsMetric"];
  offset: number;
}

export interface SnapshotFilters {
  end?: Date;
  limit: number;
  start?: Date;
}

export interface IdempotentResult<T> {
  replayed: boolean;
  value: T;
}

export type CoreServiceError = TenantServiceError;

export interface CoreApiService {
  analyticsPosts(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: AnalyticsPostsFilters,
  ): Effect.Effect<Schemas["AnalyticsPostsResponse"], CoreServiceError>;
  dashboardAnalytics(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: AnalyticsFilters,
  ): Effect.Effect<Schemas["AnalyticsDashboard"], CoreServiceError>;
  calendar(
    env: ApiWorkerEnv,
    session: SessionClaims,
    start: Date,
    end: Date,
    limit?: number,
    brandProfileId?: string,
  ): Effect.Effect<CalendarEvent[], CoreServiceError>;
  disconnectPlatform(
    env: ApiWorkerEnv,
    session: SessionClaims,
    accountId: string,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<undefined>, CoreServiceError>;
  distributionAnalytics(
    env: ApiWorkerEnv,
    session: SessionClaims,
    distributionId: string,
    filters: SnapshotFilters,
  ): Effect.Effect<AnalyticsSnapshot[], CoreServiceError>;
  listDistributions(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: DistributionFilters,
  ): Effect.Effect<
    {
      distributions: Schemas["Distribution"][];
      has_more: boolean;
      limit: number;
      offset: number;
    },
    CoreServiceError
  >;
  getDistribution(
    env: ApiWorkerEnv,
    session: SessionClaims,
    distributionId: string,
  ): Effect.Effect<Schemas["Distribution"], CoreServiceError>;
  updateDistribution(
    env: ApiWorkerEnv,
    session: SessionClaims,
    distributionId: string,
    patch: DistributionPatch,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<Schemas["Distribution"]>, CoreServiceError>;
  cancelDistribution(
    env: ApiWorkerEnv,
    session: SessionClaims,
    distributionId: string,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<
    IdempotentResult<Schemas["Distribution"]> & { status: 202 | 204 },
    CoreServiceError
  >;
  retryDistribution(
    env: ApiWorkerEnv,
    session: SessionClaims,
    distributionId: string,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<Schemas["Distribution"]>, CoreServiceError>;
  inbox(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: InboxFilters,
  ): Effect.Effect<InboxResponse, CoreServiceError>;
  listPlatformAccounts(
    env: ApiWorkerEnv,
    session: SessionClaims,
    brandProfileId?: string,
  ): Effect.Effect<PlatformAccount[], CoreServiceError>;
  platformCapabilities(): PlatformCapability[];
  replyToComment(
    env: ApiWorkerEnv,
    session: SessionClaims,
    commentId: string,
    brandProfileId: string,
    text: string,
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<IdempotentResult<InboxComment>, CoreServiceError>;
  summaryAnalytics(
    env: ApiWorkerEnv,
    session: SessionClaims,
    filters: AnalyticsFilters,
  ): Effect.Effect<AnalyticsSummary, CoreServiceError>;
}
