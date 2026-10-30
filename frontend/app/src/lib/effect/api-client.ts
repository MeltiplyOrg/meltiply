import { Context, Effect, Layer } from "effect";
import type { components } from "@meltiply/contracts/schema";

import type {
  AccountLifecycle,
  AnalyticsDashboard,
  AnalyticsDashboardQueryParams,
  AnalyticsPostsQueryParams,
  AnalyticsPostsResponse,
  Asset,
  AuditListResponse,
  AuditQueryParams,
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
  InstallationSummary,
  InvitationPreview,
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
  PublishingPreferences,
  PublishingPreferencesUpdate,
  SchedulePostInput,
  PublishingQueue,
  QueueListResponse,
  CreateQueueInput,
  UpdateQueueInput,
  QueueQueryParams,
  SignedUrlResponse,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  UploadSessionDetailResponse,
  UploadSessionResponse,
  UserProfile,
  WorkspaceInvitation,
  WorkspaceInvitationListResponse,
  WorkspaceMember,
  WorkspaceMemberListResponse,
  WorkspaceRole,
} from "@/types";
import {
  abortUploadSession,
  acceptWorkspaceInvitation,
  ApiError,
  cancelOAuthSelection,
  confirmOAuthSelection,
  cancelDistribution,
  completeUploadSession,
  createBrandProfile,
  createPost,
  listQueues,
  createQueue,
  updateQueue,
  deleteQueue,
  removePostFromQueue,
  createUploadPartUrls,
  createUploadSession,
  createWorkspaceInvitation,
  deleteBrandProfile,
  deleteInstallationMember,
  deletePost,
  disconnectPlatform,
  getAsset,
  getAssetPreviewUrl,
  getAnalyticsDashboard,
  getAnalyticsPosts,
  getCalendar,
  getCurrentUser,
  getInstallation,
  getInvitationPreview,
  getOAuthSelection,
  getDistribution,
  getDistributionAnalytics,
  getPlatformPublishingRequirements,
  getPost,
  getPublishingPreferences,
  updatePublishingPreferences,
  getUploadSession,
  listBrandProfiles,
  listPlatformCapabilities,
  listPlatforms,
  listPosts,
  listWorkspaceAudit,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  reactivateInstallationMember,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  retryDistribution,
  revokeWorkspaceInvitation,
  schedulePost,
  startPlatformOAuth,
  suspendInstallationMember,
  transferInstallationOwnership,
  updateBrandProfile,
  updatePost,
  updateScheduledDistribution,
  updateWorkspaceMember,
  updateWorkspaceName,
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
  readonly getAsset: (id: string, options?: ApiRequestOptions) => ApiClientEffect<Asset>;
  readonly getAssetPreviewUrl: (
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
  readonly listQueues: (
    params: QueueQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<QueueListResponse>;
  readonly createQueue: (
    input: CreateQueueInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PublishingQueue>;
  readonly updateQueue: (
    id: string,
    input: UpdateQueueInput,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PublishingQueue>;
  readonly deleteQueue: (
    id: string,
    brandProfileId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly removePostFromQueue: (
    queueId: string,
    postId: string,
    brandProfileId: string,
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
  readonly getPublishingPreferences: (
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PublishingPreferences>;
  readonly updatePublishingPreferences: (
    input: PublishingPreferencesUpdate,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<PublishingPreferences>;
  readonly disconnectPlatform: (id: string, options?: ApiRequestOptions) => ApiClientEffect<void>;
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
  readonly getAnalyticsPosts: (
    params: AnalyticsPostsQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AnalyticsPostsResponse>;
  readonly getDistributionAnalytics: (
    id: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<components["schemas"]["AnalyticsSnapshotsResponse"]>;
  readonly listWorkspaceMembers: (
    workspaceId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<WorkspaceMemberListResponse>;
  readonly listWorkspaceInvitations: (
    workspaceId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<WorkspaceInvitationListResponse>;
  readonly createWorkspaceInvitation: (
    workspaceId: string,
    input: { email: string; role: WorkspaceRole },
    options?: ApiRequestOptions,
  ) => ApiClientEffect<WorkspaceInvitation>;
  readonly resendWorkspaceInvitation: (
    workspaceId: string,
    invitationId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<WorkspaceInvitation>;
  readonly revokeWorkspaceInvitation: (
    workspaceId: string,
    invitationId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly updateWorkspaceMember: (
    workspaceId: string,
    memberId: string,
    role: WorkspaceRole,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<WorkspaceMember>;
  readonly removeWorkspaceMember: (
    workspaceId: string,
    memberId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly updateWorkspaceName: (
    workspaceId: string,
    input: { name: string },
    options?: ApiRequestOptions,
  ) => ApiClientEffect<{ id: string; name: string; slug: string; role: WorkspaceRole }>;
  readonly getInstallation: (
    workspaceId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<InstallationSummary>;
  readonly suspendInstallationMember: (
    workspaceId: string,
    memberId: string,
    reason: string | undefined,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AccountLifecycle>;
  readonly reactivateInstallationMember: (
    workspaceId: string,
    memberId: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AccountLifecycle>;
  readonly deleteInstallationMember: (
    workspaceId: string,
    memberId: string,
    confirmEmail: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<void>;
  readonly transferInstallationOwnership: (
    workspaceId: string,
    targetUserId: string,
    password: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<{ installation_owner_user_id: string }>;
  readonly listWorkspaceAudit: (
    workspaceId: string,
    params: AuditQueryParams,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<AuditListResponse>;
  readonly getInvitationPreview: (
    token: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<InvitationPreview>;
  readonly acceptWorkspaceInvitation: (
    token: string,
    options?: ApiRequestOptions,
  ) => ApiClientEffect<{
    member: WorkspaceMember;
    workspace: { id: string; name: string; role: WorkspaceRole; slug: string };
  }>;
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
    listQueues: unstubbed("listQueues"),
    createQueue: unstubbed("createQueue"),
    updateQueue: unstubbed("updateQueue"),
    deleteQueue: unstubbed("deleteQueue"),
    removePostFromQueue: unstubbed("removePostFromQueue"),
    abortUploadSession: unstubbed("abortUploadSession"),
    acceptWorkspaceInvitation: unstubbed("acceptWorkspaceInvitation"),
    cancelDistribution: unstubbed("cancelDistribution"),
    completeUploadSession: unstubbed("completeUploadSession"),
    createBrandProfile: unstubbed("createBrandProfile"),
    createPost: unstubbed("createPost"),
    createUploadPartUrls: unstubbed("createUploadPartUrls"),
    createUploadSession: unstubbed("createUploadSession"),
    createWorkspaceInvitation: unstubbed("createWorkspaceInvitation"),
    deleteBrandProfile: unstubbed("deleteBrandProfile"),
    deleteInstallationMember: unstubbed("deleteInstallationMember"),
    deletePost: unstubbed("deletePost"),
    disconnectPlatform: unstubbed("disconnectPlatform"),
    getAsset: unstubbed("getAsset"),
    getAssetPreviewUrl: unstubbed("getAssetPreviewUrl"),
    getCalendar: unstubbed("getCalendar"),
    getAnalyticsDashboard: unstubbed("getAnalyticsDashboard"),
    getAnalyticsPosts: unstubbed("getAnalyticsPosts"),
    getCurrentUser: unstubbed("getCurrentUser"),
    getDistribution: unstubbed("getDistribution"),
    getDistributionAnalytics: unstubbed("getDistributionAnalytics"),
    getInstallation: unstubbed("getInstallation"),
    getInvitationPreview: unstubbed("getInvitationPreview"),
    getPlatformPublishingRequirements: unstubbed("getPlatformPublishingRequirements"),
    getPublishingPreferences: unstubbed("getPublishingPreferences"),
    updatePublishingPreferences: unstubbed("updatePublishingPreferences"),
    getPost: unstubbed("getPost"),
    getUploadSession: unstubbed("getUploadSession"),
    listBrandProfiles: unstubbed("listBrandProfiles"),
    listPlatformCapabilities: unstubbed("listPlatformCapabilities"),
    listPlatforms: unstubbed("listPlatforms"),
    listPosts: unstubbed("listPosts"),
    listWorkspaceAudit: unstubbed("listWorkspaceAudit"),
    listWorkspaceInvitations: unstubbed("listWorkspaceInvitations"),
    listWorkspaceMembers: unstubbed("listWorkspaceMembers"),
    reactivateInstallationMember: unstubbed("reactivateInstallationMember"),
    removeWorkspaceMember: unstubbed("removeWorkspaceMember"),
    resendWorkspaceInvitation: unstubbed("resendWorkspaceInvitation"),
    retryDistribution: unstubbed("retryDistribution"),
    revokeWorkspaceInvitation: unstubbed("revokeWorkspaceInvitation"),
    schedulePost: unstubbed("schedulePost"),
    startPlatformOAuth: unstubbed("startPlatformOAuth"),
    suspendInstallationMember: unstubbed("suspendInstallationMember"),
    transferInstallationOwnership: unstubbed("transferInstallationOwnership"),
    getOAuthSelection: unstubbed("getOAuthSelection"),
    confirmOAuthSelection: unstubbed("confirmOAuthSelection"),
    cancelOAuthSelection: unstubbed("cancelOAuthSelection"),
    updateBrandProfile: unstubbed("updateBrandProfile"),
    updatePost: unstubbed("updatePost"),
    updateScheduledDistribution: unstubbed("updateScheduledDistribution"),
    updateWorkspaceMember: unstubbed("updateWorkspaceMember"),
    updateWorkspaceName: unstubbed("updateWorkspaceName"),
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
    listQueues: (params, options) =>
      inWorkspace((workspaceId) => listQueues(workspaceId, params, options)),
    createQueue: (input, options) =>
      inWorkspace((workspaceId) => createQueue(workspaceId, input, options)),
    updateQueue: (id, input, options) =>
      inWorkspace((workspaceId) => updateQueue(workspaceId, id, input, options)),
    deleteQueue: (id, brandProfileId, options) =>
      inWorkspace((workspaceId) => deleteQueue(workspaceId, id, brandProfileId, options)),
    removePostFromQueue: (queueId, postId, brandProfileId, options) =>
      inWorkspace((workspaceId) =>
        removePostFromQueue(workspaceId, queueId, postId, brandProfileId, options),
      ),
    abortUploadSession: (sessionId, options) =>
      inWorkspace((workspaceId) => abortUploadSession(workspaceId, sessionId, options)),
    acceptWorkspaceInvitation: (token, options) => acceptWorkspaceInvitation(token, options),
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
    createWorkspaceInvitation: (workspaceId, input, options) =>
      createWorkspaceInvitation(workspaceId, input, options),
    deleteBrandProfile: (profileId, options) =>
      inWorkspace((workspaceId) => deleteBrandProfile(workspaceId, profileId, options)),
    deleteInstallationMember: (workspaceId, memberId, confirmEmail, options) =>
      deleteInstallationMember(workspaceId, memberId, confirmEmail, options),
    deletePost: (id, brandProfileId, options) =>
      inWorkspace((workspaceId) => deletePost(workspaceId, id, brandProfileId, options)),
    disconnectPlatform: (id, options) =>
      inWorkspace((workspaceId) => disconnectPlatform(workspaceId, id, options)),
    getAsset: (id, options) => inWorkspace((workspaceId) => getAsset(workspaceId, id, options)),
    getAssetPreviewUrl: (id, options) =>
      inWorkspace((workspaceId) => getAssetPreviewUrl(workspaceId, id, options)),
    getCalendar: (params, options) =>
      inWorkspace((workspaceId) => getCalendar(workspaceId, params, options)),
    getAnalyticsDashboard: (params, options) =>
      inWorkspace((workspaceId) => getAnalyticsDashboard(workspaceId, params, options)),
    getAnalyticsPosts: (params, options) =>
      inWorkspace((workspaceId) => getAnalyticsPosts(workspaceId, params, options)),
    getCurrentUser: () => inWorkspace((workspaceId) => getCurrentUser(workspaceId)),
    getDistribution: (id, options) =>
      inWorkspace((workspaceId) => getDistribution(workspaceId, id, options)),
    getDistributionAnalytics: (id, options) =>
      inWorkspace((workspaceId) => getDistributionAnalytics(workspaceId, id, options)),
    getInstallation: (workspaceId, options) => getInstallation(workspaceId, options),
    getInvitationPreview: (token, options) => getInvitationPreview(token, options),
    getPlatformPublishingRequirements: (id, options) =>
      inWorkspace((workspaceId) => getPlatformPublishingRequirements(workspaceId, id, options)),
    getPublishingPreferences: (options) =>
      inWorkspace((workspaceId) => getPublishingPreferences(workspaceId, options)),
    updatePublishingPreferences: (input, options) =>
      inWorkspace((workspaceId) => updatePublishingPreferences(workspaceId, input, options)),
    getPost: (id, options) => inWorkspace((workspaceId) => getPost(workspaceId, id, options)),
    getUploadSession: (sessionId, options) =>
      inWorkspace((workspaceId) => getUploadSession(workspaceId, sessionId, options)),
    listBrandProfiles: (options) =>
      inWorkspace((workspaceId) => listBrandProfiles(workspaceId, options)),
    listPlatformCapabilities: (options) =>
      inWorkspace((workspaceId) => listPlatformCapabilities(workspaceId, options)),
    listPlatforms: (params, options) =>
      inWorkspace((workspaceId) => listPlatforms(workspaceId, params, options)),
    listPosts: (params, options) =>
      inWorkspace((workspaceId) => listPosts(workspaceId, params, options)),
    listWorkspaceAudit: (workspaceId, params, options) =>
      listWorkspaceAudit(workspaceId, params, options),
    listWorkspaceInvitations: (workspaceId, options) =>
      listWorkspaceInvitations(workspaceId, options),
    listWorkspaceMembers: (workspaceId, options) => listWorkspaceMembers(workspaceId, options),
    reactivateInstallationMember: (workspaceId, memberId, options) =>
      reactivateInstallationMember(workspaceId, memberId, options),
    removeWorkspaceMember: (workspaceId, memberId, options) =>
      removeWorkspaceMember(workspaceId, memberId, options),
    resendWorkspaceInvitation: (workspaceId, invitationId, options) =>
      resendWorkspaceInvitation(workspaceId, invitationId, options),
    retryDistribution: (id, options) =>
      inWorkspace((workspaceId) => retryDistribution(workspaceId, id, options)),
    revokeWorkspaceInvitation: (workspaceId, invitationId, options) =>
      revokeWorkspaceInvitation(workspaceId, invitationId, options),
    schedulePost: (id, input, options) =>
      inWorkspace((workspaceId) => schedulePost(workspaceId, id, input, options)),
    startPlatformOAuth: (platform, options) =>
      inWorkspace((workspaceId) => startPlatformOAuth(workspaceId, platform, options)),
    suspendInstallationMember: (workspaceId, memberId, reason, options) =>
      suspendInstallationMember(workspaceId, memberId, reason, options),
    transferInstallationOwnership: (workspaceId, targetUserId, password, options) =>
      transferInstallationOwnership(workspaceId, targetUserId, password, options),
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
    updateWorkspaceMember: (workspaceId, memberId, role, options) =>
      updateWorkspaceMember(workspaceId, memberId, role, options),
    updateWorkspaceName: (workspaceId, input, options) =>
      updateWorkspaceName(workspaceId, input, options),
  },
);
