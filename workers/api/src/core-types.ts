import type { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, DomainError } from "@meltiply/domain";
import type { components } from "@meltiply/contracts/schema";

import type { ApiWorkerEnv } from "./env";
import type { DistributionFilters, DistributionPatch } from "./distribution-service";

type Schemas = components["schemas"];
type AnalyticsSnapshot = Schemas["AnalyticsSnapshot"];
type AnalyticsSummary = Schemas["AnalyticsSummary"];
type CalendarEvent = Schemas["CalendarEvent"];
type InboxComment = Schemas["InboxComment"];
type InboxResponse = Schemas["InboxResponse"];
type Platform = Schemas["Platform"];
type PlatformAccount = Schemas["PlatformAccount"];
type PlatformCapability = Schemas["PlatformCapability"];
type ReplyStatus = Schemas["ReplyStatus"];

/**
 * Domain-specific error thrown by HTTP route handlers, validation guards, and core services.
 *
 * Encapsulates HTTP status codes, structured error codes, optional retry delays, and per-field
 * validation details rendered into the canonical API error envelope.
 */
export class CoreApiError extends Error {
  /**
   * Creates an instance of CoreApiError.
   *
   * @param status - HTTP response status code (e.g. 400, 401, 403, 404, 409, 413, 422, 500, 503).
   * @param code - Machine-readable error code string (e.g. "invalid_request", "quota_exceeded").
   * @param message - User-facing or client-diagnostic error description.
   * @param retryAfterSeconds - Optional delay in seconds for `Retry-After` response header on rate-limits.
   * @param details - Optional list of detailed constraint violations rendered in `error.details`.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    /** Per-field causes rendered in the error envelope's `details` array. */
    readonly details: readonly Schemas["ErrorDetail"][] = [],
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

interface InboxFilters {
  brandProfileId?: string;
  distributionId?: string;
  limit: number;
  offset: number;
  platform?: Platform;
  replyStatus?: ReplyStatus;
  unreplied?: boolean;
}

interface AnalyticsFilters {
  brandProfileId?: string;
  end: Date;
  platform?: Platform;
  start: Date;
}

interface SnapshotFilters {
  end?: Date;
  limit: number;
  start?: Date;
}

export interface IdempotentResult<T> {
  replayed: boolean;
  value: T;
}

export type CoreServiceError = CoreApiError | DomainError | DatabaseError;

export interface CoreApiService {
  /**
   * Organization the caller's session is active in, confirmed by the database
   * inside an authenticated transaction rather than trusted from the token.
   */
  activeOrganization(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<string, CoreServiceError>;
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
