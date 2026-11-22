import { Context, Effect, Layer } from "effect";

import * as api from "../api";
import type { ApiError } from "../api";
import { WorkspaceService } from "./session-scope";

export type ApiClientError = ApiError;

type ApiClientEffect<T> = Effect.Effect<T, ApiClientError, WorkspaceService>;

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

const DIRECT_OPERATIONS = [
  "acceptWorkspaceInvitation",
  "completeOnboarding",
  "createWorkspaceInvitation",
  "deleteInstallationMember",
  "getInstallation",
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

export type ApiClientServiceShape = {
  readonly [K in WorkspaceScopedOperationName]: DropWorkspaceParam<(typeof api)[K]>;
} & {
  readonly [K in DirectOperationName]: LiftDirectOperation<(typeof api)[K]>;
};

function inWorkspace<T>(
  operation: (workspaceId: string | null) => Effect.Effect<T, ApiError>,
): ApiClientEffect<T> {
  return Effect.flatMap(WorkspaceService, (workspace) => operation(workspace.workspaceId));
}

export class ApiClientService extends Context.Service<ApiClientService, ApiClientServiceShape>()(
  "ApiClientService",
) {}

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

export const ApiClientServiceLive: Layer.Layer<ApiClientService, never, never> = Layer.succeed(
  ApiClientService,
  buildLiveApiClientService(),
);
