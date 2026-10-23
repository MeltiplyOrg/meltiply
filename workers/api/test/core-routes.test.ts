import type { components } from "@meltiply/contracts/schema";
import type {
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthStateRecord,
} from "@meltiply/contracts";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type OAuthAccountSelection,
  validatePublishInput,
} from "@meltiply/providers";
import { oauthStateRoutingKey } from "../src/core-routes";
import { tokenCipherFor } from "../src/token-credentials";
import { AccessDenied, StorageUnavailable, type PlatformCapability } from "@meltiply/domain";
import type { JwtIdentity, SessionClaims } from "@meltiply/auth";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp, type ApiDependencies } from "../src/app";
import type { AssetApiService } from "../src/asset-types";
import type { BrandProfileApiService } from "../src/brand-profile-service";
import { CoreApiError, type CoreApiService } from "../src/core-types";
import type { ApiWorkerEnv, OAuthStateStub } from "../src/env";
import type { PostApiService } from "../src/post-types";
import { logRecords } from "./log-records";

// The route graph statically reaches ./database via workspace-lifecycle; an
// empty mock keeps the `pg` client out of the workerd unit-test isolate.
vi.mock("../src/database", () => ({}));

afterEach(() => {
  vi.restoreAllMocks();
});

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: "http://localhost:8787",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Actor claims mirror the ResolvedActor contract produced by actor resolution:
// subject is the Better Auth user id, userId the internal users.id UUID, and
// organizationId the resolved workspace UUID with its org_members role.
const session = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationRole: "admin",
  subject: "user_better_alpha",
  userId: "00000000-0000-4000-8000-000000000011",
} satisfies SessionClaims;

const actor: ResolvedActor = {
  authUserId: session.subject,
  claims: session,
  displayName: "Alpha Admin",
  email: "alpha@example.com",
  isInstallationOwner: false,
  role: "admin",
  userId: session.userId,
  workspace: {
    id: session.organizationId,
    name: "Alpha",
    slug: "alpha",
  },
};

// Deterministic Brand Profile fixture id matching the contract examples; the
// profile owns every asset, account, distribution, and comment fixture in
// this suite so profile-owned mutations carry a consistent owner.
const brandProfileId = "00000000-0000-4000-8000-000000000111";
// Post identity shared by every composer fixture in this suite, matching the
// contract examples so route paths stay contract-addressable.
const postId = "00000000-0000-4000-8000-000000000701";

// Golden BrandProfile row matching the contract examples; the profile belongs
// to the session workspace so profile-scoped routes resolve it.
const brandProfile: components["schemas"]["BrandProfile"] = {
  color: "#b91c1c",
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  id: brandProfileId,
  name: "Alpha Brand",
  description: "Editorial tools for independent publishers.",
  org_id: session.organizationId,
  purge_at: null,
  updated_at: "2026-01-01T00:00:00Z",
};

function unavailableCapabilities(): ReturnType<ProviderRegistry["capabilities"]> {
  return (["tiktok", "youtube", "instagram", "facebook", "threads"] as const).map((platform) => ({
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    connect_available: false,
    max_caption_length: null,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: null,
    multi_asset_types: null,
    notes: ["Provider adapter is not configured."],
    platform,
    publish: false,
    reply: false,
  }));
}

/**
 * Test helper creating a mock service conforming to CoreApiService.
 *
 * Defaults all Effect-returning methods to a defect so tests only succeed when
 * exercising explicitly mocked behavior; `platformCapabilities` stays
 * synchronous because the route boundary reads it directly.
 *
 * @param overrides - Optional method overrides for CoreApiService.
 * @returns Mock service accepted by createApiApp.
 */
function service(overrides: Partial<CoreApiService> = {}): CoreApiService {
  const notImplemented = () => Effect.die(new Error("unexpected service call"));
  return {
    activeOrganization: notImplemented,
    analyticsPosts: notImplemented,
    calendar: notImplemented,
    cancelDistribution: notImplemented,
    dashboardAnalytics: notImplemented,
    disconnectPlatform: notImplemented,
    distributionAnalytics: notImplemented,
    getDistribution: notImplemented,
    inbox: notImplemented,
    listDistributions: notImplemented,
    listPlatformAccounts: notImplemented,
    platformCapabilities: unavailableCapabilities,
    replyToComment: notImplemented,
    retryDistribution: notImplemented,
    summaryAnalytics: notImplemented,
    updateDistribution: notImplemented,
    ...overrides,
  };
}

// Binary Asset fixture matching the contract examples. Signed URLs stay null
// here: media capabilities are minted only by the scoped preview/download
// routes, so a Post response never embeds one.
const asset: components["schemas"]["Asset"] = {
  asset_type: "image",
  brand_profile_id: brandProfileId,
  created_at: "2026-07-18T00:00:00.000Z",
  download_url: null,
  duration_sec: null,
  failure: null,
  file_size: 1024,
  height: null,
  id: "00000000-0000-4000-8000-000000000501",
  mime_type: "image/png",
  org_id: "00000000-0000-4000-8000-000000000001",
  status: "pending_upload",
  thumbnail_url: null,
  title: "Launch image",
  updated_at: "2026-07-18T00:00:00.000Z",
  uploaded_by: "00000000-0000-4000-8000-000000000002",
  width: null,
};

// Canonical Post fixture matching the contract examples: a draft with no
// saved Channel yet, which is the state every composer route must support.
const post: components["schemas"]["Post"] = {
  analytics: null,
  attachments: [{ asset_id: asset.id, asset, position: 0 }],
  brand_profile_id: brandProfileId,
  created_at: "2026-07-18T00:00:00.000Z",
  default_text: "Hello world",
  distributions: [],
  id: postId,
  org_id: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  status: "draft",
  targets: [],
  title: "Launch note",
  updated_at: "2026-07-18T00:00:00.000Z",
};

/**
 * Test helper creating a mock service conforming to AssetApiService.
 *
 * Defaults all methods to an Effect defect so tests only succeed when
 * exercising explicitly mocked behavior.
 *
 * @param overrides - Optional method overrides for AssetApiService.
 * @returns Mock asset service accepted by createApiApp.
 */
function assetService(overrides: Partial<AssetApiService> = {}): AssetApiService {
  const notImplemented = () => Effect.die(new Error("unexpected asset service call"));
  return {
    abortUploadSession: notImplemented,
    completeUploadSession: notImplemented,
    createUploadPartUrls: notImplemented,
    createUploadSession: notImplemented,
    getAsset: notImplemented,
    getAssetDownloadUrl: notImplemented,
    getAssetPreviewUrl: notImplemented,
    getUploadSession: notImplemented,
    ...overrides,
  };
}

/**
 * Test helper creating a mock service conforming to BrandProfileApiService.
 *
 * Defaults all methods to an Effect defect so tests only succeed when
 * exercising explicitly mocked behavior, except `getBrandProfile` which
 * resolves the active workspace fixture: the OAuth connect route consults it
 * on every request, so connect tests share one sane default and override it
 * only when exercising the missing/deleted-profile guard.
 *
 * @param overrides - Optional method overrides for BrandProfileApiService.
 * @returns Mock brand profile service accepted by createApiApp.
 */
function brandProfileService(
  overrides: Partial<BrandProfileApiService> = {},
): BrandProfileApiService {
  const notImplemented = () => Effect.die(new Error("unexpected brand profile service call"));
  return {
    createBrandProfile: notImplemented,
    deleteBrandProfile: notImplemented,
    getBrandProfile: vi.fn(() => Effect.succeed(brandProfile)),
    listBrandProfiles: notImplemented,
    listDeletedBrandProfiles: notImplemented,
    restoreBrandProfile: notImplemented,
    updateBrandProfile: notImplemented,
    ...overrides,
  };
}

/**
 * Test helper creating a mock service conforming to PostApiService.
 *
 * Defaults every method to an Effect defect so tests only succeed when
 * exercising explicitly mocked behavior.
 *
 * @param overrides - Optional method overrides for PostApiService.
 * @returns Mock Post service accepted by createApiApp.
 */
function postService(overrides: Partial<PostApiService> = {}): PostApiService {
  const notImplemented = () => Effect.die(new Error("unexpected post service call"));
  return {
    createPost: notImplemented,
    deletePost: notImplemented,
    getPost: notImplemented,
    listPosts: notImplemented,
    schedulePost: notImplemented,
    updatePost: notImplemented,
    ...overrides,
  };
}

/**
 * Builds an authenticated API app instance configured with the provided core service and dependencies.
 *
 * Injects the fixed test actor through `resolveActor` and a fixed verified
 * identity through `verifyJwtToken`; requests authenticate by carrying the
 * JWT bearer Authorization header in `bearerHeaders`.
 *
 * @param coreService - Service instance conforming to CoreApiService.
 * @param dependencies - Optional additional API worker dependencies to inject.
 * @returns Configured Hono app instance ready for test requests.
 */
function authenticatedApp(
  coreService: CoreApiService,
  dependencies: Omit<ApiDependencies, "coreService" | "resolveActor" | "verifyJwtToken"> = {},
) {
  return createApiApp({
    coreService,
    ...dependencies,
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentity,
  });
}

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "alpha@example.test",
  name: "Alpha User",
  subject: session.subject,
};

// JWT bearer Authorization header standing in for the Better Auth session
// cookie on every protected-route request.
const bearerHeaders = {
  Authorization: "Bearer test-only.jwt",
};

function oauthRegistry() {
  const authorizationUrl = vi.fn(
    ({
      codeChallenge,
      redirectUri,
      state,
    }: {
      codeChallenge: string;
      redirectUri: string;
      state: string;
    }) => {
      const target = new URL("https://provider.example/authorize");
      target.searchParams.set("code_challenge", codeChallenge);
      target.searchParams.set("code_challenge_method", "S256");
      target.searchParams.set("redirect_uri", redirectUri);
      target.searchParams.set("state", state);
      return target.toString();
    },
  );
  const exchangeAuthorizationCode = vi.fn(async () => ({
    accessToken: "provider-access-token",
    account: {
      displayName: "Creator",
      id: "provider-user-1",
    },
    expiresAt: "2026-08-01T00:00:00.000Z",
    refreshToken: "provider-refresh-token",
    scopes: ["publish"],
  }));
  const registry = new ProviderRegistry();
  registry.register("threads", {
    authorizationUrl,
    capability: {
      accepted_mime_types: ["text/plain"],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: true,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: 20,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: ["image", "video"],
      notes: [],
      platform: "threads",
      publish: false,
      reply: false,
    },
    exchangeAuthorizationCode,
    transferModes: [],
  });
  return { authorizationUrl, exchangeAuthorizationCode, registry };
}

describe("core API routes", () => {
  it.each([
    {
      error: new AccessDenied("workspace membership is required"),
      status: 403,
      code: "active_organization_required",
    },
    {
      error: new StorageUnavailable("storage is unavailable"),
      status: 503,
      code: "service_unavailable",
    },
  ])("maps $code domain errors to their HTTP contract", async ({ error, status, code }) => {
    const app = authenticatedApp(
      service({
        platformCapabilities: () => {
          throw error;
        },
      }),
    );
    const response = await app.request(
      "/api/v1/platforms/capabilities",
      { headers: bearerHeaders },
      env,
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      error: { code, message: error.message },
    });
  });
  it.each([
    {
      path: "/api/v1/posts",
      body: { brand_profile_id: brandProfileId, default_text: 42 },
    },
    {
      path: "/api/v1/asset-upload-sessions",
      body: { asset_type: "image", brand_profile_id: brandProfileId },
    },
  ])("keeps malformed $path fields on the typed 400 boundary", async ({ path, body }) => {
    const app = authenticatedApp(service(), {
      assetService: assetService(),
      postService: postService(),
    });
    const response = await app.request(
      path,
      {
        method: "POST",
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "invalid-asset-fields",
        },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it.each([
    {
      body: {
        brand_profile_id: brandProfileId,
        default_text: "Launch copy",
        title: "Launch post",
      },
      method: "POST",
      path: "/api/v1/posts",
    },
    {
      body: {
        asset_type: "image",
        brand_profile_id: brandProfileId,
        content_type: "image/png",
        file_size: 1024,
        filename: "launch.png",
        title: "Launch image",
      },
      method: "POST",
      path: "/api/v1/asset-upload-sessions",
    },
    {
      body: { part_numbers: [1] },
      method: "POST",
      path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000601/parts",
    },
    {
      body: { parts: [{ etag: "part-etag", part_number: 1 }] },
      method: "POST",
      path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000601/complete",
    },
    {
      method: "DELETE",
      path: "/api/v1/asset-upload-sessions/00000000-0000-4000-8000-000000000601",
    },
    {
      body: { brand_profile_id: brandProfileId },
      method: "DELETE",
      path: `/api/v1/posts/${postId}`,
    },
    {
      body: {
        brand_profile_id: brandProfileId,
        default_text: "Launch copy",
      },
      method: "PATCH",
      path: `/api/v1/posts/${postId}`,
    },
    {
      body: {
        brand_profile_id: brandProfileId,
        scheduled_at: null,
      },
      method: "POST",
      path: `/api/v1/posts/${postId}/schedule`,
    },
    {
      body: { title_override: "Updated launch" },
      method: "PATCH",
      path: "/api/v1/distributions/00000000-0000-4000-8000-000000000201",
    },
    {
      method: "POST",
      path: "/api/v1/distributions/00000000-0000-4000-8000-000000000201/retry",
    },
    {
      method: "DELETE",
      path: "/api/v1/distributions/00000000-0000-4000-8000-000000000201",
    },
    {
      body: { brand_profile_id: brandProfileId, text: "Thanks!" },
      method: "POST",
      path: "/api/v1/inbox/00000000-0000-4000-8000-000000000301/reply",
    },
    {
      method: "DELETE",
      path: "/api/v1/platforms/00000000-0000-4000-8000-000000000401",
    },
  ])("$method $path enforces the idempotency key boundary", async (testCase) => {
    const app = authenticatedApp(service(), {
      assetService: assetService(),
      postService: postService(),
    });
    for (const key of [undefined, "x".repeat(201)]) {
      const headers: Record<string, string> = { ...bearerHeaders };
      if (testCase.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (key !== undefined) {
        headers["Idempotency-Key"] = key;
      }

      const response = await app.request(
        testCase.path,
        {
          ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
          headers,
          method: testCase.method,
        },
        env,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "idempotency_key_required",
          retryable: false,
        },
      });
    }
  });

  // The composer creates an authoritative draft without any Channel selection:
  // a text-only Post is complete on its own and never schedules anything.
  it("creates a text-only Post draft with no Channel selection", async () => {
    const app = authenticatedApp(service(), {
      postService: postService({
        createPost: () =>
          Effect.succeed({
            replayed: true,
            value: { ...post, attachments: [], targets: [] },
          }),
      }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          title: "Launch post",
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-text-1",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(response.json()).resolves.toEqual({
      ...post,
      attachments: [],
      targets: [],
    });
  });

  // Listing is an aggregate read across active Brand Profiles, so omitting the
  // selector must stay valid while an unknown status is refused outright.
  it("validates the Post list selector and status enum", async () => {
    const listPosts = vi.fn(() =>
      Effect.succeed({ has_more: false, limit: 20, offset: 0, posts: [post] }),
    );
    const app = authenticatedApp(service(), {
      postService: postService({ listPosts }),
    });
    const aggregate = await app.request("/api/v1/posts", { headers: bearerHeaders }, env);
    expect(aggregate.status).toBe(200);
    await expect(aggregate.json()).resolves.toEqual({
      has_more: false,
      limit: 20,
      offset: 0,
      posts: [post],
    });

    for (const query of [
      "status=published",
      "status=draft&limit=0",
      "status=draft&offset=-1",
      "brand_profile_id=not-a-uuid",
    ]) {
      const rejected = await app.request(`/api/v1/posts?${query}`, { headers: bearerHeaders }, env);
      expect(rejected.status, query).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }
  });

  it("passes the calendar default and maximum limits to the service", async () => {
    const calendar = vi.fn(() => Effect.succeed([]));
    const app = authenticatedApp(service({ calendar }));
    const range = "start=2026-07-01T00:00:00.000Z&end=2026-07-31T23:59:59.000Z";

    const defaultResponse = await app.request(
      `/api/v1/calendar?${range}`,
      { headers: bearerHeaders },
      env,
    );
    expect(defaultResponse.status).toBe(200);
    expect(calendar).toHaveBeenNthCalledWith(
      1,
      env,
      session,
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-31T23:59:59.000Z"),
      500,
      undefined,
    );

    const maximumResponse = await app.request(
      `/api/v1/calendar?${range}&limit=1000`,
      { headers: bearerHeaders },
      env,
    );
    expect(maximumResponse.status).toBe(200);
    expect(calendar).toHaveBeenNthCalledWith(
      2,
      env,
      session,
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-31T23:59:59.000Z"),
      1000,
      undefined,
    );

    const rejected = await app.request(
      `/api/v1/calendar?${range}&limit=1001`,
      { headers: bearerHeaders },
      env,
    );
    expect(rejected.status).toBe(400);
    expect(calendar).toHaveBeenCalledTimes(2);
  });

  // Explicit TikTok publishing choices are saved on a Post target before any
  // scheduling, so an accepted payload must survive as durable target
  // settings while a contradictory combination is refused at the boundary.
  it("saves explicit TikTok publishing choices on a Post target", async () => {
    const saved: components["schemas"]["Post"] = {
      ...post,
      targets: [
        {
          attachment_ids: null,
          description_override: null,
          hashtags: [],
          platform_account_id: "00000000-0000-4000-8000-000000000401",
          provider_options: {
            tiktok: {
              allow_comment: true,
              allow_duet: false,
              allow_stitch: false,
              brand_content: false,
              brand_organic: true,
              is_ai_generated: false,
              music_usage_confirmed: true,
              privacy_level: "PUBLIC_TO_EVERYONE",
            },
          },
          title_override: null,
        },
      ],
    };
    const app = authenticatedApp(service(), {
      postService: postService({
        createPost: () => Effect.succeed({ replayed: false, value: saved }),
      }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          targets: [
            {
              platform_account_id: "00000000-0000-4000-8000-000000000401",
              provider_options: {
                tiktok: {
                  allow_comment: true,
                  allow_duet: false,
                  allow_stitch: false,
                  brand_content: false,
                  brand_organic: true,
                  is_ai_generated: false,
                  music_usage_confirmed: true,
                  privacy_level: "PUBLIC_TO_EVERYONE",
                },
              },
            },
          ],
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-tiktok-options",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(saved);

    const contradictory = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          targets: [
            {
              platform_account_id: "00000000-0000-4000-8000-000000000401",
              provider_options: {
                tiktok: {
                  allow_comment: true,
                  allow_duet: true,
                  allow_stitch: true,
                  brand_content: true,
                  brand_organic: false,
                  is_ai_generated: false,
                  music_usage_confirmed: false,
                  privacy_level: "SELF_ONLY",
                },
              },
            },
          ],
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-tiktok-options-invalid",
        },
        method: "POST",
      },
      env,
    );
    expect(contradictory.status).toBe(400);
    await expect(contradictory.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
  });

  // YouTube options must coexist with the required Brand Profile ownership
  // boundary before the saved target reaches the service.
  it("saves YouTube publishing choices on a Post target", async () => {
    const app = authenticatedApp(service(), {
      postService: postService({
        createPost: () => Effect.succeed({ replayed: false, value: post }),
      }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          targets: [
            {
              platform_account_id: "00000000-0000-4000-8000-000000000401",
              provider_options: {
                youtube: {
                  made_for_kids: true,
                  privacy_status: "unlisted",
                },
              },
            },
          ],
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-youtube-options",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
  });

  // A text-only Channel is expressed by an empty attachment selection, which
  // keeps the Post identity intact while publishing nothing on that Channel.
  it("accepts a text-only Channel selection alongside inherited media", async () => {
    const saved = {
      ...post,
      targets: [
        {
          attachment_ids: [],
          description_override: null,
          hashtags: [],
          platform_account_id: "00000000-0000-4000-8000-000000000401",
          provider_options: null,
          title_override: null,
        },
      ],
    };
    const app = authenticatedApp(service(), {
      postService: postService({
        createPost: () => Effect.succeed({ replayed: false, value: saved }),
      }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          attachment_ids: [asset.id],
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          targets: [
            {
              attachment_ids: [],
              platform_account_id: "00000000-0000-4000-8000-000000000401",
            },
          ],
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-text-only-target",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(saved);
  });
  // Malformed composition input must never reach the service: every case here
  // is a payload the composer itself could not have produced.
  const invalidCompositions: {
    attachmentIds?: string[];
    name: string;
    providerOptions?: unknown;
  }[] = [
    {
      name: "an unknown privacy_status enum value",
      providerOptions: {
        youtube: { made_for_kids: false, privacy_status: "subscribers" },
      },
    },
    {
      name: "an inherited toString property as privacy_status",
      providerOptions: {
        youtube: { made_for_kids: false, privacy_status: "toString" },
      },
    },
    {
      name: "an inherited constructor property as privacy_status",
      providerOptions: {
        youtube: { made_for_kids: false, privacy_status: "constructor" },
      },
    },
    {
      name: "a missing made_for_kids declaration",
      providerOptions: { youtube: { privacy_status: "private" } },
    },
    {
      name: "a non-boolean made_for_kids value",
      providerOptions: { youtube: { made_for_kids: "no" } },
    },
    {
      name: "an unknown key inside the youtube options",
      providerOptions: {
        youtube: { made_for_kids: false, notify_subscribers: true },
      },
    },
    {
      name: "a non-object youtube options value",
      providerOptions: { youtube: "private" },
    },
    {
      name: "an unknown provider options key",
      providerOptions: { vimeo: { privacy_status: "public" } },
    },
    {
      attachmentIds: [asset.id, asset.id],
      name: "a repeated attachment identifier",
    },
  ];

  it.each(invalidCompositions)("rejects $name before the post service runs", async (testCase) => {
    const createPost = vi.fn(() => Effect.die(new Error("unexpected call")));
    const app = authenticatedApp(service(), {
      postService: postService({ createPost }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          ...(testCase.attachmentIds ? { attachment_ids: testCase.attachmentIds } : {}),
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          ...(testCase.providerOptions
            ? {
                targets: [
                  {
                    platform_account_id: "00000000-0000-4000-8000-000000000401",
                    provider_options: testCase.providerOptions,
                  },
                ],
              }
            : {}),
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-invalid-composition",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  // An explicit empty targets array is the composer's channel-less draft
  // shape: it clears any saved Channel selection rather than violating the
  // schema, so it must round-trip to the service like an omitted member.
  it("accepts an explicit empty target array as a channel-less draft", async () => {
    const createPost = vi.fn(() => Effect.succeed({ replayed: false, value: post }));
    const app = authenticatedApp(service(), {
      postService: postService({ createPost }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Launch copy",
          targets: [],
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-empty-targets",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(post);
    expect(createPost).toHaveBeenCalledWith(
      env,
      session,
      {
        brandProfileId: brandProfileId,
        defaultText: "Launch copy",
        targets: [],
      },
      "post-empty-targets",
      expect.any(String),
    );
  });

  it("renders platform publishing issues in the error envelope details", async () => {
    const response = await authenticatedApp(service(), {
      postService: postService({
        schedulePost: () =>
          Effect.fail(
            new CoreApiError(
              422,
              "validation_error",
              "The post does not satisfy the platform publishing limits for this target.",
              undefined,
              [
                {
                  code: "provider_caption_limit",
                  field: "caption",
                  message: "caption exceeds the threads limit of 500 characters",
                },
              ],
            ),
          ),
      }),
    }).request(
      `/api/v1/posts/${postId}/schedule`,
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          scheduled_at: null,
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-caption-limit",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        details: [
          {
            code: "provider_caption_limit",
            field: "caption",
            message: "caption exceeds the threads limit of 500 characters",
          },
        ],
        retryable: false,
      },
    });
  });

  // A save is a patch-style edit of the same Post: the scope proof is the
  // owning Brand Profile, and omitted members keep their stored values.
  it("saves a draft without Channels and advances its revision", async () => {
    const saved = {
      ...post,
      default_text: "Hello world, updated",
      revision: 2,
    };
    const app = authenticatedApp(service(), {
      postService: postService({
        updatePost: () => Effect.succeed({ replayed: false, value: saved }),
      }),
    });
    const response = await app.request(
      `/api/v1/posts/${postId}`,
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          default_text: "Hello world, updated",
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-save-1",
        },
        method: "PATCH",
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(saved);
  });

  // Deletion is a scoped soft delete: the caller must name the owning Brand
  // Profile, so a workspace-wide aggregate selection cannot delete anything.
  it("requires the owning Brand Profile before deleting a Post", async () => {
    const deletePost = vi.fn(() => Effect.succeed({ replayed: false, value: post }));
    const app = authenticatedApp(service(), {
      postService: postService({ deletePost }),
    });
    for (const body of [
      {},
      { brand_profile_id: 42 },
      { brand_profile_id: brandProfileId, force: true },
    ]) {
      const response = await app.request(
        `/api/v1/posts/${postId}`,
        {
          body: JSON.stringify(body),
          headers: {
            ...bearerHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "post-delete-invalid",
          },
          method: "DELETE",
        },
        env,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "validation_error" },
      });
    }
    expect(deletePost).not.toHaveBeenCalled();
  });

  // Scheduling always states an instant: null publishes now and a timestamp
  // defers, but an omitted member can never fall back to an implicit default.
  it.each([
    {
      body: { brand_profile_id: brandProfileId },
      name: "an omitted scheduled_at",
    },
    {
      body: { brand_profile_id: brandProfileId, scheduled_at: "tomorrow" },
      name: "an unparsable scheduled_at",
    },
    {
      body: {
        brand_profile_id: brandProfileId,
        scheduled_at: null,
        title_override: "not allowed",
      },
      name: "an unknown schedule member",
    },
  ])("rejects $name before scheduling", async ({ body }) => {
    const schedulePost = vi.fn(() => Effect.die(new Error("unexpected call")));
    const app = authenticatedApp(service(), {
      postService: postService({ schedulePost }),
    });
    const response = await app.request(
      `/api/v1/posts/${postId}/schedule`,
      {
        body: JSON.stringify(body),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-schedule-invalid",
        },
        method: "POST",
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
    expect(schedulePost).not.toHaveBeenCalled();
  });

  // Reading one Post is a conditional read, so a client holding an unchanged
  // copy spends no bandwidth re-reading the same revision.
  it("returns a stable Post ETag and honors conditional reads", async () => {
    const getPost = vi.fn(() => Effect.succeed(post));
    const app = authenticatedApp(service(), {
      postService: postService({ getPost }),
    });
    const path = `/api/v1/posts/${postId}`;

    const initial = await app.request(
      path,
      { headers: { ...bearerHeaders, "X-Request-ID": "post-etag-initial" } },
      env,
    );
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Content-Type")).toContain("application/json");
    const etag = initial.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    await expect(initial.json()).resolves.toEqual(post);

    const unchanged = await app.request(
      path,
      {
        headers: {
          ...bearerHeaders,
          "If-None-Match": `W/${etag}`,
          "X-Request-ID": "post-etag-unchanged",
        },
      },
      env,
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("ETag")).toBe(etag);
    expect(await unchanged.text()).toBe("");
    expect(getPost).toHaveBeenCalledTimes(2);
  });

  it("returns a stable distribution ETag and honors conditional reads", async () => {
    const distribution = {
      brand_profile_id: brandProfileId,
      post_id: postId,
      attempt_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      description_override: null,
      failure: null,
      hashtags: ["launch"],
      id: "00000000-0000-4000-8000-000000000301",
      last_attempt_at: null,
      next_attempt_at: null,
      org_id: asset.org_id,
      platform: "tiktok" as const,
      platform_account_id: "00000000-0000-4000-8000-000000000201",
      platform_post_id: null,
      platform_url: null,
      publication: null,
      published_at: null,
      scheduled_at: null,
      status: "queued" as const,
      title_override: null,
      updated_at: "2026-01-01T00:00:00Z",
    };
    const getDistribution = vi.fn(() => Effect.succeed(distribution));
    const app = authenticatedApp(service({ getDistribution }));
    const path = `/api/v1/distributions/${distribution.id}`;

    const initial = await app.request(
      path,
      { headers: { ...bearerHeaders, "X-Request-ID": "etag-initial" } },
      env,
    );
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Content-Type")).toContain("application/json");
    const etag = initial.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    await expect(initial.json()).resolves.toEqual(distribution);

    for (const [index, validator] of [etag!, `W/${etag}`, `"other", ${etag}`, "*"].entries()) {
      const requestId = `etag-unchanged-${index}`;
      const unchanged = await app.request(
        path,
        {
          headers: {
            ...bearerHeaders,
            "If-None-Match": validator,
            "X-Request-ID": requestId,
          },
        },
        env,
      );
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("ETag")).toBe(etag);
      expect(unchanged.headers.get("X-Request-ID")).toBe(requestId);
      expect(await unchanged.text()).toBe("");
    }
    expect(getDistribution).toHaveBeenCalledTimes(5);
  });

  it("creates upload sessions and rejects unknown request fields", async () => {
    const uploadSession = {
      asset,
      upload_session: {
        asset_id: asset.id,
        content_type: "image/png",
        expires_at: "2026-07-19T00:00:00.000Z",
        file_size: 1024,
        id: "00000000-0000-4000-8000-000000000601",
        multipart: null,
        single_upload: {
          expires_at: "2026-07-18T00:15:00.000Z",
          headers: { "Content-Type": "image/png" },
          method: "PUT" as const,
          url: "https://assets.example/upload",
        },
        status: "created" as const,
        strategy: "single" as const,
      },
    };
    const createUploadSession = vi.fn(() =>
      Effect.succeed({
        replayed: false,
        value: uploadSession,
      }),
    );
    const app = authenticatedApp(service(), {
      assetService: assetService({ createUploadSession }),
    });
    const input = {
      asset_type: "image",
      brand_profile_id: brandProfileId,
      content_type: "image/png",
      file_size: 1024,
      filename: "launch.png",
      title: "Launch image",
    };
    const created = await app.request(
      "/api/v1/asset-upload-sessions",
      {
        body: JSON.stringify(input),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "upload-session-1",
          "X-Request-ID": "upload-session-request",
        },
        method: "POST",
      },
      env,
    );
    expect(created.status).toBe(201);
    expect(createUploadSession).toHaveBeenCalledWith(
      env,
      session,
      { ...input, description: undefined, tags: undefined },
      "upload-session-1",
      "upload-session-request",
    );

    const invalid = await app.request(
      "/api/v1/asset-upload-sessions",
      {
        body: JSON.stringify({ ...input, org_id: "attacker-org" }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "upload-session-2",
        },
        method: "POST",
      },
      env,
    );
    expect(invalid.status).toBe(400);
    expect(createUploadSession).toHaveBeenCalledOnce();
  });

  it("accepts an empty completion body without a Content-Length header", async () => {
    const completeUploadSession = vi.fn(() =>
      Effect.succeed({
        replayed: false,
        value: { ...asset, status: "processing" as const },
      }),
    );
    const app = authenticatedApp(service(), {
      assetService: assetService({ completeUploadSession }),
    });
    const sessionId = "00000000-0000-4000-8000-000000000601";
    const response = await app.request(
      `/api/v1/asset-upload-sessions/${sessionId}/complete`,
      {
        headers: {
          ...bearerHeaders,
          "Idempotency-Key": "complete-upload-1",
          "X-Request-ID": "complete-upload-request",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(202);
    expect(completeUploadSession).toHaveBeenCalledWith(
      env,
      session,
      sessionId,
      { parts: undefined },
      "complete-upload-1",
      "complete-upload-request",
    );
  });

  it("records matched route templates instead of raw resource IDs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const getAsset = vi.fn<AssetApiService["getAsset"]>().mockReturnValue(Effect.succeed(asset));
    const app = authenticatedApp(service(), {
      assetService: assetService({ getAsset }),
    });
    const requestedAssetId = "99999999-9999-4999-8999-999999999999";

    try {
      const response = await app.request(
        `/api/v1/assets/${requestedAssetId}`,
        { headers: bearerHeaders },
        env,
      );

      expect(response.status).toBe(200);
      expect(getAsset).toHaveBeenCalledWith(env, session, requestedAssetId);
      expect(logRecords(info)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: "http_request",
            route: "/api/v1/assets/:assetId",
          }),
        }),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("returns all five explicit unavailable capabilities", async () => {
    const response = await authenticatedApp(service()).request(
      "/api/v1/platforms/capabilities",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: [
        { connect_available: false, platform: "tiktok" },
        { connect_available: false, platform: "youtube" },
        { connect_available: false, platform: "instagram" },
        { connect_available: false, platform: "facebook" },
        { connect_available: false, platform: "threads" },
      ],
    });
  });

  it("returns normalized account-scoped publishing requirements", async () => {
    const publicationRequirements = vi.fn(() =>
      Effect.succeed({
        commentAllowed: true,
        creatorAvatarUrl: "https://cdn.example.test/avatar.jpg",
        creatorDisplayName: "Meltiply Creator",
        creatorUsername: "meltiply.creator",
        duetAllowed: false,
        maxVideoDurationSeconds: 180,
        platform: "tiktok" as const,
        privacyLevels: ["PUBLIC_TO_EVERYONE" as const, "SELF_ONLY" as const],
        stitchAllowed: true,
      }),
    );
    const providerRegistry = new ProviderRegistry();
    const accountId = "00000000-0000-4000-8000-000000000201";
    const response = await authenticatedApp(service(), {
      providerRegistry,
      publicationRequirements,
    }).request(
      `/api/v1/platforms/${accountId}/publishing-requirements`,
      {
        headers: {
          ...bearerHeaders,
          "X-Request-ID": "publication-requirements-request",
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comment_allowed: true,
      creator: {
        avatar_url: "https://cdn.example.test/avatar.jpg",
        display_name: "Meltiply Creator",
        username: "meltiply.creator",
      },
      duet_allowed: false,
      max_video_duration_sec: 180,
      platform: "tiktok",
      privacy_levels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      stitch_allowed: true,
    });
    expect(publicationRequirements).toHaveBeenCalledWith(
      env,
      session,
      accountId,
      "publication-requirements-request",
      providerRegistry,
    );
  });

  it("returns publication requirement rate limits as retryable", async () => {
    const response = await authenticatedApp(service(), {
      providerRegistry: new ProviderRegistry(),
      publicationRequirements: () =>
        Effect.fail(
          new CoreApiError(
            429,
            "provider_rate_limited",
            "The provider rate limit has been reached.",
            30,
          ),
        ),
    }).request(
      "/api/v1/platforms/00000000-0000-4000-8000-000000000201/publishing-requirements",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "provider_rate_limited", retryable: true },
    });
  });

  it("constructs the TikTok adapter only with live-acceptance bindings", async () => {
    const capabilities = unavailableCapabilities();
    capabilities[0] = {
      accepted_mime_types: [
        "image/jpeg",
        "image/webp",
        "video/mp4",
        "video/quicktime",
        "video/webm",
      ],
      analytics: false,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      max_caption_length: 2_200,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 30,
      max_media_count: 35,
      max_video_duration_sec: 600,
      min_media_count: 0,
      multi_asset_types: ["image"],
      notes: [],
      platform: "tiktok",
      publish: true,
      reply: false,
    };
    const create = vi.fn(async () => undefined);
    const app = authenticatedApp(service({ platformCapabilities: () => capabilities }), {
      brandProfileService: brandProfileService(),
    });
    const response = await app.request(
      `/api/v1/platforms/tiktok/connect`,
      { headers: bearerHeaders },
      {
        ...env,
        OAUTH_STATE: {
          getByName: () => ({ create, consume: vi.fn() }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
        TIKTOK_CLIENT_KEY: "tiktok-client",
        TIKTOK_CLIENT_SECRET: "tiktok-secret",
        TIKTOK_LIVE_ACCEPTED: "true",
        TIKTOK_MEDIA_URL_PREFIX: "https://account.r2.cloudflarestorage.com/assets/",
      },
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://www.tiktok.com");
    expect(location.searchParams.get("client_key")).toBe("tiktok-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/api/v1/platforms/tiktok/callback",
    );
    expect(location.searchParams.get("scope")).toBe(
      "user.info.basic,user.info.stats,video.publish,video.list",
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("constructs the Threads OAuth adapter only with live-acceptance bindings", async () => {
    const capabilities = unavailableCapabilities();
    capabilities[4] = {
      accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
      analytics: false,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      max_caption_length: 500,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 1,
      max_media_count: 20,
      max_video_duration_sec: 300,
      min_media_count: 0,
      multi_asset_types: ["image", "video"],
      notes: [],
      platform: "threads",
      publish: true,
      reply: false,
    };
    const create = vi.fn(async () => undefined);
    const app = authenticatedApp(service({ platformCapabilities: () => capabilities }), {
      brandProfileService: brandProfileService(),
    });
    const response = await app.request(
      `/api/v1/platforms/threads/connect`,
      { headers: bearerHeaders },
      {
        ...env,
        OAUTH_STATE: {
          getByName: () => ({ create, consume: vi.fn() }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
        THREADS_CLIENT_ID: "threads-client",
        THREADS_CLIENT_SECRET: "threads-secret",
        THREADS_LIVE_ACCEPTED: "true",
      },
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://threads.com");
    expect(location.searchParams.get("client_id")).toBe("threads-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/api/v1/platforms/threads/callback",
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("constructs the Facebook Page adapter only with live-acceptance bindings", async () => {
    const capabilities = unavailableCapabilities();
    capabilities[3] = {
      accepted_mime_types: ["video/mp4", "video/quicktime"],
      analytics: false,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      max_caption_length: 2_200,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 30,
      max_media_count: 1,
      max_video_duration_sec: 60,
      min_media_count: 1,
      multi_asset_types: [],
      notes: [],
      platform: "facebook",
      publish: true,
      reply: false,
    };
    const create = vi.fn(async () => undefined);
    const app = authenticatedApp(service({ platformCapabilities: () => capabilities }), {
      brandProfileService: brandProfileService(),
    });
    const response = await app.request(
      `/api/v1/platforms/facebook/connect`,
      { headers: bearerHeaders },
      {
        ...env,
        FACEBOOK_CLIENT_ID: "facebook-client",
        FACEBOOK_CLIENT_SECRET: "facebook-secret",
        FACEBOOK_LIVE_ACCEPTED: "true",
        OAUTH_STATE: {
          getByName: () => ({ create, consume: vi.fn() }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
      },
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://www.facebook.com");
    expect(location.searchParams.get("client_id")).toBe("facebook-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/api/v1/platforms/facebook/callback",
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("constructs the YouTube adapter only with live-acceptance bindings", async () => {
    const capabilities = unavailableCapabilities();
    capabilities[1] = {
      accepted_mime_types: ["video/mp4", "video/quicktime"],
      analytics: false,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      max_caption_length: 5_000,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 15,
      max_media_count: 1,
      max_video_duration_sec: 180,
      min_media_count: 1,
      multi_asset_types: [],
      notes: [],
      platform: "youtube",
      publish: true,
      reply: false,
    };
    const create = vi.fn(async () => undefined);
    const app = authenticatedApp(service({ platformCapabilities: () => capabilities }), {
      brandProfileService: brandProfileService(),
    });
    const response = await app.request(
      `/api/v1/platforms/youtube/connect`,
      { headers: bearerHeaders },
      {
        ...env,
        OAUTH_STATE: {
          getByName: () => ({ create, consume: vi.fn() }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
        YOUTUBE_LIVE_ACCEPTED: "true",
        YOUTUBE_SHORTS_CLIENT_ID: "youtube-client",
        YOUTUBE_SHORTS_CLIENT_SECRET: "youtube-secret",
      },
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("youtube-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/api/v1/platforms/youtube/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(create).toHaveBeenCalledOnce();
  });

  it("wraps platform accounts and never accepts a caller-supplied org", async () => {
    const listPlatformAccounts = vi.fn(() => Effect.succeed([]));
    const response = await authenticatedApp(service({ listPlatformAccounts })).request(
      "/api/v1/platforms?org_id=attacker-org",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accounts: [] });
    expect(listPlatformAccounts).toHaveBeenCalledWith(env, session, undefined);
  });

  it("rejects reversed and over-63-day calendar ranges before storage", async () => {
    const calendar = vi.fn(() => Effect.succeed([]));
    const app = authenticatedApp(service({ calendar }));
    const reversed = await app.request(
      "/api/v1/calendar?start=2026-02-01T00:00:00Z&end=2026-01-01T00:00:00Z",
      { headers: bearerHeaders },
      env,
    );
    expect(reversed.status).toBe(400);
    const excessive = await app.request(
      "/api/v1/calendar?start=2026-01-01T00:00:00Z&end=2026-04-01T00:00:00Z",
      { headers: bearerHeaders },
      env,
    );
    expect(excessive.status).toBe(400);
    expect(calendar).not.toHaveBeenCalled();
  });

  it("returns a wrapped, ordered calendar result from validated dates", async () => {
    const calendar = vi.fn(() =>
      Effect.succeed([
        {
          post_id: postId,
          post_title: "Launch",
          brand_profile_id: brandProfileId,
          id: "00000000-0000-4000-8000-000000000201",
          platform: "threads" as const,
          platform_account_id: null,
          published_at: null,
          scheduled_at: "2026-01-02T00:00:00.000Z",
          status: "scheduled" as const,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const response = await authenticatedApp(service({ calendar })).request(
      "/api/v1/calendar?start=2026-01-01T00:00:00Z&end=2026-01-31T23:59:59Z",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [{ platform_account_id: null, status: "scheduled" }],
    });
    expect(calendar).toHaveBeenCalledWith(
      env,
      session,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T23:59:59Z"),
      500,
      undefined,
    );
  });
  it("applies calendar limit defaults and maximum bounds before storage", async () => {
    const calendar = vi.fn(() => Effect.succeed([]));
    const app = authenticatedApp(service({ calendar }));
    const range = "start=2026-01-01T00:00:00Z&end=2026-01-31T23:59:59Z";

    const defaultLimit = await app.request(
      `/api/v1/calendar?${range}`,
      { headers: bearerHeaders },
      env,
    );
    expect(defaultLimit.status).toBe(200);
    expect(calendar).toHaveBeenLastCalledWith(
      env,
      session,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T23:59:59Z"),
      500,
      undefined,
    );

    const maximum = await app.request(
      `/api/v1/calendar?${range}&limit=1000`,
      { headers: bearerHeaders },
      env,
    );
    expect(maximum.status).toBe(200);
    expect(calendar).toHaveBeenLastCalledWith(
      env,
      session,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T23:59:59Z"),
      1_000,
      undefined,
    );

    const excessive = await app.request(
      `/api/v1/calendar?${range}&limit=1001`,
      { headers: bearerHeaders },
      env,
    );
    expect(excessive.status).toBe(400);
    expect(calendar).toHaveBeenCalledTimes(2);
  });

  it("validates analytics cohort bounds, metric, and pagination before storage", async () => {
    const analyticsPosts = vi.fn(() =>
      Effect.succeed({ has_more: false, limit: 10, offset: 0, posts: [] }),
    );
    const app = authenticatedApp(service({ analyticsPosts }));
    const range = "start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z";
    for (const query of [
      "start=2026-02-01T00:00:00Z&end=2026-01-01T00:00:00Z",
      "start=2025-01-01T00:00:00Z&end=2026-02-01T00:00:00Z",
      `${range}&metric=reach`,
      `${range}&limit=0`,
      `${range}&limit=101`,
      `${range}&offset=-1`,
    ]) {
      const response = await app.request(
        `/api/v1/analytics/posts?${query}`,
        { headers: bearerHeaders },
        env,
      );
      expect(response.status, query).toBe(400);
    }
    expect(analyticsPosts).not.toHaveBeenCalled();
  });

  it("forwards the analytics cohort, metric, pagination, and scope filters", async () => {
    const analyticsPosts = vi.fn(() =>
      Effect.succeed({
        has_more: true,
        limit: 25,
        offset: 50,
        posts: [],
      }),
    );
    const app = authenticatedApp(service({ analyticsPosts }));
    const response = await app.request(
      `/api/v1/analytics/posts?start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z&platform=threads&brand_profile_id=${brandProfileId}&metric=shares&limit=25&offset=50`,
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      has_more: true,
      limit: 25,
      offset: 50,
      posts: [],
    });
    expect(analyticsPosts).toHaveBeenCalledWith(env, session, {
      brandProfileId,
      end: new Date("2026-01-31T00:00:00Z"),
      limit: 25,
      metric: "shares",
      offset: 50,
      platform: "threads",
      start: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("defaults the analytics metric and pagination to views, ten, and zero", async () => {
    const analyticsPosts = vi.fn(() =>
      Effect.succeed({ has_more: false, limit: 10, offset: 0, posts: [] }),
    );
    const app = authenticatedApp(service({ analyticsPosts }));
    const response = await app.request(
      "/api/v1/analytics/posts?start=2026-01-01T00:00:00Z&end=2026-01-31T00:00:00Z",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    expect(analyticsPosts).toHaveBeenCalledWith(env, session, {
      end: new Date("2026-01-31T00:00:00Z"),
      limit: 10,
      metric: "views",
      offset: 0,
      start: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("rejects reversed and over-366-day distribution analytics ranges", async () => {
    const distributionAnalytics = vi.fn(() => Effect.succeed([]));
    const app = authenticatedApp(service({ distributionAnalytics }));
    const id = "00000000-0000-4000-8000-000000000201";
    const reversed = await app.request(
      `/api/v1/analytics/${id}?start=2026-02-01T00:00:00Z&end=2026-01-01T00:00:00Z`,
      { headers: bearerHeaders },
      env,
    );
    expect(reversed.status).toBe(400);
    const excessive = await app.request(
      `/api/v1/analytics/${id}?start=2025-01-01T00:00:00Z&end=2026-02-01T00:00:00Z`,
      { headers: bearerHeaders },
      env,
    );
    expect(excessive.status).toBe(400);
    expect(distributionAnalytics).not.toHaveBeenCalled();
  });

  it("validates inbox filters and forwards normalized pagination", async () => {
    const inbox = vi.fn(() =>
      Effect.succeed({
        comments: [],
        has_more: false,
        limit: 25,
        offset: 50,
      }),
    );
    const response = await authenticatedApp(service({ inbox })).request(
      "/api/v1/inbox?limit=25&offset=50&unreplied=true&platform=youtube&reply_status=failed",
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(200);
    expect(inbox).toHaveBeenCalledWith(env, session, {
      limit: 25,
      offset: 50,
      platform: "youtube",
      replyStatus: "failed",
      unreplied: true,
    });
  });

  it("requires idempotency and exposes replay for accepted replies", async () => {
    const comment = {
      author_avatar: null,
      author_name: "Viewer",
      body: "Great post",
      brand_profile_id: brandProfileId,
      commented_at: "2026-01-01T00:00:00.000Z",
      distribution_id: "00000000-0000-4000-8000-000000000201",
      failure: null,
      id: "00000000-0000-4000-8000-000000000301",
      platform: "youtube" as const,
      platform_comment_id: "provider-comment",
      post_id: postId,
      reply_status: "queued" as const,
      reply_text: "Thanks!",
      synced_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const replyToComment = vi.fn(() =>
      Effect.succeed({
        replayed: true,
        value: comment,
      }),
    );
    const app = authenticatedApp(service({ replyToComment }));
    const missingKey = await app.request(
      `/api/v1/inbox/${comment.id}/reply`,
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          text: "Thanks!",
        }),
        headers: { ...bearerHeaders, "Content-Type": "application/json" },
        method: "POST",
      },
      env,
    );
    expect(missingKey.status).toBe(400);

    const accepted = await app.request(
      `/api/v1/inbox/${comment.id}/reply`,
      {
        body: JSON.stringify({
          brand_profile_id: brandProfileId,
          text: "  Thanks!  ",
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "reply-1",
          "X-Request-ID": "reply-request",
        },
        method: "POST",
      },
      env,
    );
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replyToComment).toHaveBeenCalledWith(
      env,
      session,
      comment.id,
      brandProfileId,
      "Thanks!",
      "reply-1",
      "reply-request",
    );
  });

  it("keeps unaccepted OAuth providers explicitly unavailable", async () => {
    const response = await authenticatedApp(service()).request(
      `/api/v1/platforms/tiktok/connect`,
      { headers: bearerHeaders },
      env,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
  });

  it("starts OAuth without a Brand Profile and stages assignment later", async () => {
    const { registry } = oauthRegistry();
    const create = vi.fn(async (_state: string, _record: OAuthStateRecord) => undefined);
    const app = authenticatedApp(service({ platformCapabilities: () => registry.capabilities() }), {
      providerRegistry: registry,
    });
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ create, consume: vi.fn() }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const response = await app.request(
      "/api/v1/platforms/threads/connect",
      { headers: bearerHeaders },
      oauthEnv,
    );
    expect(response.status).toBe(307);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty("brand_profile_id");
  });

  it("lists the workspace brand profiles through the brand profile service", async () => {
    const listBrandProfiles = vi.fn(() => Effect.succeed([brandProfile]));
    const app = authenticatedApp(service(), {
      brandProfileService: {
        listBrandProfiles,
      } as unknown as BrandProfileApiService,
    });
    const response = await app.request("/api/v1/brand-profiles", { headers: bearerHeaders }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: [brandProfile],
    });
    expect(listBrandProfiles).toHaveBeenCalledWith(env, session);
  });

  /**
   * Proves the public create route accepts a short profile description and sends
   * it unchanged to the lifecycle service. This boundary test protects the
   * Channels board from losing its empty-state context before persistence.
   */
  it("creates a Brand Profile with its optional short description", async () => {
    const description = "Editorial tools for independent publishers.";
    const createBrandProfile = vi.fn(() =>
      Effect.succeed({
        replayed: false,
        value: { ...brandProfile, description },
      }),
    );
    const app = authenticatedApp(service(), {
      brandProfileService: brandProfileService({ createBrandProfile }),
    });

    const response = await app.request(
      "/api/v1/brand-profiles",
      {
        body: JSON.stringify({
          color: brandProfile.color,
          description,
          name: brandProfile.name,
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "brand-profile-description",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ...brandProfile,
      description,
    });
    expect(createBrandProfile).toHaveBeenCalledWith(
      env,
      session,
      { color: brandProfile.color, description, name: brandProfile.name },
      "brand-profile-description",
    );
  });

  it.each([
    {
      body: { color: "#ffffff", name: "Alpha Brand" },
      method: "POST",
      path: "/api/v1/brand-profiles",
    },
    {
      body: { name: " ".repeat(101) },
      method: "PATCH",
      path: `/api/v1/brand-profiles/${brandProfileId}`,
    },
  ])(
    "rejects invalid Brand Profile contract fields on $method $path",
    async ({ body, method, path }) => {
      const createBrandProfile = vi.fn(() =>
        Effect.succeed({ replayed: false, value: brandProfile }),
      );
      const updateBrandProfile = vi.fn(() =>
        Effect.succeed({ replayed: false, value: brandProfile }),
      );
      const app = authenticatedApp(service(), {
        brandProfileService: brandProfileService({
          createBrandProfile,
          updateBrandProfile,
        }),
      });

      const response = await app.request(
        path,
        {
          body: JSON.stringify(body),
          headers: {
            ...bearerHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "invalid-brand-profile",
          },
          method,
        },
        env,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "validation_error" },
      });
      expect(createBrandProfile).not.toHaveBeenCalled();
      expect(updateBrandProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      body: { default_text: "Launch copy", title: "Launch post" },
      method: "POST",
      path: "/api/v1/posts",
    },
    {
      body: {
        asset_type: "image",
        content_type: "image/png",
        file_size: 1024,
        filename: "launch.png",
        title: "Launch image",
      },
      method: "POST",
      path: "/api/v1/asset-upload-sessions",
    },
    {
      body: {
        content_type: "image/png",
        file_size: 1024,
        filename: "launch.png",
      },
      method: "POST",
      path: "/api/v1/asset-upload-sessions",
    },
    {
      body: { scheduled_at: null },
      method: "POST",
      path: `/api/v1/posts/${postId}/schedule`,
    },
    {
      body: {},
      method: "PATCH",
      path: `/api/v1/posts/${postId}`,
    },
    {
      body: { text: "Thanks!" },
      method: "POST",
      path: "/api/v1/inbox/00000000-0000-4000-8000-000000000301/reply",
    },
  ])("requires a Brand Profile selection on $path", async ({ body, method, path }) => {
    const app = authenticatedApp(service(), {
      assetService: assetService(),
      postService: postService(),
    });
    const response = await app.request(
      path,
      {
        body: JSON.stringify(body),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-brand-profile",
        },
        method,
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("propagates cross-profile rejection from the post service", async () => {
    const response = await authenticatedApp(service(), {
      postService: postService({
        schedulePost: () =>
          Effect.fail(
            new CoreApiError(
              422,
              "brand_profile_mismatch",
              "The platform account belongs to a different brand profile.",
            ),
          ),
      }),
    }).request(
      `/api/v1/posts/${postId}/schedule`,
      {
        body: JSON.stringify({
          brand_profile_id: "00000000-0000-4000-8000-000000000112",
          scheduled_at: null,
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "post-mismatch",
        },
        method: "POST",
      },
      env,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "brand_profile_mismatch" },
    });
  });

  it("starts accepted OAuth with PKCE and user/org-bound consume-once state", async () => {
    const { authorizationUrl, registry } = oauthRegistry();
    const create = vi.fn(
      async (
        _state: string,
        _record: {
          brand_profile_id: string;
          expires_at: number;
          organization_id: string;
          pkce_verifier?: string;
          provider: string;
          redirect_path: string;
          user_id: string;
        },
      ) => undefined,
    );
    const getByName = vi.fn(() => ({ create, consume: vi.fn() }));
    const oauthEnv = {
      ...env,
      OAUTH_STATE: {
        getByName,
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service({ platformCapabilities: () => registry.capabilities() }), {
      brandProfileService: brandProfileService(),
      providerRegistry: registry,
    });

    const response = await app.request(
      `/api/v1/platforms/threads/connect`,
      { headers: bearerHeaders },
      oauthEnv,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toMatch(/^https:\/\/provider\.example\/authorize\?/);
    expect(create).toHaveBeenCalledOnce();
    const [state, record] = create.mock.calls[0]!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(getByName).toHaveBeenCalledWith(state.split(".", 1)[0]);
    expect(record).toMatchObject({
      organization_id: actor.workspace.id,
      pkce_verifier: expect.any(String),
      provider: "threads",
      redirect_path: "/channels",
      user_id: actor.userId,
    });
    expect(record.expires_at).toBeGreaterThan(Date.now());
    expect(authorizationUrl).toHaveBeenCalledWith({
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      redirectUri: "http://localhost:8787/api/v1/platforms/threads/callback",
      state,
    });
  });

  it("returns the provider URL as JSON for authenticated browser clients", async () => {
    const { registry } = oauthRegistry();
    const app = authenticatedApp(service({ platformCapabilities: () => registry.capabilities() }), {
      brandProfileService: brandProfileService(),
      providerRegistry: registry,
    });
    const response = await app.request(
      `/api/v1/platforms/threads/connect`,
      { headers: { ...bearerHeaders, Accept: "application/json" } },
      {
        ...env,
        OAUTH_STATE: {
          getByName: () => ({ create: vi.fn(), consume: vi.fn() }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization_url: expect.stringMatching(/^https:\/\/provider\.example\/authorize\?/),
    });
  });

  it("stages a single-account OAuth exchange for explicit assignment", async () => {
    const { exchangeAuthorizationCode, registry } = oauthRegistry();
    const consume = vi.fn(async () => ({
      expires_at: Date.now() + 60_000,
      organization_id: actor.workspace.id,
      pkce_verifier: "pkce-verifier",
      provider: "threads",
      redirect_path: "/channels",
      user_id: actor.userId,
    }));
    const createSelection = vi.fn(
      async (_selectionId: string, _init: OAuthSelectionInit) => undefined,
    );
    const appendSelectionCandidates = vi.fn(
      async (_selectionId: string, _candidates: OAuthSelectionCandidate[]) => undefined,
    );
    const finalizeSelection = vi.fn(async (_selectionId: string) => undefined);
    const saveOAuthConnection = vi.fn(() => Effect.succeed(undefined));
    const oauthEnv = {
      ...env,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      OAUTH_STATE: {
        getByName: () => ({
          appendSelectionCandidates,
          consume,
          createSelection,
          finalizeSelection,
        }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), {
      providerRegistry: registry,
      saveOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/platforms/threads/callback?state=${"A".repeat(22)}.state-with-enough-length&code=provider-code`,
      undefined,
      oauthEnv,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain(
      "/channels/connect?oauth=select_account&provider=threads&selection_id=",
    );
    expect(consume).toHaveBeenCalledWith(`${"A".repeat(22)}.state-with-enough-length`);
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "completePlatformOAuth",
        requestId: expect.any(String),
      }),
      {
        code: "provider-code",
        codeVerifier: "pkce-verifier",
        redirectUri: "http://localhost:8787/api/v1/platforms/threads/callback",
      },
    );
    expect(saveOAuthConnection).not.toHaveBeenCalled();
    expect(createSelection).toHaveBeenCalledOnce();
    const [savedId, savedInit] = createSelection.mock.calls[0]!;
    expect(savedInit.platform).toBe("threads");
    expect(savedInit).not.toHaveProperty("brand_profile_id");
    expect(appendSelectionCandidates).toHaveBeenCalledOnce();
    const [appendedId, appendedCandidates] = appendSelectionCandidates.mock.calls[0]!;
    expect(appendedId).toBe(savedId);
    expect(appendedCandidates).toHaveLength(1);
    expect(appendedCandidates[0]!.account).toEqual({
      avatar_url: null,
      display_name: "Creator",
      id: "provider-user-1",
      username: null,
    });
    const sealedConnection = appendedCandidates[0]!.encryptedConnection;
    expect(sealedConnection).not.toContain("provider-access-token");
    expect(JSON.parse(await tokenCipherFor(oauthEnv).decrypt(sealedConnection))).toMatchObject({
      accessToken: "provider-access-token",
      account: { id: "provider-user-1" },
    });
    expect(finalizeSelection).toHaveBeenCalledWith(savedId);
  });

  it("redirects callback URL configuration failures to the frontend provider error", async () => {
    const { exchangeAuthorizationCode, registry } = oauthRegistry();
    const app = authenticatedApp(service(), { providerRegistry: registry });
    const response = await app.request(
      `/api/v1/platforms/threads/callback?state=${"A".repeat(22)}.state-with-enough-length&code=provider-code`,
      undefined,
      {
        ...env,
        PUBLIC_API_URL: undefined,
        OAUTH_STATE: {
          getByName: () => ({
            consume: async () => ({
              expires_at: Date.now() + 60_000,
              organization_id: actor.workspace.id,
              pkce_verifier: "pkce-verifier",
              provider: "threads",
              redirect_path: "/channels",
              user_id: actor.userId,
            }),
          }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3000/channels?oauth=provider_error&provider=threads",
    );
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("logs a safe diagnostic when an OAuth provider exchange fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { exchangeAuthorizationCode, registry } = oauthRegistry();
    // Mirror a hardened HTTP failure: a typed adapter error retaining the raw
    // transport cause plus credential-free request facts only.
    exchangeAuthorizationCode.mockRejectedValueOnce(
      new ProviderAdapterError(
        classifyProviderFailure({ code: "provider_unexpected", status: 503 }),
        {
          cause: new TypeError("fetch failed token=private-provider-value"),
          request: {
            method: "POST",
            origin: "https://provider.example",
            status_code: 503,
          },
        },
      ),
    );
    const consume = vi.fn(async () => ({
      expires_at: Date.now() + 60_000,
      organization_id: actor.workspace.id,
      pkce_verifier: "pkce-verifier",
      provider: "threads",
      redirect_path: "/channels",
      user_id: actor.userId,
    }));
    const app = authenticatedApp(service(), { providerRegistry: registry });
    const response = await app.request(
      `/api/v1/platforms/threads/callback?state=${"A".repeat(22)}.state-with-enough-length&code=provider-code`,
      {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "X-Request-ID": "request-oauth-callback-1",
        },
      },
      {
        ...env,
        OAUTH_STATE: {
          getByName: () => ({ consume }),
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3000/channels?oauth=provider_error&provider=threads",
    );
    expect(logRecords(warning)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          classification: "transient",
          code: "provider_unexpected",
          error_code: "provider_exchange_failed",
          event: "oauth_exchange_failed",
          outcome: "provider_error",
          provider: "threads",
          request: {
            method: "POST",
            origin: "https://provider.example",
            status_code: 503,
          },
          retry_class: "none",
        }),
        error: expect.objectContaining({
          cause: expect.objectContaining({
            message: expect.stringContaining("fetch failed"),
            name: "TypeError",
            stack: expect.any(String),
          }),
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          message: "The provider is temporarily unavailable.",
          name: "ProviderAdapterError",
          stack: expect.any(String),
        }),
        level: "warn",
        message: "threads OAuth exchange failed",
        request_id: "request-oauth-callback-1",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        user_id: actor.userId,
      }),
    );
    const records = logRecords(warning);
    const causeMessage = (
      records.find(
        (record) =>
          (record.context as { event?: unknown } | undefined)?.event === "oauth_exchange_failed",
      )?.error as { cause?: { message?: unknown } } | undefined
    )?.cause?.message;
    expect(causeMessage).not.toContain("private-provider-value");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-provider-value");
  });

  it.each([
    {
      code: "threads_profile_selection_required",
      expectedOutcome: "selection_required",
      failure: classifyProviderFailure({
        code: "threads_profile_selection_required",
        status: 409,
      }),
    },
    {
      code: "provider_auth",
      expectedOutcome: "provider_error",
      failure: classifyProviderFailure({ code: "provider_auth", status: 401 }),
    },
  ])(
    "logs the provider failure $code and redirects to oauth=$expectedOutcome",
    async ({ code, expectedOutcome, failure }) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { exchangeAuthorizationCode, registry } = oauthRegistry();
      exchangeAuthorizationCode.mockRejectedValueOnce(new ProviderAdapterError(failure));
      const app = authenticatedApp(service(), { providerRegistry: registry });
      const response = await app.request(
        `/api/v1/platforms/threads/callback?state=${"A".repeat(22)}.state-with-enough-length&code=provider-code`,
        undefined,
        {
          ...env,
          OAUTH_STATE: {
            getByName: () => ({
              consume: async () => ({
                expires_at: Date.now() + 60_000,
                organization_id: actor.workspace.id,
                pkce_verifier: "pkce-verifier",
                provider: "threads",
                redirect_path: "/channels",
                user_id: actor.userId,
              }),
            }),
          } as unknown as DurableObjectNamespace<OAuthStateStub>,
        },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        `http://localhost:3000/channels?oauth=${expectedOutcome}&provider=threads`,
      );
      expect(logRecords(warning)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            classification: failure.classification,
            code,
            error_code: "provider_exchange_failed",
            event: "oauth_exchange_failed",
            outcome: expectedOutcome,
          }),
        }),
      );
    },
  );

  it.each(["routing-key", "A".repeat(21), "A".repeat(23), `${"A".repeat(21)}!`])(
    "redirects malformed OAuth routing key %s without Durable Object access",
    async (routingKey) => {
      const { registry } = oauthRegistry();
      const getByName = vi.fn(() => ({ consume: vi.fn() }));
      const app = authenticatedApp(service(), {
        providerRegistry: registry,
      });
      const response = await app.request(
        `/api/v1/platforms/threads/callback?state=${routingKey}.state-with-enough-length&code=provider-code`,
        undefined,
        {
          ...env,
          OAUTH_STATE: {
            getByName,
          } as unknown as DurableObjectNamespace<OAuthStateStub>,
        },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "http://localhost:3000/channels?oauth=state_invalid&provider=threads",
      );
      expect(getByName).not.toHaveBeenCalled();
    },
  );
  it("rejects short OAuth state with 400 invalid_request without Durable Object access", async () => {
    const { registry } = oauthRegistry();
    const getByName = vi.fn(() => ({ consume: vi.fn() }));
    const app = authenticatedApp(service(), {
      providerRegistry: registry,
    });
    const response = await app.request(
      "/api/v1/platforms/threads/callback?state=short-state&code=provider-code",
      undefined,
      {
        ...env,
        OAUTH_STATE: {
          getByName,
        } as unknown as DurableObjectNamespace<OAuthStateStub>,
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("invalidates a local connection even when remote revocation fails", async () => {
    const accountId = "00000000-0000-4000-8000-000000000401";
    const revokeOAuthConnection = vi.fn(() => Effect.fail(new Error("provider unavailable")));
    const disconnectPlatform = vi.fn(() =>
      Effect.succeed({
        replayed: false,
        value: undefined,
      }),
    );
    const app = authenticatedApp(service({ disconnectPlatform }), {
      revokeOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/platforms/${accountId}`,
      {
        headers: {
          ...bearerHeaders,
          "Idempotency-Key": "disconnect-with-revoke-failure",
        },
        method: "DELETE",
      },
      env,
    );

    expect(response.status).toBe(204);
    expect(revokeOAuthConnection).toHaveBeenCalledWith(
      env,
      session,
      accountId,
      expect.any(ProviderRegistry),
    );
    expect(disconnectPlatform).toHaveBeenCalledWith(
      env,
      session,
      accountId,
      "disconnect-with-revoke-failure",
    );
  });
  it("rejects oversized mutation JSON with a non-retryable payload error", async () => {
    const createPost = vi.fn(() => Effect.die(new Error("unexpected call")));
    const app = authenticatedApp(service(), {
      postService: postService({ createPost }),
    });
    const response = await app.request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          default_text: "x".repeat(512 * 1024),
          title: "Launch post",
        }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "oversized-json",
        },
        method: "POST",
      },
      env,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "payload_too_large",
        retryable: false,
      },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("returns 503 service_unavailable when storage is unavailable during abortUploadSession", async () => {
    const app = authenticatedApp(service(), {
      assetService: {
        ...assetService(),
        abortUploadSession: () =>
          Effect.fail(new StorageUnavailable("media bucket is not configured")),
      },
    });
    const sessionId = "00000000-0000-4000-8000-000000000601";
    const response = await app.request(
      `/api/v1/asset-upload-sessions/${sessionId}`,
      {
        headers: {
          ...bearerHeaders,
          "Idempotency-Key": "abort-upload-storage-unavailable",
        },
        method: "DELETE",
      },
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "service_unavailable",
        message: "media bucket is not configured",
      },
    });
  });
});

describe("OAuth Page selection flow", () => {
  /**
   * Candidate exchange must persist sealed, owner-bound choices without saving a channel.
   * Fixture callbacks isolate Graph and storage while real encryption protects each Page token.
   */
  it("OAuth callback with candidate Pages creates selection, never connects Facebook, and redirects to select_account", async () => {
    const exchangeAuthorizationCode = vi.fn(async (): Promise<OAuthAccountSelection> => ({
      accounts: [
        {
          accessToken: "fb-page-1-token",
          account: {
            avatarUrl: "https://example.com/p1.png",
            displayName: "Facebook Page 1",
            id: "fb-page-1",
            username: "fbpage1",
          },
          scopes: ["pages_show_list"],
        },
        {
          accessToken: "fb-page-2-token",
          account: {
            avatarUrl: undefined,
            displayName: "Facebook Page 2",
            id: "fb-page-2",
            username: undefined,
          },
          scopes: ["pages_show_list"],
        },
      ],
    }));
    const registry = new ProviderRegistry();
    registry.register("facebook", {
      authorizationUrl: () => "https://www.facebook.com/dialog/oauth",
      capability: {
        accepted_mime_types: ["text/plain"],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: true,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: null,
        max_media_count: 20,
        max_video_duration_sec: null,
        min_media_count: 0,
        multi_asset_types: ["image"],
        notes: [],
        platform: "facebook",
        publish: false,
        reply: false,
      },
      exchangeAuthorizationCode,
      transferModes: [],
    });
    const consume = vi.fn(async () => ({
      expires_at: Date.now() + 60_000,
      organization_id: actor.workspace.id,
      pkce_verifier: "pkce-verifier-fb",
      provider: "facebook",
      redirect_path: "/channels",
      user_id: actor.userId,
    }));
    const createSelection = vi.fn(
      async (_selectionId: string, _init: OAuthSelectionInit) => undefined,
    );
    const appendSelectionCandidates = vi.fn(
      async (_selectionId: string, _candidates: OAuthSelectionCandidate[]) => undefined,
    );
    const finalizeSelection = vi.fn(async (_selectionId: string) => undefined);
    const saveOAuthConnection = vi.fn(() => Effect.succeed(undefined));
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      OAUTH_STATE: {
        getByName: () => ({
          appendSelectionCandidates,
          consume,
          createSelection,
          finalizeSelection,
        }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), {
      providerRegistry: registry,
      saveOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/platforms/facebook/callback?state=${routingKey}.${"B".repeat(32)}&code=fb-code-123`,
      undefined,
      oauthEnv,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toContain(
      "/channels/connect?oauth=select_account&provider=facebook&selection_id=",
    );
    expect(saveOAuthConnection).not.toHaveBeenCalled();
    expect(createSelection).toHaveBeenCalledTimes(1);
    const [savedId, savedInit] = createSelection.mock.calls[0]!;
    expect(savedId).toMatch(new RegExp(`^${routingKey}\\.`));
    expect(savedInit.platform).toBe("facebook");
    expect(savedInit).not.toHaveProperty("brand_profile_id");
    expect(appendSelectionCandidates).toHaveBeenCalledTimes(1);
    const [appendedId, appendedCandidates] = appendSelectionCandidates.mock.calls[0]!;
    expect(appendedId).toBe(savedId);
    expect(appendedCandidates).toHaveLength(2);
    expect(appendedCandidates[0]!.account).toEqual({
      avatar_url: "https://example.com/p1.png",
      display_name: "Facebook Page 1",
      id: "fb-page-1",
      username: "fbpage1",
    });
    const sealedConnection = appendedCandidates[0]!.encryptedConnection;
    expect(sealedConnection).not.toContain("fb-page-1-token");
    expect(JSON.parse(await tokenCipherFor(oauthEnv).decrypt(sealedConnection))).toMatchObject({
      accessToken: "fb-page-1-token",
      account: { id: "fb-page-1" },
    });
    expect(finalizeSelection).toHaveBeenCalledWith(savedId);
  });

  it("GET /api/v1/oauth-selections/:selectionId returns 200 with sanitized metadata without leaking credentials", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const getSelection = vi.fn(async () => ({
      accounts: [
        {
          avatar_url: "https://example.com/p1.png",
          display_name: "Facebook Page 1",
          id: "fb-page-1",
          username: "fbpage1",
        },
      ],
      expires_at: "2026-10-12T12:00:00.000Z",
      id: selectionId,
      platform: "facebook",
    }));
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ getSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service());

    const response = await app.request(
      `/api/v1/oauth-selections/${selectionId}`,
      { headers: bearerHeaders },
      oauthEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      accounts: [
        {
          avatar_url: "https://example.com/p1.png",
          display_name: "Facebook Page 1",
          id: "fb-page-1",
          username: "fbpage1",
        },
      ],
      expires_at: "2026-10-12T12:00:00.000Z",
      id: selectionId,
      platform: "facebook",
    });
    const publicBody = body as Record<string, unknown>;
    expect(publicBody.encrypted_connections).toBeUndefined();
  });

  it("GET /api/v1/oauth-selections/:selectionId returns 404 for wrong, foreign, or expired tickets", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const foreignKey = "foreignroutingkey";
    const getSelection = vi.fn(async () => null);
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ getSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service());

    const foreignRes = await app.request(
      `/api/v1/oauth-selections/${foreignKey}.validnonce1234567890`,
      { headers: bearerHeaders },
      oauthEnv,
    );
    expect(foreignRes.status).toBe(404);

    const missingRes = await app.request(
      `/api/v1/oauth-selections/${routingKey}.nonexistentnonce12345`,
      { headers: bearerHeaders },
      oauthEnv,
    );
    expect(missingRes.status).toBe(404);
  });

  it("POST /api/v1/oauth-selections/:selectionId/confirm connects chosen Page only and saves connection", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const cipher = tokenCipherFor({
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    } as ApiWorkerEnv);
    const pageConnection = {
      accessToken: "fb-page-1-token",
      account: {
        avatarUrl: "https://example.com/p1.png",
        displayName: "Facebook Page 1",
        id: "fb-page-1",
        username: "fbpage1",
      },
      scopes: ["pages_show_list"],
    };
    const sealed = await cipher.encrypt(JSON.stringify(pageConnection));
    const claimSelection = vi.fn(async () => ({
      claimToken: "claim-token-123",
      encryptedConnection: sealed,
      organizationId: actor.workspace.id,
      platform: "facebook",
      status: "claimed" as const,
      userId: actor.userId,
    }));
    const completeSelection = vi.fn(async () => true);
    const saveOAuthConnection = vi.fn(() => Effect.succeed(undefined));
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      OAUTH_STATE: {
        getByName: () => ({ claimSelection, completeSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), {
      brandProfileService: brandProfileService(),
      saveOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      {
        body: JSON.stringify({ account_id: "fb-page-1", brand_profile_id: brandProfileId }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "confirm-key-1",
        },
        method: "POST",
      },
      oauthEnv,
    );

    expect(response.status).toBe(204);
    expect(saveOAuthConnection).toHaveBeenCalledTimes(1);
    expect(saveOAuthConnection).toHaveBeenCalledWith(
      oauthEnv,
      "facebook",
      {
        brandProfileId,
        organizationId: actor.workspace.id,
        userId: actor.userId,
      },
      pageConnection,
    );
    expect(completeSelection).toHaveBeenCalledWith(
      selectionId,
      "fb-page-1",
      "claim-token-123",
      "confirm-key-1",
    );
  });

  it("POST /api/v1/oauth-selections/:selectionId/confirm replays 204 on identical idempotency key and account without re-saving", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const claimSelection = vi.fn(async () => ({
      status: "replayed" as const,
    }));
    const saveOAuthConnection = vi.fn(() => Effect.succeed(undefined));
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ claimSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), {
      brandProfileService: brandProfileService(),
      saveOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      {
        body: JSON.stringify({ account_id: "fb-page-1", brand_profile_id: brandProfileId }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "confirm-key-replay",
        },
        method: "POST",
      },
      oauthEnv,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(saveOAuthConnection).not.toHaveBeenCalled();
  });

  it("POST /api/v1/oauth-selections/:selectionId/confirm preserves real 403 quota_exceeded and releases claim for retry", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const cipher = tokenCipherFor({
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    } as ApiWorkerEnv);
    const pageConnection = {
      accessToken: "fb-page-1-token",
      account: { id: "fb-page-1", displayName: "Page 1" },
      scopes: [],
    };
    const sealed = await cipher.encrypt(JSON.stringify(pageConnection));
    const claimSelection = vi.fn(async () => ({
      claimToken: "claim-token-quota",
      encryptedConnection: sealed,
      organizationId: actor.workspace.id,
      platform: "facebook",
      status: "claimed" as const,
      userId: actor.userId,
    }));
    const releaseSelectionClaim = vi.fn(async () => true);
    const quotaError = new CoreApiError(
      403,
      "quota_exceeded",
      "The platform connection limit is reached (2/2). Disconnect an account or upgrade the verified plan.",
    );
    const saveOAuthConnection = vi.fn(() => Effect.fail(quotaError));
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      OAUTH_STATE: {
        getByName: () => ({ claimSelection, releaseSelectionClaim }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), {
      brandProfileService: brandProfileService(),
      saveOAuthConnection,
    });

    const response = await app.request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      {
        body: JSON.stringify({ account_id: "fb-page-1", brand_profile_id: brandProfileId }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "confirm-key-quota",
        },
        method: "POST",
      },
      oauthEnv,
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "quota_exceeded",
        message: expect.stringContaining("connection limit is reached"),
      },
    });
    expect(releaseSelectionClaim).toHaveBeenCalledWith(selectionId, "claim-token-quota");
  });

  it("POST /api/v1/oauth-selections/:selectionId/confirm rejects concurrent active claim and account-switch with 409", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const claimSelection = vi
      .fn()
      .mockResolvedValueOnce({
        code: "claim_active",
        message: "Selection confirmation is currently in progress.",
        status: "conflict" as const,
      })
      .mockResolvedValueOnce({
        code: "pinned_account_mismatch",
        message:
          "This selection was already confirmed for a different account. Restart authorization to choose another account.",
        status: "conflict" as const,
      });
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ claimSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), { brandProfileService: brandProfileService() });

    const activeRes = await app.request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      {
        body: JSON.stringify({ account_id: "fb-page-1", brand_profile_id: brandProfileId }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "concurrent-key",
        },
        method: "POST",
      },
      oauthEnv,
    );
    expect(activeRes.status).toBe(409);

    const switchRes = await app.request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      {
        body: JSON.stringify({ account_id: "fb-page-2", brand_profile_id: brandProfileId }),
        headers: {
          ...bearerHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "switch-key",
        },
        method: "POST",
      },
      oauthEnv,
    );
    expect(switchRes.status).toBe(409);
  });

  it("DELETE /api/v1/oauth-selections/:selectionId cancels selection and rejects active claims with 409", async () => {
    const routingKey = await oauthStateRoutingKey(actor.workspace.id);
    const selectionId = `${routingKey}.validnonce1234567890`;
    const cancelSelection = vi
      .fn()
      .mockResolvedValueOnce({ status: "cancelled" as const })
      .mockResolvedValueOnce({
        message: "Cannot cancel selection while confirmation is in progress.",
        status: "conflict" as const,
      });
    const saveOAuthConnection = vi.fn(() => Effect.succeed(undefined));
    const oauthEnv: ApiWorkerEnv = {
      ...env,
      OAUTH_STATE: {
        getByName: () => ({ cancelSelection }),
      } as unknown as DurableObjectNamespace<OAuthStateStub>,
    };
    const app = authenticatedApp(service(), { saveOAuthConnection });

    const cancelRes = await app.request(
      `/api/v1/oauth-selections/${selectionId}`,
      {
        headers: {
          ...bearerHeaders,
          "Idempotency-Key": "cancel-key-1",
        },
        method: "DELETE",
      },
      oauthEnv,
    );
    expect(cancelRes.status).toBe(204);
    expect(saveOAuthConnection).not.toHaveBeenCalled();

    const busyRes = await app.request(
      `/api/v1/oauth-selections/${selectionId}`,
      {
        headers: {
          ...bearerHeaders,
          "Idempotency-Key": "cancel-key-2",
        },
        method: "DELETE",
      },
      oauthEnv,
    );
    expect(busyRes.status).toBe(409);
  });
});

// The distribution service runs `validatePublishInput` before it persists the
// distribution or emits the outbox event, so a provider-option/platform mismatch
// rejected here can never reach scheduling.
describe("provider publish option platform validation", () => {
  /**
   * Builds a publish-enabled video capability for one platform-specific validation case.
   * The platform input is the only variable; fixed limits isolate option compatibility.
   */
  function capability(platform: string): PlatformCapability {
    return {
      accepted_mime_types: ["video/mp4"],
      analytics: false,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      max_caption_length: null,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: null,
      notes: [],
      platform: platform as PlatformCapability["platform"],
      publish: true,
      reply: false,
    };
  }

  const publishInput = {
    caption: "launch day",
    hashtags: [],
    idempotencyKey: "publish-1",
    media: [
      {
        contentType: "video/mp4",
        fileSize: 500,
        mode: "remote_ingest" as const,
        url: "https://cdn.example.com/clip.mp4",
      },
    ],
  };

  it("accepts YouTube publish options on a YouTube capability", () => {
    expect(
      validatePublishInput(capability("youtube"), {
        ...publishInput,
        providerOptions: {
          youtube: { madeForKids: true, privacyStatus: "private" },
        },
      }),
    ).toEqual([]);
  });

  it("rejects YouTube publish options on a non-YouTube capability", () => {
    expect(
      validatePublishInput(capability("threads"), {
        ...publishInput,
        providerOptions: { youtube: { madeForKids: false } },
      }),
    ).toEqual([
      expect.objectContaining({
        constraint: "unsupported_provider_options",
        field: "providerOptions.youtube",
      }),
    ]);
  });

  it("rejects TikTok publish options on a non-TikTok capability", () => {
    expect(
      validatePublishInput(capability("youtube"), {
        ...publishInput,
        providerOptions: {
          tiktok: {
            allowComment: true,
            allowDuet: false,
            allowStitch: false,
            brandContent: false,
            brandOrganic: false,
            isAiGenerated: false,
            musicUsageConfirmed: true,
            privacyLevel: "PUBLIC_TO_EVERYONE",
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        constraint: "unsupported_provider_options",
        field: "providerOptions.tiktok",
      }),
    ]);
  });
});

describe("provider media delivery route", () => {
  const mediaSecret = "provider-media-test-key";
  const mediaKey = "org-1/asset-1/video.mp4";

  /**
   * Signs a provider-media URL exactly as the Automation Worker resolver does:
   * HMAC-SHA256 over the canonical v1 payload keyed by TOKEN_ENCRYPTION_KEY, with the
   * percent-encoded object key in the path and expiry/signature in the query.
   */
  async function signedMediaUrl(
    key: string,
    expiresAt: number,
    secret = mediaSecret,
  ): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(`meltiply-provider-media-v1\n${expiresAt}\n${key}`),
    );
    let binary = "";
    for (const byte of new Uint8Array(digest)) {
      binary += String.fromCharCode(byte);
    }
    const signature = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `/api/v1/provider-media/${path}?expires=${expiresAt}&signature=${signature}`;
  }

  /**
   * Builds a test environment whose private ASSETS bucket delegates to the given
   * `get` spy so tests can observe whether a request reached storage.
   */
  function providerMediaEnv(get: (key: string) => Promise<unknown>): ApiWorkerEnv {
    return {
      ...env,
      ASSETS: { get } as unknown as R2Bucket,
      TOKEN_ENCRYPTION_KEY: mediaSecret,
    };
  }

  it("streams a validly signed private R2 object without user authentication", async () => {
    const get = vi.fn(async () => ({
      body: new Blob(["video-bytes"]).stream(),
      httpMetadata: { contentType: "video/mp4" },
      size: 11,
    }));
    const app = createApiApp();
    const url = await signedMediaUrl(mediaKey, Math.floor(Date.now() / 1000) + 3600);
    const response = await app.request(url, {}, providerMediaEnv(get));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(await response.text()).toBe("video-bytes");
    expect(get).toHaveBeenCalledWith(mediaKey);
  });

  it("streams a signed canonical UUID storage key", async () => {
    const get = vi.fn(async () => ({
      body: new Blob(["video-bytes"]).stream(),
      httpMetadata: { contentType: "video/mp4" },
      size: 11,
    }));
    const app = createApiApp();
    // Canonical storage keys are `<org-uuid>/<asset-uuid>/<file>`; hyphenated UUID
    // segments must survive key-shape validation.
    const uuidKey =
      "3f6c9d2e-7a4b-4c1e-9f2a-5d8b0e1c2a3f/8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/video.mp4";
    const url = await signedMediaUrl(uuidKey, Math.floor(Date.now() / 1000) + 3600);
    const response = await app.request(url, {}, providerMediaEnv(get));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video-bytes");
    expect(get).toHaveBeenCalledWith(uuidKey);
  });

  it("rejects tampered, expired, and unsigned URLs before any R2 access", async () => {
    const get = vi.fn(async () => null);
    const app = createApiApp();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const tampered = await signedMediaUrl(mediaKey, future, "other-secret");
    const expired = await signedMediaUrl(mediaKey, Math.floor(Date.now() / 1000) - 60);
    const unsigned = `/api/v1/provider-media/${mediaKey}?expires=${future}`;
    for (const url of [tampered, expired, unsigned]) {
      const response = await app.request(url, {}, providerMediaEnv(get));
      expect(response.status).toBe(403);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects correctly signed URLs whose keys violate the asset key shape", async () => {
    const get = vi.fn(async () => null);
    const app = createApiApp();
    const future = Math.floor(Date.now() / 1000) + 3600;
    // Each signature is computed over the decoded key, so these URLs would verify;
    // rejection must come from key-shape validation before any R2 access. For the
    // encoded-slash and encoded-dot cases the path keeps the encoded segment while
    // the signature covers the decoded key — a literal `/` or `..` segment would be
    // normalized away by URL parsing before the route ever saw it.
    const encodedSlash = (await signedMediaUrl("org-1/asset-1/a/b", future)).replace(
      "/a/b?",
      "/a%2Fb?",
    );
    const encodedDots = (await signedMediaUrl("org-1/asset-1/../secret", future)).replace(
      "/../",
      "/%2E%2E/",
    );
    const malformed = [
      await signedMediaUrl("org-1/asset-1/a\\b", future),
      await signedMediaUrl("org-1/asset-1/a\0b", future),
      encodedSlash,
      encodedDots,
    ];
    for (const url of malformed) {
      const response = await app.request(url, {}, providerMediaEnv(get));
      expect(response.status).toBe(403);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("returns 404 when the signed object key is absent from the bucket", async () => {
    const get = vi.fn(async () => null);
    const app = createApiApp();
    const url = await signedMediaUrl(mediaKey, Math.floor(Date.now() / 1000) + 3600);
    const response = await app.request(url, {}, providerMediaEnv(get));
    expect(response.status).toBe(404);
    expect(get).toHaveBeenCalledWith(mediaKey);
  });

  /**
   * Delivery must follow the configured provider, not the R2 binding: an S3
   * deployment relays the same bearer-authorized object from its own origin,
   * and a deployment whose provider cannot be constructed still fails closed
   * with 503 rather than serving bytes from an unintended store.
   */
  it("relays the same signed object from an S3-compatible origin", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("video-bytes", {
          headers: { "content-length": "11", "content-type": "video/mp4" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const app = createApiApp();
      const url = await signedMediaUrl(mediaKey, Math.floor(Date.now() / 1000) + 3600);
      const response = await app.request(
        url,
        {},
        {
          ...env,
          ASSETS: undefined,
          OBJECT_STORAGE_PROVIDER: "s3",
          S3_ACCESS_KEY_ID: "s3-access-key",
          S3_BUCKET: "meltiply-assets",
          S3_ENDPOINT: "https://objects.example.test",
          S3_SECRET_ACCESS_KEY: "s3-secret",
          TOKEN_ENCRYPTION_KEY: mediaSecret,
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("video/mp4");
      expect(await response.text()).toBe("video-bytes");
      expect(fetchMock).toHaveBeenCalledWith(
        `https://objects.example.test/meltiply-assets/${mediaKey}`,
        expect.objectContaining({ method: "GET" }),
      );

      const unavailable = createApiApp();
      const response503 = await unavailable.request(
        url,
        {},
        {
          ...env,
          ASSETS: undefined,
          OBJECT_STORAGE_PROVIDER: "s3",
          S3_BUCKET: "meltiply-assets",
          TOKEN_ENCRYPTION_KEY: mediaSecret,
        },
      );
      expect(response503.status).toBe(503);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
