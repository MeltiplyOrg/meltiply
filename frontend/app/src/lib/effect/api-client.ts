import { Context, Effect, Layer } from "effect";
import type { components } from "@meltiply/contracts/schema";

import type {
  AnalyticsDashboard,
  AnalyticsDashboardQueryParams,
  AnalyticsPostsQueryParams,
  AnalyticsPostsResponse,
  AnalyticsSummary,
  AnalyticsSummaryQueryParams,
  Asset,
  BrandProfile,
  BrandProfileListResponse,
  CalendarQueryParams,
  CalendarResponse,
  CompleteUploadInput,
  CreateBrandProfileInput,
  CreatePostInput,
  CreateUploadPartsInput,
  CreateUploadPartsResponse,
  CreateUploadSessionInput,
  Distribution,
  DistributionListResponse,
  DistributionQueryParams,
  OAuthSelection,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformAccountsResponse,
  PlatformCapabilitiesResponse,
  PlatformQueryParams,
  Post,
  PostListResponse,
  PostQueryParams,
  PublishingRequirements,
  SchedulePostInput,
  SignedUrlResponse,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  UploadSessionDetailResponse,
  UploadSessionResponse,
  UserProfile,
} from "@/types";
import {
  abortUploadSession,
  ApiError,
  cancelOAuthSelection,
  confirmOAuthSelection,
  cancelDistribution,
  completeUploadSession,
  createBrandProfile,
  createPost,
  createUploadPartUrls,
  createUploadSession,
  deleteBrandProfile,
  deletePost,
  disconnectPlatform,
  getAsset,
  getAssetDownloadUrl,
  getAssetPreviewUrl,
  getAnalyticsDashboard,
  getAnalyticsPosts,
  getAnalyticsSummary,
  getCalendar,
  getCurrentUser,
  getOAuthSelection,
  getDistribution,
  getPlatformPublishingRequirements,
  getPost,
  getUploadSession,
  listBrandProfiles,
  listDeletedBrandProfiles,
  listDistributions,
  listPlatformCapabilities,
  listPlatforms,
  listPosts,
  restoreBrandProfile,
  retryDistribution,
  schedulePost,
  startPlatformOAuth,
  updateBrandProfile,
  updatePost,
  updateScheduledDistribution,
  type ApiRequestOptions,
} from "../api";

import { WorkspaceService } from "./session-scope";

type OAuthStartResponse = components["schemas"]["OAuthStartResponse"];

/**
 * Error channel shared by every `ApiClientService` operation: typed `ApiError`
 * failures from the generated OpenAPI client adapter. Authentication is the
 * ambient session cookie, so an absent session surfaces as a 401 `ApiError`
 * rather than a dedicated credential failure.
 */
export type ApiClientError = ApiError;

/**
 * Effect type produced by `ApiClientService` operations.
 * `WorkspaceService` remains in the requirement channel so the request-scoped
 * Workspace selection is resolved at execution time, never captured in a
 * global singleton.
 */
type ApiClientEffect<T> = Effect.Effect<T, ApiClientError, WorkspaceService>;

/**
 * Resolves the request-scoped Workspace selection and invokes the
 * workspace-parameterized generated-client adapter operation with it.
 *
 * @param operation Adapter call receiving the selected workspace UUID (or null
 *   for the personal workspace), which it sends as `x-workspace-id`.
 * @returns Effect running the operation under the ambient `WorkspaceService`.
 */
function inWorkspace<T>(
  operation: (workspaceId: string | null) => Effect.Effect<T, ApiError>,
): ApiClientEffect<T> {
  return Effect.flatMap(WorkspaceService, (workspace) => operation(workspace.workspaceId));
}

/**
 * Service shape covering every Meltiply API operation consumed by the frontend.
 * Each member returns an `Effect` that resolves the request-scoped Workspace
 * selection from `WorkspaceService` and delegates to the generated OpenAPI
 * client adapter in `lib/api.ts`, preserving typed `ApiError` failures, request
 * metadata, and idempotency-key behavior.
 */
export interface ApiClientServiceShape {
  readonly getCurrentUser: () => ApiClientEffect<UserProfile>;
  readonly listBrandProfiles: (
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfileListResponse>;
  readonly listDeletedBrandProfiles: (
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfileListResponse>;
  readonly createBrandProfile: (
    input: CreateBrandProfileInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfile>;
  readonly updateBrandProfile: (
    profileId: string,
    input: UpdateBrandProfileInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfile>;
  readonly deleteBrandProfile: (
    profileId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfile>;
  readonly restoreBrandProfile: (
    profileId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<BrandProfile>;
  readonly getAsset: (id: string, options?: ApiRequestOptions) => ApiClientEffect<Asset>;
  readonly getAssetPreviewUrl: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<SignedUrlResponse>;
  readonly getAssetDownloadUrl: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<SignedUrlResponse>;
  readonly listPosts: (
    params?: PostQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PostListResponse>;
  readonly getPost: (id: string, options?: ApiRequestOptions) => ApiClientEffect<Post>;
  readonly createPost: (
    input: CreatePostInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Post>;
  readonly updatePost: (
    id: string,
    input: UpdatePostInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Post>;
  /** Deletes only a Post owned by the explicitly selected Brand Profile. */
  readonly deletePost: (
    id: string,
    brandProfileId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Post>;
  readonly schedulePost: (
    id: string,
    input: SchedulePostInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Post>;
  readonly createUploadSession: (
    input: CreateUploadSessionInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<UploadSessionResponse>;
  readonly getUploadSession: (
    sessionId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<UploadSessionDetailResponse>;
  readonly createUploadPartUrls: (
    sessionId: string,
    input: CreateUploadPartsInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<CreateUploadPartsResponse>;
  readonly completeUploadSession: (
    sessionId: string,
    input?: CompleteUploadInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Asset>;
  readonly abortUploadSession: (
    sessionId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly listPlatforms: (
    params?: PlatformQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PlatformAccountsResponse>;
  readonly listPlatformCapabilities: (
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PlatformCapabilitiesResponse>;
  readonly startPlatformOAuth: (
    platform: Platform,
    brandProfileId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<OAuthStartResponse>;
  readonly getOAuthSelection: (
    selectionId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<OAuthSelection>;
  readonly confirmOAuthSelection: (
    selectionId: string,
    input: OAuthSelectionConfirmRequest,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly cancelOAuthSelection: (
    selectionId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly getPlatformPublishingRequirements: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PublishingRequirements>;
  readonly disconnectPlatform: (id: string, options?: ApiRequestOptions) => ApiClientEffect<void>;
  readonly listDistributions: (
    params?: DistributionQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<DistributionListResponse>;
  readonly getDistribution: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Distribution>;
  readonly updateScheduledDistribution: (
    id: string,
    input: UpdateDistributionInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Distribution>;
  readonly cancelDistribution: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Distribution | undefined>;
  readonly retryDistribution: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<Distribution>;
  readonly getCalendar: (
    params: CalendarQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<CalendarResponse>;
  readonly getAnalyticsDashboard: (
    params: AnalyticsDashboardQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AnalyticsDashboard>;
  readonly getAnalyticsSummary: (
    params: AnalyticsSummaryQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AnalyticsSummary>;
  readonly getAnalyticsPosts: (
    params: AnalyticsPostsQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AnalyticsPostsResponse>;
}

/**
 * Service tag for the canonical frontend API client.
 *
 * This is the single Effect service through which UI-facing query and mutation
 * adapters reach the backend; the generated OpenAPI client in
 * `@meltiply/contracts` remains the canonical HTTP contract beneath it.
 */
export class ApiClientService extends Context.Service<ApiClientService, ApiClientServiceShape>()(
  "ApiClientService",
) {}

/**
 * Creates a test Layer for `ApiClientService`.
 *
 * Allows isolated unit and component testing without network interception or
 * mock servers. Unstubbed operations die with a descriptive defect so tests
 * fail loudly instead of silently passing on fabricated responses.
 *
 * @param impl - Optional partial service methods to override.
 * @returns Layer providing the test `ApiClientService`.
 */
export function createApiClientServiceTest(
  impl?: Partial<ApiClientServiceShape>,
): Layer.Layer<ApiClientService, never, never> {
  const unstubbed = (name: string) => () =>
    Effect.die(new Error(`ApiClientService.${name} is not stubbed in this test`));

  const service: ApiClientServiceShape = {
    abortUploadSession: unstubbed("abortUploadSession"),
    cancelDistribution: unstubbed("cancelDistribution"),
    completeUploadSession: unstubbed("completeUploadSession"),
    createBrandProfile: unstubbed("createBrandProfile"),
    createPost: unstubbed("createPost"),
    createUploadPartUrls: unstubbed("createUploadPartUrls"),
    createUploadSession: unstubbed("createUploadSession"),
    deleteBrandProfile: unstubbed("deleteBrandProfile"),
    deletePost: unstubbed("deletePost"),
    disconnectPlatform: unstubbed("disconnectPlatform"),
    getAsset: unstubbed("getAsset"),
    getAssetDownloadUrl: unstubbed("getAssetDownloadUrl"),
    getAssetPreviewUrl: unstubbed("getAssetPreviewUrl"),
    getCalendar: unstubbed("getCalendar"),
    getAnalyticsDashboard: unstubbed("getAnalyticsDashboard"),
    getAnalyticsPosts: unstubbed("getAnalyticsPosts"),
    getAnalyticsSummary: unstubbed("getAnalyticsSummary"),
    getCurrentUser: unstubbed("getCurrentUser"),
    getDistribution: unstubbed("getDistribution"),
    getPlatformPublishingRequirements: unstubbed("getPlatformPublishingRequirements"),
    getPost: unstubbed("getPost"),
    getUploadSession: unstubbed("getUploadSession"),
    listBrandProfiles: unstubbed("listBrandProfiles"),
    listDeletedBrandProfiles: unstubbed("listDeletedBrandProfiles"),
    listDistributions: unstubbed("listDistributions"),
    listPlatformCapabilities: unstubbed("listPlatformCapabilities"),
    listPlatforms: unstubbed("listPlatforms"),
    listPosts: unstubbed("listPosts"),
    restoreBrandProfile: unstubbed("restoreBrandProfile"),
    retryDistribution: unstubbed("retryDistribution"),
    schedulePost: unstubbed("schedulePost"),
    startPlatformOAuth: unstubbed("startPlatformOAuth"),
    getOAuthSelection: unstubbed("getOAuthSelection"),
    confirmOAuthSelection: unstubbed("confirmOAuthSelection"),
    cancelOAuthSelection: unstubbed("cancelOAuthSelection"),
    updateBrandProfile: unstubbed("updateBrandProfile"),
    updatePost: unstubbed("updatePost"),
    updateScheduledDistribution: unstubbed("updateScheduledDistribution"),
    ...impl,
  };

  return Layer.succeed(ApiClientService, service);
}

/**
 * Production Layer for `ApiClientService` backed by the generated OpenAPI client.
 *
 * Each operation resolves the Workspace selection from `WorkspaceService`
 * and delegates to the matching `lib/api.ts` adapter, which lifts the
 * generated client call
 * into `Effect` with typed `ApiError` failures and interruption-bound abort
 * signals.
 */
export const ApiClientServiceLive: Layer.Layer<ApiClientService, never, never> = Layer.succeed(
  ApiClientService,
  {
    abortUploadSession: (sessionId, options) =>
      inWorkspace((workspaceId) => abortUploadSession(workspaceId, sessionId, options)),
    cancelDistribution: (id, options) =>
      inWorkspace((workspaceId) => cancelDistribution(workspaceId, id, options)),
    completeUploadSession: (sessionId, input, options) =>
      inWorkspace((workspaceId) => completeUploadSession(workspaceId, sessionId, input, options)),
    createBrandProfile: (input, options) =>
      inWorkspace((workspaceId) => createBrandProfile(workspaceId, input, options)),
    createPost: (input, options) =>
      inWorkspace((workspaceId) => createPost(workspaceId, input, options)),
    createUploadPartUrls: (sessionId, input, options) =>
      inWorkspace((workspaceId) => createUploadPartUrls(workspaceId, sessionId, input, options)),
    createUploadSession: (input, options) =>
      inWorkspace((workspaceId) => createUploadSession(workspaceId, input, options)),
    deleteBrandProfile: (profileId, options) =>
      inWorkspace((workspaceId) => deleteBrandProfile(workspaceId, profileId, options)),
    deletePost: (id, brandProfileId, options) =>
      inWorkspace((workspaceId) => deletePost(workspaceId, id, brandProfileId, options)),
    disconnectPlatform: (id, options) =>
      inWorkspace((workspaceId) => disconnectPlatform(workspaceId, id, options)),
    getAsset: (id, options) => inWorkspace((workspaceId) => getAsset(workspaceId, id, options)),
    getAssetDownloadUrl: (id, options) =>
      inWorkspace((workspaceId) => getAssetDownloadUrl(workspaceId, id, options)),
    getAssetPreviewUrl: (id, options) =>
      inWorkspace((workspaceId) => getAssetPreviewUrl(workspaceId, id, options)),
    getCalendar: (params, options) =>
      inWorkspace((workspaceId) => getCalendar(workspaceId, params, options)),
    getAnalyticsDashboard: (params, options) =>
      inWorkspace((workspaceId) => getAnalyticsDashboard(workspaceId, params, options)),
    getAnalyticsPosts: (params, options) =>
      inWorkspace((workspaceId) => getAnalyticsPosts(workspaceId, params, options)),
    getAnalyticsSummary: (params, options) =>
      inWorkspace((workspaceId) => getAnalyticsSummary(workspaceId, params, options)),
    getCurrentUser: () => inWorkspace((workspaceId) => getCurrentUser(workspaceId)),
    getDistribution: (id, options) =>
      inWorkspace((workspaceId) => getDistribution(workspaceId, id, options)),
    getPlatformPublishingRequirements: (id, options) =>
      inWorkspace((workspaceId) => getPlatformPublishingRequirements(workspaceId, id, options)),
    getPost: (id, options) => inWorkspace((workspaceId) => getPost(workspaceId, id, options)),
    getUploadSession: (sessionId, options) =>
      inWorkspace((workspaceId) => getUploadSession(workspaceId, sessionId, options)),
    listBrandProfiles: (options) =>
      inWorkspace((workspaceId) => listBrandProfiles(workspaceId, options)),
    listDeletedBrandProfiles: (options) =>
      inWorkspace((workspaceId) => listDeletedBrandProfiles(workspaceId, options)),
    listDistributions: (params, options) =>
      inWorkspace((workspaceId) => listDistributions(workspaceId, params, options)),
    listPlatformCapabilities: (options) =>
      inWorkspace((workspaceId) => listPlatformCapabilities(workspaceId, options)),
    listPlatforms: (params, options) =>
      inWorkspace((workspaceId) => listPlatforms(workspaceId, params, options)),
    listPosts: (params, options) =>
      inWorkspace((workspaceId) => listPosts(workspaceId, params, options)),
    restoreBrandProfile: (profileId, options) =>
      inWorkspace((workspaceId) => restoreBrandProfile(workspaceId, profileId, options)),
    retryDistribution: (id, options) =>
      inWorkspace((workspaceId) => retryDistribution(workspaceId, id, options)),
    schedulePost: (id, input, options) =>
      inWorkspace((workspaceId) => schedulePost(workspaceId, id, input, options)),
    startPlatformOAuth: (platform, brandProfileId, options) =>
      inWorkspace((workspaceId) =>
        startPlatformOAuth(workspaceId, platform, brandProfileId, options),
      ),
    getOAuthSelection: (selectionId, options) =>
      inWorkspace((workspaceId) => getOAuthSelection(workspaceId, selectionId, options)),
    confirmOAuthSelection: (selectionId, input, options) =>
      inWorkspace((workspaceId) => confirmOAuthSelection(workspaceId, selectionId, input, options)),
    cancelOAuthSelection: (selectionId, options) =>
      inWorkspace((workspaceId) => cancelOAuthSelection(workspaceId, selectionId, options)),
    updateBrandProfile: (profileId, input, options) =>
      inWorkspace((workspaceId) => updateBrandProfile(workspaceId, profileId, input, options)),
    updatePost: (id, input, options) =>
      inWorkspace((workspaceId) => updatePost(workspaceId, id, input, options)),
    updateScheduledDistribution: (id, input, options) =>
      inWorkspace((workspaceId) => updateScheduledDistribution(workspaceId, id, input, options)),
  },
);
