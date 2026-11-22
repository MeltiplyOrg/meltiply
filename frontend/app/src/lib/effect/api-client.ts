import { Context, Effect, Layer } from "effect";

import * as api from "../api";
import type { ApiError } from "../api";
import { WorkspaceService } from "./session-scope";

/** Error channel shared by every `ApiClientService` operation. */
export type ApiClientError = ApiError;

/** Effect type produced by `ApiClientService` operations, requiring `WorkspaceService`. */
type ApiClientEffect<T> = Effect.Effect<T, ApiClientError, WorkspaceService>;

/**
 * Operations whose `lib/api.ts` adapter takes `workspaceId: string | null` as
 * its first argument; `ApiClientService` binds that argument from
 * `WorkspaceService` so callers pass only domain arguments.
 */
const WORKSPACE_SCOPED_OPERATIONS = [
  "abortUploadSession",
  "cancelDistribution",
  "cancelOAuthSelection",
  "completeUploadSession",
  "confirmOAuthSelection",
  "createBrandProfile",
  "createPost",
  "createQueue",
  "createUploadPartUrls",
  "createUploadSession",
  "deleteBrandProfile",
  "deletePost",
  "deleteQueue",
  "disconnectPlatform",
  "endBroadcast",
  "getAnalyticsDashboard",
  "getAnalyticsPosts",
  "getAsset",
  "getAssetPreviewUrl",
  "getBroadcast",
  "getCalendar",
  "getCurrentUser",
  "getDistribution",
  "getDistributionAnalytics",
  "getOAuthSelection",
  "getPlatformPublishingRequirements",
  "getPost",
  "getPublishingPreferences",
  "getUploadSession",
  "listBrandProfiles",
  "listPlatformCapabilities",
  "listPlatforms",
  "listPosts",
  "listQueues",
  "removePostFromQueue",
  "retryDistribution",
  "schedulePost",
  "startPlatformOAuth",
  "updateBrandProfile",
  "updatePost",
  "updatePublishingPreferences",
  "updateQueue",
  "updateScheduledDistribution",
] as const;

/**
 * Operations whose `lib/api.ts` adapter is invoked directly without injecting
 * `WorkspaceService` (installation-wide, public token, or explicit-workspaceId
 * lifecycle endpoints).
 */
const DIRECT_OPERATIONS = [
  "acceptWorkspaceInvitation",
  "completeOnboarding",
  "createWorkspaceInvitation",
  "deleteInstallationMember",
  "getInstallation",
  "getInvitationPreview",
  "getOnboarding",
  "getReportingFeedback",
  "getReportingPolicy",
  "listWorkspaceAudit",
  "listWorkspaceInvitations",
  "listWorkspaceMembers",
  "reactivateInstallationMember",
  "removeWorkspaceMember",
  "resendWorkspaceInvitation",
  "revokeWorkspaceInvitation",
  "saveOnboarding",
  "submitReportingFeedback",
  "suspendInstallationMember",
  "transferInstallationOwnership",
  "updateReportingPreferences",
  "updateWorkspaceMember",
  "updateWorkspaceName",
] as const;

/** Single authoritative list of operations exposed on `ApiClientService`. */
const API_OPERATION_NAMES = [...WORKSPACE_SCOPED_OPERATIONS, ...DIRECT_OPERATIONS] as const;

type WorkspaceScopedOperationName = (typeof WORKSPACE_SCOPED_OPERATIONS)[number];
type DirectOperationName = (typeof DIRECT_OPERATIONS)[number];
type ApiOperationName = (typeof API_OPERATION_NAMES)[number];

type DropWorkspaceParam<Fn> = Fn extends (
  workspaceId: string | null,
  ...rest: infer Args
) => Effect.Effect<infer Result, ApiError>
  ? (...args: Args) => ApiClientEffect<Result>
  : never;

type LiftDirectOperation<Fn> = Fn extends (
  ...args: infer Args
) => Effect.Effect<infer Result, ApiError>
  ? (...args: Args) => ApiClientEffect<Result>
  : never;

/**
 * Service shape covering every Meltiply API operation consumed by the frontend,
 * derived from `WORKSPACE_SCOPED_OPERATIONS`, `DIRECT_OPERATIONS`, and the
 * `lib/api.ts` adapters so adding or changing an operation stays one edit.
 */
export type ApiClientServiceShape = {
  readonly [K in WorkspaceScopedOperationName]: DropWorkspaceParam<(typeof api)[K]>;
} & {
  readonly [K in DirectOperationName]: LiftDirectOperation<(typeof api)[K]>;
};

/**
 * Resolves the request-scoped Workspace selection and invokes a workspace-scoped
 * adapter operation with it.
 */
function inWorkspace<T>(
  operation: (workspaceId: string | null) => Effect.Effect<T, ApiError>,
): ApiClientEffect<T> {
  return Effect.flatMap(WorkspaceService, (workspace) => operation(workspace.workspaceId));
}

/**
 * Service tag for the canonical frontend API client backed by `@meltiply/contracts`.
 */
export class ApiClientService extends Context.Service<ApiClientService, ApiClientServiceShape>()(
  "ApiClientService",
) {}

/**
 * Creates a test Layer for `ApiClientService` where every unstubbed operation
 * dies with a descriptive defect naming the operation.
 *
 * @param impl Optional partial service methods to override.
 * @returns Layer providing the test `ApiClientService`.
 */
export function createApiClientServiceTest(
  impl?: Partial<ApiClientServiceShape>,
): Layer.Layer<ApiClientService, never, never> {
  const base = Object.fromEntries(
    API_OPERATION_NAMES.map(
      (name) =>
        [
          name,
          () => Effect.die(new Error(`ApiClientService.${name} is not stubbed in this test`)),
        ] as [ApiOperationName, (...args: never[]) => ApiClientEffect<never>],
    ),
  );

  return Layer.succeed(ApiClientService, {
    ...base,
    ...impl,
  } as ApiClientServiceShape);
}

/**
 * Builds the live service implementation from `WORKSPACE_SCOPED_OPERATIONS` and
 * `DIRECT_OPERATIONS` by delegating dynamically to `api[name]`, keeping `vi.mock`
 * test overrides on `lib/api.ts` observable through the live layer.
 */
function buildLiveApiClientService(): ApiClientServiceShape {
  const entries: Array<[ApiOperationName, (...args: never[]) => ApiClientEffect<unknown>]> = [
    ...WORKSPACE_SCOPED_OPERATIONS.map(
      (name): [WorkspaceScopedOperationName, (...args: never[]) => ApiClientEffect<unknown>] => [
        name,
        (...args: unknown[]) =>
          inWorkspace((workspaceId) => {
            const fn = api[name] as (
              ws: string | null,
              ...rest: unknown[]
            ) => Effect.Effect<unknown, ApiError>;
            return fn(workspaceId, ...args);
          }),
      ],
    ),
    ...DIRECT_OPERATIONS.map(
      (name): [DirectOperationName, (...args: never[]) => ApiClientEffect<unknown>] => [
        name,
        (...args: unknown[]) => {
          const fn = api[name] as (...rest: unknown[]) => Effect.Effect<unknown, ApiError>;
          return fn(...args);
        },
      ],
    ),
  ];

  return Object.fromEntries(entries) as ApiClientServiceShape;
}

/** Production Layer for `ApiClientService` backed by the generated OpenAPI client. */
export const ApiClientServiceLive: Layer.Layer<ApiClientService, never, never> = Layer.succeed(
  ApiClientService,
  buildLiveApiClientService(),
);
