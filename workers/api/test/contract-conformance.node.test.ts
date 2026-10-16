import type { JwtIdentity } from "@meltiply/auth";
import { TokenCipher } from "@meltiply/secrets";
import { ContractValidator } from "@meltiply/contracts/test-support";
import { ProviderRegistry } from "@meltiply/providers";
import { Effect } from "effect";
import type { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import YAML from "yaml";

const { registerWorkspaceLifecycleRoutes } = vi.hoisted(() => ({
  registerWorkspaceLifecycleRoutes: vi.fn(),
}));
vi.mock("../src/workspace-lifecycle", () => ({
  registerWorkspaceLifecycleRoutes,
}));

import { createApiApp } from "../src/app";
import type { AssetApiService } from "../src/asset-types";
import type { BrandProfileApiService } from "../src/brand-profile-service";
import type { PostApiService } from "../src/post-types";
import { CoreApiError, type CoreApiService } from "../src/core-types";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";
interface ExampleResponse {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
}

interface OperationExample {
  errors: ExampleResponse[];
  request?: unknown;
  success: ExampleResponse;
}

interface OperationCatalog {
  operations: Record<string, OperationExample>;
}

interface ConformanceCase {
  method: "DELETE" | "GET" | "PATCH" | "POST";
  operationId: string;
  path: string;
}

interface RuntimeContractCase {
  expected_content_type: string;
  expected_status: number;
  json_subset?: Record<string, unknown>;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  name: string;
  path: string;
}

interface RuntimeContractManifest {
  cases: RuntimeContractCase[];
  version: number;
}

const catalogPath = fileURLToPath(
  new URL("../../../packages/contracts/examples/operations.yaml", import.meta.url),
);
const catalog = YAML.parse(readFileSync(catalogPath, "utf8"), {
  merge: true,
}) as OperationCatalog;
const parityManifestPath = fileURLToPath(
  new URL("../../../packages/contracts/examples/runtime-contract-cases.json", import.meta.url),
);
const parityManifest = JSON.parse(
  readFileSync(parityManifestPath, "utf8"),
) as RuntimeContractManifest;

const cases: ConformanceCase[] = [
  { method: "GET", operationId: "getHealth", path: "/api/v1/health" },
  { method: "GET", operationId: "getReadiness", path: "/api/v1/ready" },
  {
    method: "POST",
    operationId: "signInWithEmail",
    path: "/api/auth/sign-in/email",
  },
  {
    method: "POST",
    operationId: "signUpWithEmail",
    path: "/api/auth/sign-up/email",
  },
  { method: "POST", operationId: "signOut", path: "/api/auth/sign-out" },
  {
    method: "GET",
    operationId: "getAuthSession",
    path: "/api/auth/get-session",
  },
  {
    method: "POST",
    operationId: "requestPasswordReset",
    path: "/api/auth/request-password-reset",
  },
  {
    method: "POST",
    operationId: "resetPassword",
    path: "/api/auth/reset-password",
  },
  {
    method: "GET",
    operationId: "verifyEmail",
    path: "/api/auth/verify-email",
  },
  {
    method: "POST",
    operationId: "changePassword",
    path: "/api/auth/change-password",
  },
  {
    method: "POST",
    operationId: "createWorkspace",
    path: "/api/v1/workspaces",
  },
  {
    method: "PATCH",
    operationId: "updateWorkspace",
    path: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001",
  },
  {
    method: "POST",
    operationId: "createWorkspaceInvitation",
    path: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/invitations",
  },
  {
    method: "DELETE",
    operationId: "revokeWorkspaceInvitation",
    path: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/invitations/00000000-0000-4000-8000-000000000601",
  },
  {
    method: "POST",
    operationId: "acceptWorkspaceInvitation",
    path: "/api/v1/workspace-invitations/invitation-token-alpha/accept",
  },
  {
    method: "PATCH",
    operationId: "updateWorkspaceMember",
    path: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/members/00000000-0000-4000-8000-000000000012",
  },
  {
    method: "DELETE",
    operationId: "removeWorkspaceMember",
    path: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/members/00000000-0000-4000-8000-000000000012",
  },
  {
    method: "GET",
    operationId: "listBrandProfiles",
    path: "/api/v1/brand-profiles",
  },
  {
    method: "POST",
    operationId: "createBrandProfile",
    path: "/api/v1/brand-profiles",
  },
  {
    method: "GET",
    operationId: "listDeletedBrandProfiles",
    path: "/api/v1/brand-profiles/deleted",
  },
  {
    method: "GET",
    operationId: "getBrandProfile",
    path: "/api/v1/brand-profiles/00000000-0000-4000-8000-000000000111",
  },
  {
    method: "PATCH",
    operationId: "updateBrandProfile",
    path: "/api/v1/brand-profiles/00000000-0000-4000-8000-000000000111",
  },
  {
    method: "DELETE",
    operationId: "deleteBrandProfile",
    path: "/api/v1/brand-profiles/00000000-0000-4000-8000-000000000111",
  },
  {
    method: "POST",
    operationId: "restoreBrandProfile",
    path: "/api/v1/brand-profiles/00000000-0000-4000-8000-000000000111/restore",
  },
  { method: "GET", operationId: "getCurrentUser", path: "/api/v1/users/me" },
  {
    method: "GET",
    operationId: "listPlatformCapabilities",
    path: "/api/v1/platforms/capabilities",
  },
  {
    method: "GET",
    operationId: "listPlatformAccounts",
    path: "/api/v1/platforms",
  },
  {
    method: "GET",
    operationId: "getPlatformPublishingRequirements",
    path: "/api/v1/platforms/00000000-0000-4000-8000-000000000201/publishing-requirements",
  },
  {
    method: "GET",
    operationId: "startPlatformOAuth",
    path: "/api/v1/platforms/threads/connect?brand_profile_id=00000000-0000-4000-8000-000000000111",
  },
  {
    method: "GET",
    operationId: "completePlatformOAuth",
    path: "/api/v1/platforms/threads/callback?code=provider-code&state=state-with-enough-length",
  },
  {
    method: "DELETE",
    operationId: "disconnectPlatformAccount",
    path: "/api/v1/platforms/00000000-0000-4000-8000-000000000201",
  },
  {
    method: "GET",
    operationId: "getOAuthSelection",
    path: "/api/v1/oauth-selections/select_session_alpha_1234567890",
  },
  {
    method: "POST",
    operationId: "confirmOAuthSelection",
    path: "/api/v1/oauth-selections/select_session_alpha_1234567890/confirm",
  },
  {
    method: "DELETE",
    operationId: "cancelOAuthSelection",
    path: "/api/v1/oauth-selections/select_session_alpha_1234567890",
  },
  { method: "GET", operationId: "listPosts", path: "/api/v1/posts" },
  { method: "POST", operationId: "createPost", path: "/api/v1/posts" },
  {
    method: "GET",
    operationId: "getPost",
    path: "/api/v1/posts/00000000-0000-4000-8000-000000000701",
  },
  {
    method: "PATCH",
    operationId: "updatePost",
    path: "/api/v1/posts/00000000-0000-4000-8000-000000000701",
  },
  {
    method: "DELETE",
    operationId: "deletePost",
    path: "/api/v1/posts/00000000-0000-4000-8000-000000000701",
  },
  {
    method: "POST",
    operationId: "schedulePost",
    path: "/api/v1/posts/00000000-0000-4000-8000-000000000701/schedule",
  },
  {
    method: "POST",
    operationId: "createUploadSession",
    path: "/api/v1/asset-upload-sessions",
  },
  {
    method: "GET",
    operationId: "getUploadSession",
    path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000501",
  },
  {
    method: "DELETE",
    operationId: "abortUploadSession",
    path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000501",
  },
  {
    method: "POST",
    operationId: "createUploadPartUrls",
    path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000501/parts",
  },
  {
    method: "POST",
    operationId: "completeUploadSession",
    path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000501/complete",
  },
  {
    method: "GET",
    operationId: "getAsset",
    path: "/api/v1/assets/00000000-0000-4000-8000-000000000101",
  },
  {
    method: "GET",
    operationId: "getAssetDownloadUrl",
    path: "/api/v1/assets/00000000-0000-4000-8000-000000000101/download-url",
  },
  {
    method: "GET",
    operationId: "getAssetPreviewUrl",
    path: "/api/v1/assets/00000000-0000-4000-8000-000000000101/preview-url",
  },
  {
    method: "GET",
    operationId: "listDistributions",
    path: "/api/v1/distributions",
  },
  {
    method: "GET",
    operationId: "getDistribution",
    path: "/api/v1/distributions/00000000-0000-4000-8000-000000000301",
  },
  {
    method: "PATCH",
    operationId: "updateScheduledDistribution",
    path: "/api/v1/distributions/00000000-0000-4000-8000-000000000301",
  },
  {
    method: "DELETE",
    operationId: "cancelDistribution",
    path: "/api/v1/distributions/00000000-0000-4000-8000-000000000301",
  },
  {
    method: "POST",
    operationId: "retryDistribution",
    path: "/api/v1/distributions/00000000-0000-4000-8000-000000000301/retry",
  },
  {
    method: "GET",
    operationId: "listCalendarEvents",
    path: "/api/v1/calendar?start=2026-01-01T00%3A00%3A00Z&end=2026-01-31T00%3A00%3A00Z",
  },
  {
    method: "GET",
    operationId: "getAnalyticsSummary",
    path: "/api/v1/analytics?start=2026-01-01T00%3A00%3A00Z&end=2026-01-31T00%3A00%3A00Z",
  },
  {
    method: "GET",
    operationId: "getDistributionAnalytics",
    path: "/api/v1/analytics/00000000-0000-4000-8000-000000000301",
  },
  { method: "GET", operationId: "listInboxComments", path: "/api/v1/inbox" },
  {
    method: "POST",
    operationId: "replyToComment",
    path: "/api/v1/inbox/00000000-0000-4000-8000-000000000401/reply",
  },
];

function body<T>(operationId: string): T {
  return catalog.operations[operationId]!.success.body as T;
}

const coreService = {
  activeOrganization: () => Effect.succeed("20000000-0000-4000-8000-000000000001"),
  calendar: () => Effect.succeed(body<{ events: unknown[] }>("listCalendarEvents").events),
  cancelDistribution: () =>
    Effect.succeed({
      replayed: false,
      status: 204 as const,
      value: body("getDistribution"),
    }),
  disconnectPlatform: () => Effect.succeed({ replayed: false, value: undefined }),
  distributionAnalytics: () =>
    Effect.succeed(body<{ snapshots: unknown[] }>("getDistributionAnalytics").snapshots),
  getDistribution: () => Effect.succeed(body("getDistribution")),
  inbox: () => Effect.succeed(body("listInboxComments")),
  listDistributions: () => Effect.succeed(body("listDistributions")),
  listPlatformAccounts: () =>
    Effect.succeed(body<{ accounts: unknown[] }>("listPlatformAccounts").accounts),
  platformCapabilities: () =>
    body<{ capabilities: unknown[] }>("listPlatformCapabilities").capabilities,
  replyToComment: () =>
    Effect.succeed({
      replayed: false,
      value: body("replyToComment"),
    }),
  retryDistribution: () =>
    Effect.succeed({
      replayed: false,
      value: body("retryDistribution"),
    }),
  summaryAnalytics: () => Effect.succeed(body("getAnalyticsSummary")),
  updateDistribution: () =>
    Effect.succeed({
      replayed: false,
      value: body("updateScheduledDistribution"),
    }),
} as CoreApiService;

// Upload-session surface only: media inventory reads are single-Asset scoped,
// so the library listing, text composition, and Asset deletion are gone.
const assetService = {
  abortUploadSession: () => Effect.succeed({ replayed: false }),
  completeUploadSession: () =>
    Effect.succeed({
      replayed: false,
      value: body("completeUploadSession"),
    }),
  createUploadPartUrls: () => Effect.succeed(body("createUploadPartUrls")),
  createUploadSession: () =>
    Effect.succeed({
      replayed: false,
      value: body("createUploadSession"),
    }),
  getAsset: () => Effect.succeed(body("getAsset")),
  getAssetDownloadUrl: () => Effect.succeed(body("getAssetDownloadUrl")),
  getAssetPreviewUrl: () => Effect.succeed(body("getAssetPreviewUrl")),
  getUploadSession: () => Effect.succeed(body("getUploadSession")),
} as AssetApiService;

// Post composition double: each operation returns its own golden fixture so
// route responses validate against the shared catalog rather than an echo.
const postService = {
  createPost: () =>
    Effect.succeed({
      replayed: false,
      value: body("createPost"),
    }),
  deletePost: () =>
    Effect.succeed({
      replayed: false,
      value: body("deletePost"),
    }),
  getPost: () => Effect.succeed(body("getPost")),
  listPosts: () => Effect.succeed(body("listPosts")),
  schedulePost: () =>
    Effect.succeed({
      replayed: false,
      value: body("schedulePost"),
    }),
  updatePost: () =>
    Effect.succeed({
      replayed: false,
      value: body("updatePost"),
    }),
} as PostApiService;

// Brand Profile conformance double: every lifecycle method returns the golden
// fixture for its operation so route responses match the shared catalog.
const brandProfileService = {
  createBrandProfile: () =>
    Effect.succeed({
      replayed: false,
      value: body("createBrandProfile"),
    }),
  deleteBrandProfile: () =>
    Effect.succeed({
      replayed: false,
      value: body("deleteBrandProfile"),
    }),
  getBrandProfile: () => Effect.succeed(body("getBrandProfile")),
  listBrandProfiles: () =>
    Effect.succeed(body<{ profiles: unknown[] }>("listBrandProfiles").profiles),
  listDeletedBrandProfiles: () =>
    Effect.succeed(body<{ profiles: unknown[] }>("listDeletedBrandProfiles").profiles),
  restoreBrandProfile: () =>
    Effect.succeed({
      replayed: false,
      value: body("restoreBrandProfile"),
    }),
  updateBrandProfile: () =>
    Effect.succeed({
      replayed: false,
      value: body("updateBrandProfile"),
    }),
} as BrandProfileApiService;

const capabilities = body<{
  capabilities: CoreApiService["platformCapabilities"] extends () => infer T ? T : never;
}>("listPlatformCapabilities").capabilities;
const threadsCapability = capabilities.find((capability) => capability.platform === "threads")!;
const providerRegistry = new ProviderRegistry();
providerRegistry.register("threads", {
  authorizationUrl: () => "https://provider.example.test/oauth/authorize",
  capability: {
    ...threadsCapability,
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    publish: false,
    reply: false,
  },
  exchangeAuthorizationCode: async () => ({
    accessToken: "provider-access-token",
    account: { displayName: "Creator", id: "provider-account" },
    refreshToken: "provider-refresh-token",
    scopes: ["threads_basic", "threads_content_publish"],
  }),
  transferModes: [],
});

const conformanceTestKey = "0123456789abcdef0123456789abcdef";
const oauthState = {
  create: async () => undefined,
  consume: async () => ({
    brand_profile_id: "00000000-0000-4000-8000-000000000111",
    expires_at: Date.now() + 60_000,
    organization_id: "00000000-0000-4000-8000-000000000001",
    pkce_verifier: "pkce-verifier",
    provider: "threads",
    redirect_path: "/channels",
    user_id: "00000000-0000-4000-8000-000000000012",
  }),
  appendSelectionCandidates: async () => undefined,
  createSelection: async () => undefined,
  finalizeSelection: async () => undefined,
  getSelection: async () => {
    if (contractFailureStatus === 404) return null;
    return body("getOAuthSelection");
  },
  claimSelection: async () => {
    if (contractFailureStatus === 404) return { status: "not_found" as const };
    if (contractFailureStatus === 400)
      return { status: "invalid_account" as const, message: "Invalid account" };
    const cipher = new TokenCipher({
      currentKeyId: "primary",
      keys: [{ id: "primary", material: conformanceTestKey }],
    });
    const sealed = await cipher.encrypt(
      JSON.stringify({
        accessToken: "provider-access-token",
        account: { id: "page_1001", displayName: "Acme Main Facebook Page" },
        scopes: [],
      }),
    );
    return {
      brandProfileId: "00000000-0000-4000-8000-000000000111",
      claimToken: "test-claim-token",
      encryptedConnection: sealed,
      organizationId: "00000000-0000-4000-8000-000000000001",
      platform: "facebook",
      status: "claimed" as const,
      userId: "00000000-0000-4000-8000-000000000012",
    };
  },
  completeSelection: async () => true,
  releaseSelectionClaim: async () => true,
  cancelSelection: async () => {
    if (contractFailureStatus === 404) return { status: "not_found" as const };
    return { status: "cancelled" as const };
  },
};
const readyBinding = {};
const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ASSETS: readyBinding,
  DB_AUTHENTICATED: readyBinding,
  DB_SYSTEM: readyBinding,
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  OAUTH_STATE: { getByName: () => oauthState },
  PUBLIC_API_URL: "http://localhost:8787",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_ACCOUNT_ID: "test-account",
  R2_BUCKET_NAME: "test-assets",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  TOKEN_ENCRYPTION_KEY: conformanceTestKey,
  VERSION: "1.0.0-target.0",
} as unknown as ApiWorkerEnv;

const actorFixture = {
  authUserId: "ba_user_alpha_01",
  claims: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "ba_user_alpha_01",
    userId: "00000000-0000-4000-8000-000000000012",
  },
  role: "admin" as const,
  userId: "00000000-0000-4000-8000-000000000012",
  workspace: {
    id: "00000000-0000-4000-8000-000000000001",
    isPersonal: false,
    name: "Alpha",
    slug: "org-alpha",
  },
};

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "alpha@example.com",
  name: "Alpha User",
  subject: "ba_user_alpha_01",
};

// Protected-route credential: a fixed bearer JWT standing in for the Better
// Auth access token the browser mints; `verifyJwtToken` maps it to jwtIdentity.
const bearerAuthorization = "Bearer test-only.jwt";

let contractFailureStatus: number | undefined;

/**
 * Resolves the Better Auth operation represented by its same-origin route.
 *
 * The conformance double must return the golden payload for Better Auth's
 * pass-through routes, while production delegates the same paths unchanged to
 * Better Auth.
 *
 * @param request - Auth handler request emitted by the API router.
 * @returns OpenAPI operation identifier for that route.
 */
function authOperationId(request: Request): string {
  const operationByPath: Record<string, string> = {
    "/api/auth/change-password": "changePassword",
    "/api/auth/get-session": "getAuthSession",
    "/api/auth/request-password-reset": "requestPasswordReset",
    "/api/auth/reset-password": "resetPassword",
    "/api/auth/sign-in/email": "signInWithEmail",
    "/api/auth/sign-out": "signOut",
    "/api/auth/sign-up/email": "signUpWithEmail",
    "/api/auth/verify-email": "verifyEmail",
  };
  const operation = operationByPath[new URL(request.url).pathname];
  if (operation === undefined) {
    throw new Error(`Unexpected Better Auth route: ${request.url}`);
  }
  return operation;
}

/**
 * Builds a golden contract response from the success fixture or a requested
 * documented error. The response is intentionally opaque to the application:
 * Better Auth is a delegated HTTP handler rather than an API service method.
 *
 * @param operationId - OpenAPI operation represented by the delegated route.
 * @returns Handler response matching that operation's active fixture.
 */
function authContractResponse(operationId: string): Response {
  const operation = catalog.operations[operationId]!;
  const response =
    contractFailureStatus === undefined
      ? operation.success
      : operation.errors.find((candidate) => candidate.status === contractFailureStatus);
  if (response === undefined) {
    throw new Error(`No ${contractFailureStatus} fixture exists for ${operationId}.`);
  }
  return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
    headers: {
      ...(response.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...response.headers,
    },
    status: response.status,
  });
}

/**
 * Delegates auth conformance requests to their operation-specific golden
 * Better Auth response. It models the library boundary without reimplementing
 * Better Auth in the API test. `getSession` remains only to satisfy the
 * BetterAuthInstance shape: protected routes authenticate the bearer JWT
 * through `verifyJwtToken`, never a session lookup.
 */
const betterAuthStub = {
  api: {
    getSession: async () => null,
  },
  handler: async (request: Request) => authContractResponse(authOperationId(request)),
};

/**
 * Returns the lifecycle contract response for a native Workspace route.
 *
 * Production lifecycle routes own transaction and authorization behavior,
 * exercised by the lifecycle integration tests. This conformance double
 * isolates response-schema verification from a PostgreSQL fixture.
 *
 * @param operationId - OpenAPI Workspace operation served by the route.
 * @returns Golden success or documented error response for that operation.
 */
function workspaceContractResponse(operationId: string): Response {
  const operation = catalog.operations[operationId]!;
  const response =
    contractFailureStatus === undefined
      ? operation.success
      : operation.errors.find((candidate) => candidate.status === contractFailureStatus);
  if (response === undefined) {
    throw new Error(`No ${contractFailureStatus} fixture exists for ${operationId}.`);
  }
  return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
    headers: {
      ...(response.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...response.headers,
    },
    status: response.status,
  });
}

/**
 * Registers native Workspace conformance doubles at the same paths as the
 * production lifecycle module. This preserves app-level auth/error middleware
 * coverage while database-backed lifecycle behavior remains covered separately.
 *
 * @param lifecycleApp - API app receiving the Workspace route registrations.
 */
function registerWorkspaceContractRoutes(lifecycleApp: Hono<ApiWorkerEnvironment>): void {
  lifecycleApp.post("/api/v1/workspaces", () => workspaceContractResponse("createWorkspace"));
  lifecycleApp.patch("/api/v1/workspaces/:workspaceId", () =>
    workspaceContractResponse("updateWorkspace"),
  );
  lifecycleApp.post("/api/v1/workspaces/:workspaceId/invitations", () =>
    workspaceContractResponse("createWorkspaceInvitation"),
  );
  lifecycleApp.delete("/api/v1/workspaces/:workspaceId/invitations/:invitationId", () =>
    workspaceContractResponse("revokeWorkspaceInvitation"),
  );
  lifecycleApp.post("/api/v1/workspace-invitations/:token/accept", () =>
    workspaceContractResponse("acceptWorkspaceInvitation"),
  );
  lifecycleApp.patch("/api/v1/workspaces/:workspaceId/members/:memberId", () =>
    workspaceContractResponse("updateWorkspaceMember"),
  );
  lifecycleApp.delete("/api/v1/workspaces/:workspaceId/members/:memberId", () =>
    workspaceContractResponse("removeWorkspaceMember"),
  );
}

registerWorkspaceLifecycleRoutes.mockImplementation(registerWorkspaceContractRoutes);

const app = createApiApp({
  assetService,
  betterAuth: () => betterAuthStub,
  brandProfileService,
  coreService,
  loadCurrentUser: async () => body("getCurrentUser"),
  providerRegistry,
  publicationRequirements: () =>
    Effect.succeed({
      commentAllowed: true,
      creatorAvatarUrl: "https://cdn.example.test/tiktok-alpha.jpg",
      creatorDisplayName: "Alpha on TikTok",
      creatorUsername: "alpha.creator",
      duetAllowed: false,
      maxVideoDurationSeconds: 300,
      platform: "tiktok" as const,
      privacyLevels: ["PUBLIC_TO_EVERYONE" as const, "SELF_ONLY" as const],
      stitchAllowed: true,
    }),
  postService,
  resolveActor: async () => actorFixture,
  revokeOAuthConnection: () => Effect.succeed(undefined),
  saveOAuthConnection: () => Effect.succeed(undefined),
  verifyJwtToken: async () => jwtIdentity,
});

const unsupportedCapabilities = capabilities.map((capability) => ({
  ...capability,
  connect_available: false,
}));

/**
 * Creates an app whose service boundaries return one documented error status.
 *
 * Workspace and Better Auth conformance doubles share the selected status so
 * every route reaches the production error middleware with its fixture shape.
 *
 * @param status - OpenAPI error response status to exercise.
 * @returns API app configured to emit that documented error.
 */
function errorApp(status: number) {
  contractFailureStatus = status;
  const code =
    status === 401
      ? "authentication_required"
      : status === 404
        ? "not_found"
        : status === 409
          ? "invalid_state"
          : status === 422
            ? "validation_error"
            : "invalid_request";
  const effectFailure = () =>
    Effect.fail(new CoreApiError(status, code, "The contract error fixture was requested."));
  const throwingCore = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") return undefined;
        return property === "platformCapabilities" ? () => unsupportedCapabilities : effectFailure;
      },
    },
  ) as CoreApiService;
  const throwingAssets = new Proxy(
    {},
    {
      get: (_target, property) => (property === "then" ? undefined : effectFailure),
    },
  ) as AssetApiService;
  const throwingPosts = new Proxy(
    {},
    {
      get: (_target, property) => (property === "then" ? undefined : effectFailure),
    },
  ) as PostApiService;
  const throwingBrandProfiles = new Proxy(
    {},
    {
      get: (_target, property) => (property === "then" ? undefined : effectFailure),
    },
  ) as BrandProfileApiService;

  return createApiApp({
    assetService: throwingAssets,
    betterAuth: () => betterAuthStub,
    brandProfileService: throwingBrandProfiles,
    coreService: throwingCore,
    loadCurrentUser: async () => body("getCurrentUser"),
    providerRegistry: new ProviderRegistry(),
    publicationRequirements: effectFailure,
    postService: throwingPosts,
    resolveActor: async () => actorFixture,
    revokeOAuthConnection: () => Effect.succeed(undefined),
    saveOAuthConnection: () => Effect.succeed(undefined),
    verifyJwtToken: async () => jwtIdentity,
  });
}

const errorPathOverrides: Record<string, string> = {
  completePlatformOAuth: "/api/v1/platforms/threads/callback?state=short-state",
  getAnalyticsSummary:
    "/api/v1/analytics?start=2026-02-01T00%3A00%3A00Z&end=2026-01-01T00%3A00%3A00Z",
  getReadiness: "/api/v1/ready",
  listCalendarEvents:
    "/api/v1/calendar?start=2026-02-01T00%3A00%3A00Z&end=2026-01-01T00%3A00%3A00Z",
  startPlatformOAuth: "/api/v1/platforms/tiktok/connect",
};

describe("API Worker OpenAPI conformance", () => {
  beforeEach(() => {
    contractFailureStatus = undefined;
  });
  let validator: ContractValidator;

  beforeAll(async () => {
    validator = await ContractValidator.create();
  });

  for (const testCase of cases) {
    it(`${testCase.method} ${testCase.path} implements ${testCase.operationId}`, async () => {
      const example = catalog.operations[testCase.operationId]!;
      const headers: Record<string, string> = {
        Authorization: bearerAuthorization,
        "Idempotency-Key": `worker-conformance-${testCase.operationId}`,
      };
      let requestBody: string | undefined;
      if (example.request !== undefined) {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(example.request);
      }

      const response = await app.request(
        testCase.path,
        { body: requestBody, headers, method: testCase.method },
        env,
      );
      expect(response.status, testCase.operationId).toBe(example.success.status);
      expect(response.headers.get("X-Request-ID"), testCase.operationId).toBeTruthy();

      const responseBody = response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : undefined;
      expect(
        validator.validateResponse(testCase.operationId, response.status, responseBody),
        testCase.operationId,
      ).toBeUndefined();

      if (!new Set(["getHealth", "getReadiness"]).has(testCase.operationId)) {
        expect(responseBody, `${testCase.operationId} golden response`).toEqual(
          example.success.body,
        );
      }
      for (const headerName of Object.keys(example.success.headers ?? {})) {
        const actual = response.headers.get(headerName);
        expect(actual, `${testCase.operationId} ${headerName}`).toBeTruthy();
        if (headerName.toLowerCase() === "location") {
          expect(() => new URL(actual!)).not.toThrow();
        }
      }
    });
  }

  it("covers every OpenAPI operation and every golden success fixture", () => {
    const operationIds = cases.map((item) => item.operationId).sort();
    expect(operationIds).toEqual([...validator.operations.keys()].sort());
    expect(operationIds).toEqual(Object.keys(catalog.operations).sort());
  });

  for (const testCase of cases) {
    const example = catalog.operations[testCase.operationId]!;
    for (const [errorIndex, errorExample] of example.errors.entries()) {
      it(`${testCase.operationId} implements its documented ${errorExample.status} error fixture`, async () => {
        const errorRequest = errorPathOverrides[testCase.operationId] ?? testCase.path;
        const headers: Record<string, string> = {
          "Idempotency-Key": `worker-error-${testCase.operationId}-${errorIndex}`,
        };
        if (errorExample.status !== 401) {
          headers.Authorization = bearerAuthorization;
        }
        let requestBody: string | undefined;
        if (example.request !== undefined) {
          headers["Content-Type"] = "application/json";
          requestBody = JSON.stringify(example.request);
        }

        const errorEnvironment =
          testCase.operationId === "getReadiness"
            ? ({ ...env, DB_SYSTEM: undefined } as unknown as ApiWorkerEnv)
            : env;
        const response = await errorApp(errorExample.status).request(
          errorRequest,
          { body: requestBody, headers, method: testCase.method },
          errorEnvironment,
        );
        expect(response.status, testCase.operationId).toBe(errorExample.status);
        const responseBody = response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : undefined;
        expect(
          validator.validateResponse(testCase.operationId, response.status, responseBody),
          `${testCase.operationId} ${errorExample.status}`,
        ).toBeUndefined();
      });
    }
  }
});

describe("runtime contract cases", () => {
  beforeEach(() => {
    contractFailureStatus = undefined;
  });

  it("loads a versioned shared manifest", () => {
    expect(parityManifest.version).toBe(1);
    expect(parityManifest.cases.length).toBeGreaterThan(0);
  });

  for (const parity of parityManifest.cases) {
    it(`${parity.method} ${parity.path} preserves ${parity.name}`, async () => {
      const response = await app.request(parity.path, { method: parity.method }, env);
      expect(response.status).toBe(parity.expected_status);
      expect(response.headers.get("content-type")).toContain(parity.expected_content_type);

      if (parity.json_subset) {
        await expect(response.json()).resolves.toMatchObject(parity.json_subset);
      }
    });
  }
});
