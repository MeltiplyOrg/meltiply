import { describe, expect, it } from "vite-plus/test";
import {
  cachedProviderRegistryFromEnvironment,
  classifyProviderFailure,
  createProviderRegistryFromEnvironment,
  normalizeProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  validatePublishInput,
} from "../src";
import type { ProviderAdapter } from "../src/types";

describe("ProviderRegistry", () => {
  it("attaches adapter metadata to operation results and clears stale context", async () => {
    const adapter: ProviderAdapter = {
      capability: {
        platform: "threads",
        connect_available: false,
        asset_types: [],
        publish: true,
        analytics: false,
        comments: false,
        reply: false,
        max_caption_length: 500,
        max_hashtags: 30,
        max_file_size: null,
        max_media_count: null,
        max_video_duration_sec: null,
        min_media_count: 0,
        multi_asset_types: [],
        accepted_mime_types: [],
        notes: [],
      },
      extractRateLimitBudget: () => null,
      lookupPublication: async () => ({ state: "not_found" }),
      publish: async (context) => {
        context.metadata = {
          rateLimitBudget: {
            percentUsed: 80,
            remaining: 4,
            resetsInSeconds: 30,
          },
        };
        return { outcome: "confirmed_success" };
      },
      retryPolicy: {
        baseDelaySeconds: 1,
        maxAttempts: 3,
        maxDelaySeconds: 60,
      },
      transferModes: [],
    };
    const registry = new ProviderRegistry();
    registry.register("threads", adapter);
    const registered = registry.get("threads")!;
    const context = { operationId: "operation-1", requestId: "request-1" };

    await expect(
      registered.publish!(context, { accessToken: "token" }, {} as never),
    ).resolves.toMatchObject({
      metadata: {
        rateLimitBudget: { percentUsed: 80, remaining: 4, resetsInSeconds: 30 },
      },
      outcome: "confirmed_success",
    });

    adapter.publish = async () => ({ outcome: "confirmed_success" });
    await expect(
      registered.publish!(context, { accessToken: "token" }, {} as never),
    ).resolves.toEqual({ outcome: "confirmed_success" });
  });

  it("reuses an immutable environment registry and invalidates mutations", () => {
    const environment = {
      PUBLIC_API_URL: "https://api.example.com",
      THREADS_CLIENT_ID: "threads-client",
      THREADS_CLIENT_SECRET: "threads-secret",
      THREADS_LIVE_ACCEPTED: "true",
    };
    const first = cachedProviderRegistryFromEnvironment(environment);
    expect(cachedProviderRegistryFromEnvironment(environment)).toBe(first);

    environment.THREADS_LIVE_ACCEPTED = "false";
    const invalidated = cachedProviderRegistryFromEnvironment(environment);
    expect(invalidated).not.toBe(first);
    expect(invalidated.get("threads")).toBeUndefined();
  });

  it("fails closed for every unconfigured provider", () => {
    const capabilities = new ProviderRegistry().capabilities();
    expect(capabilities).toHaveLength(5);
    expect(capabilities.every((capability) => !capability.connect_available)).toBe(true);
    expect(capabilities.every((capability) => !capability.publish)).toBe(true);
  });

  it("keeps declared analytics support for stored snapshots while providers are unconfigured", () => {
    const capabilities = new ProviderRegistry().capabilities();
    expect(capabilities.every((capability) => capability.analytics)).toBe(true);
  });

  it("checks the declared caption boundary before a provider is activated", () => {
    const threads = new ProviderRegistry()
      .capabilities()
      .find(({ platform }) => platform === "threads")!;
    const input = {
      caption: "🚀".repeat(500),
      hashtags: [],
      idempotencyKey: "draft-caption",
      media: [],
    };
    expect(validatePublishInput(threads, input)).toEqual([]);
    expect(validatePublishInput(threads, { ...input, caption: input.caption + "🚀" })).toEqual([
      expect.objectContaining({
        actual: 501,
        constraint: "provider_caption_limit",
        field: "caption",
        limit: 500,
      }),
    ]);
  });

  it("keeps runtime providers closed until live acceptance is explicit", () => {
    const environment = {
      PUBLIC_API_URL: "https://api.example.com",
      THREADS_CLIENT_ID: "threads-client",
      THREADS_CLIENT_SECRET: "threads-secret",
    };
    for (const THREADS_LIVE_ACCEPTED of [undefined, "", "false"]) {
      const registry = createProviderRegistryFromEnvironment({
        ...environment,
        ...(THREADS_LIVE_ACCEPTED === undefined ? {} : { THREADS_LIVE_ACCEPTED }),
      });
      expect(registry.get("threads")).toBeUndefined();
      expect(registry.capabilities().find(({ platform }) => platform === "threads")).toMatchObject({
        connect_available: false,
        publish: false,
      });
    }
  });

  it("requires complete accepted configuration and pins the Threads callback", () => {
    expect(() => createProviderRegistryFromEnvironment({ THREADS_LIVE_ACCEPTED: "yes" })).toThrow(
      "must be true or false",
    );
    expect(() => createProviderRegistryFromEnvironment({ THREADS_LIVE_ACCEPTED: "true" })).toThrow(
      "configuration is incomplete",
    );
    expect(() =>
      createProviderRegistryFromEnvironment({
        PUBLIC_API_URL: "https://user:password@api.example.com",
        THREADS_CLIENT_ID: "threads-client",
        THREADS_CLIENT_SECRET: "threads-secret",
        THREADS_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("PUBLIC_API_URL");

    const registry = createProviderRegistryFromEnvironment({
      PUBLIC_API_URL: "https://api.example.com/base",
      THREADS_CLIENT_ID: "threads-client",
      THREADS_CLIENT_SECRET: "threads-secret",
      THREADS_LIVE_ACCEPTED: "true",
    });
    const threads = registry.get("threads")!;
    expect(threads.capability).toMatchObject({
      analytics: false,
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
    expect(threads.listAnalytics).toBeUndefined();
    expect(threads.listComments).toBeUndefined();
    expect(threads.reply).toBeUndefined();
    const authorizationUrl = new URL(
      threads.authorizationUrl!({
        codeChallenge: "unused",
        redirectUri: "https://api.example.com/api/v1/platforms/threads/callback",
        state: "oauth-state",
      }),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/v1/platforms/threads/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "threads_basic,threads_content_publish,threads_delete",
    );
  });

  it("requires independent live acceptance before exposing engagement", () => {
    const environment = {
      PUBLIC_API_URL: "https://api.example.com",
      THREADS_CLIENT_ID: "threads-client",
      THREADS_CLIENT_SECRET: "threads-secret",
      THREADS_LIVE_ACCEPTED: "true",
    };
    expect(() =>
      createProviderRegistryFromEnvironment({
        ...environment,
        THREADS_ENGAGEMENT_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("THREADS_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
    expect(() =>
      createProviderRegistryFromEnvironment({
        ...environment,
        THREADS_ENGAGEMENT_LIVE_ACCEPTED: "true",
        THREADS_LIVE_ACCEPTED: "false",
      }),
    ).toThrow("requires THREADS_LIVE_ACCEPTED=true");

    const threads = createProviderRegistryFromEnvironment({
      ...environment,
      THREADS_ENGAGEMENT_LIVE_ACCEPTED: "true",
    }).get("threads")!;
    expect(threads.capability).toMatchObject({
      analytics: true,
      comments: true,
      reply: true,
    });
    expect(threads.listAnalytics).toBeTypeOf("function");
    expect(threads.listComments).toBeTypeOf("function");
    expect(threads.reply).toBeTypeOf("function");
    expect(
      new URL(
        threads.authorizationUrl!({
          codeChallenge: "unused",
          redirectUri: "https://api.example.com/api/v1/platforms/threads/callback",
          state: "oauth-state",
        }),
      ).searchParams.get("scope"),
    ).toContain("threads_manage_replies");
  });

  it("keeps Instagram absent until publishing acceptance is explicit", () => {
    const environment = {
      INSTAGRAM_CLIENT_ID: "instagram-client",
      INSTAGRAM_CLIENT_SECRET: "instagram-secret",
      PUBLIC_API_URL: "https://api.example.com",
    };
    for (const INSTAGRAM_LIVE_ACCEPTED of [undefined, "", "false"]) {
      const registry = createProviderRegistryFromEnvironment({
        ...environment,
        ...(INSTAGRAM_LIVE_ACCEPTED === undefined ? {} : { INSTAGRAM_LIVE_ACCEPTED }),
      });
      expect(registry.get("instagram")).toBeUndefined();
      expect(
        registry.capabilities().find(({ platform }) => platform === "instagram"),
      ).toMatchObject({ connect_available: false, publish: false });
    }
  });

  it("requires complete, independently accepted Instagram configuration", () => {
    expect(() =>
      createProviderRegistryFromEnvironment({
        INSTAGRAM_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("INSTAGRAM_LIVE_ACCEPTED must be true or false");
    expect(() =>
      createProviderRegistryFromEnvironment({
        INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
    expect(() =>
      createProviderRegistryFromEnvironment({
        INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "true",
        INSTAGRAM_LIVE_ACCEPTED: "false",
      }),
    ).toThrow("requires INSTAGRAM_LIVE_ACCEPTED=true");
    expect(() =>
      createProviderRegistryFromEnvironment({
        INSTAGRAM_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("Instagram provider configuration is incomplete");

    const environment = {
      INSTAGRAM_CLIENT_ID: "instagram-client",
      INSTAGRAM_CLIENT_SECRET: "instagram-secret",
      INSTAGRAM_LIVE_ACCEPTED: "true",
      PUBLIC_API_URL: "https://api.example.com/base",
    };
    const instagram = createProviderRegistryFromEnvironment(environment).get("instagram")!;
    expect(instagram.capability).toMatchObject({
      analytics: false,
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
    expect(instagram.listAnalytics).toBeUndefined();
    expect(instagram.listComments).toBeUndefined();
    expect(instagram.reply).toBeUndefined();
    const authorizationUrl = new URL(
      instagram.authorizationUrl!({
        codeChallenge: "unused",
        redirectUri: "https://api.example.com/api/v1/platforms/instagram/callback",
        state: "oauth-state",
      }),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/v1/platforms/instagram/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );

    const engagement = createProviderRegistryFromEnvironment({
      ...environment,
      INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "true",
    }).get("instagram")!;
    expect(engagement.capability).toMatchObject({
      analytics: true,
      comments: true,
      reply: true,
    });
    expect(engagement.listAnalytics).toBeTypeOf("function");
    expect(engagement.listComments).toBeTypeOf("function");
    expect(engagement.reply).toBeTypeOf("function");
  });

  it("keeps Facebook absent until Page publishing acceptance is explicit", () => {
    const environment = {
      FACEBOOK_CLIENT_ID: "facebook-client",
      FACEBOOK_CLIENT_SECRET: "facebook-secret",
      PUBLIC_API_URL: "https://api.example.com",
    };
    for (const FACEBOOK_LIVE_ACCEPTED of [undefined, "", "false"]) {
      const registry = createProviderRegistryFromEnvironment({
        ...environment,
        ...(FACEBOOK_LIVE_ACCEPTED === undefined ? {} : { FACEBOOK_LIVE_ACCEPTED }),
      });
      expect(registry.get("facebook")).toBeUndefined();
      expect(registry.capabilities().find(({ platform }) => platform === "facebook")).toMatchObject(
        { connect_available: false, publish: false },
      );
    }
  });

  it("requires complete accepted Facebook configuration and pins the callback", () => {
    expect(() =>
      createProviderRegistryFromEnvironment({
        FACEBOOK_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("FACEBOOK_LIVE_ACCEPTED must be true or false");
    expect(() =>
      createProviderRegistryFromEnvironment({
        FACEBOOK_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("Facebook provider configuration is incomplete");

    const facebook = createProviderRegistryFromEnvironment({
      FACEBOOK_CLIENT_ID: "facebook-client",
      FACEBOOK_CLIENT_SECRET: "facebook-secret",
      FACEBOOK_LIVE_ACCEPTED: "true",
      PUBLIC_API_URL: "https://api.example.com/base",
    }).get("facebook")!;
    expect(facebook.capability).toMatchObject({
      analytics: true,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
    expect(facebook.listAnalytics).toBeTypeOf("function");
    expect(facebook.listComments).toBeUndefined();
    expect(facebook.reply).toBeUndefined();
    const authorizationUrl = new URL(
      facebook.authorizationUrl!({
        codeChallenge: "unused",
        redirectUri: "https://api.example.com/api/v1/platforms/facebook/callback",
        state: "oauth-state",
      }),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/v1/platforms/facebook/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,read_insights",
    );
  });

  it("keeps YouTube absent until Shorts publishing acceptance is explicit", () => {
    const environment = {
      PUBLIC_API_URL: "https://api.example.com",
      YOUTUBE_SHORTS_CLIENT_ID: "youtube-client",
      YOUTUBE_SHORTS_CLIENT_SECRET: "youtube-secret",
    };
    for (const YOUTUBE_LIVE_ACCEPTED of [undefined, "", "false"]) {
      const registry = createProviderRegistryFromEnvironment({
        ...environment,
        ...(YOUTUBE_LIVE_ACCEPTED === undefined ? {} : { YOUTUBE_LIVE_ACCEPTED }),
      });
      expect(registry.get("youtube")).toBeUndefined();
      expect(registry.capabilities().find(({ platform }) => platform === "youtube")).toMatchObject({
        connect_available: false,
        publish: false,
      });
    }
  });

  it("keeps TikTok absent until Direct Post acceptance is explicit", () => {
    const environment = {
      PUBLIC_API_URL: "https://api.example.com",
      TIKTOK_CLIENT_KEY: "tiktok-client",
      TIKTOK_CLIENT_SECRET: "tiktok-secret",
      TIKTOK_MEDIA_URL_PREFIX: "https://account.r2.cloudflarestorage.com/assets/",
    };
    for (const TIKTOK_LIVE_ACCEPTED of [undefined, "", "false"]) {
      const registry = createProviderRegistryFromEnvironment({
        ...environment,
        ...(TIKTOK_LIVE_ACCEPTED === undefined ? {} : { TIKTOK_LIVE_ACCEPTED }),
      });
      expect(registry.get("tiktok")).toBeUndefined();
      expect(registry.capabilities().find(({ platform }) => platform === "tiktok")).toMatchObject({
        connect_available: false,
        publish: false,
      });
    }
  });

  it("requires complete accepted TikTok configuration and pins the callback", () => {
    expect(() => createProviderRegistryFromEnvironment({ TIKTOK_LIVE_ACCEPTED: "yes" })).toThrow(
      "TIKTOK_LIVE_ACCEPTED must be true or false",
    );
    expect(() => createProviderRegistryFromEnvironment({ TIKTOK_LIVE_ACCEPTED: "true" })).toThrow(
      "TikTok provider configuration is incomplete",
    );

    const tiktok = createProviderRegistryFromEnvironment({
      PUBLIC_API_URL: "https://api.example.com/base",
      TIKTOK_CLIENT_KEY: "tiktok-client",
      TIKTOK_CLIENT_SECRET: "tiktok-secret",
      TIKTOK_LIVE_ACCEPTED: "true",
      TIKTOK_MEDIA_URL_PREFIX: "https://account.r2.cloudflarestorage.com/assets/",
    }).get("tiktok")!;
    expect(tiktok.capability).toMatchObject({
      analytics: true,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
    expect(tiktok.getPublicationRequirements).toBeTypeOf("function");
    expect(tiktok.listAnalytics).toBeTypeOf("function");
    expect(tiktok.listComments).toBeUndefined();
    expect(tiktok.reply).toBeUndefined();
    const authorizationUrl = new URL(
      tiktok.authorizationUrl!({
        codeChallenge: "unused",
        redirectUri: "https://api.example.com/api/v1/platforms/tiktok/callback",
        state: "oauth-state",
      }),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/v1/platforms/tiktok/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "user.info.basic,video.publish,video.list",
    );
  });

  it("requires complete accepted YouTube configuration and pins the callback", () => {
    expect(() => createProviderRegistryFromEnvironment({ YOUTUBE_LIVE_ACCEPTED: "yes" })).toThrow(
      "YOUTUBE_LIVE_ACCEPTED must be true or false",
    );
    expect(() => createProviderRegistryFromEnvironment({ YOUTUBE_LIVE_ACCEPTED: "true" })).toThrow(
      "YouTube provider configuration is incomplete",
    );

    const youtube = createProviderRegistryFromEnvironment({
      PUBLIC_API_URL: "https://api.example.com/base",
      YOUTUBE_LIVE_ACCEPTED: "true",
      YOUTUBE_SHORTS_CLIENT_ID: "youtube-client",
      YOUTUBE_SHORTS_CLIENT_SECRET: "youtube-secret",
    }).get("youtube")!;
    expect(youtube.capability).toMatchObject({
      analytics: true,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
    expect(youtube.listAnalytics).toBeTypeOf("function");
    expect(youtube.listComments).toBeUndefined();
    expect(youtube.reply).toBeUndefined();
    const authorizationUrl = new URL(
      youtube.authorizationUrl!({
        codeChallenge: "a".repeat(43),
        redirectUri: "https://api.example.com/api/v1/platforms/youtube/callback",
        state: "oauth-state",
      }),
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/api/v1/platforms/youtube/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
    );
  });

  it("rejects claimed publishing without an implementation", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register("threads", {
        capability: {
          accepted_mime_types: ["text/plain"],
          analytics: false,
          asset_types: [],
          comments: false,
          connect_available: true,
          max_caption_length: 500,
          max_file_size: null,
          max_hashtags: null,
          max_media_count: null,
          max_video_duration_sec: null,
          min_media_count: 0,
          multi_asset_types: [],
          notes: [],
          platform: "threads",
          publish: true,
          reply: false,
        },
        transferModes: [],
      }),
    ).toThrow("requires publish and lookup adapters");
  });

  it("rejects TikTok publishing without current creator requirements", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register("tiktok", {
        capability: {
          accepted_mime_types: ["video/mp4"],
          analytics: false,
          asset_types: ["video"],
          comments: false,
          connect_available: false,
          max_caption_length: 2_200,
          max_file_size: 1024,
          max_hashtags: 30,
          max_media_count: 1,
          max_video_duration_sec: 600,
          min_media_count: 1,
          multi_asset_types: [],
          notes: [],
          platform: "tiktok",
          publish: true,
          reply: false,
        },
        lookupPublication: async () => ({ state: "not_found" }),
        publish: async () => ({ outcome: "confirmed_success" }),
        retryPolicy: {
          baseDelaySeconds: 30,
          maxAttempts: 1,
          maxDelaySeconds: 30,
        },
        transferModes: ["remote_ingest"],
      }),
    ).toThrow("requires publication requirements");
  });

  it("rejects claimed OAuth without start and exchange implementations", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register("threads", {
        capability: {
          accepted_mime_types: ["text/plain"],
          analytics: false,
          asset_types: [],
          comments: false,
          connect_available: true,
          max_caption_length: 500,
          max_file_size: null,
          max_hashtags: null,
          max_media_count: null,
          max_video_duration_sec: null,
          min_media_count: 0,
          multi_asset_types: [],
          notes: [],
          platform: "threads",
          publish: false,
          reply: false,
        },
        transferModes: [],
      }),
    ).toThrow("requires authorization and code-exchange adapters");
  });

  it("requires every advertised downstream capability to have an implementation", () => {
    const base = {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: [],
      platform: "threads" as const,
      publish: false,
      reply: false,
    };
    expect(() =>
      new ProviderRegistry().register("threads", {
        capability: { ...base, analytics: true },
        transferModes: [],
      }),
    ).toThrow("requires an analytics adapter");
    expect(() =>
      new ProviderRegistry().register("threads", {
        capability: { ...base, comments: true },
        transferModes: [],
      }),
    ).toThrow("requires a comments adapter");
    expect(() =>
      new ProviderRegistry().register("threads", {
        capability: { ...base, reply: true },
        transferModes: [],
      }),
    ).toThrow("requires a reply adapter");
  });

  it("requires an explicit media transfer mode and prevents registry replacement", () => {
    const registry = new ProviderRegistry();
    const capability = {
      accepted_mime_types: ["image/jpeg"],
      analytics: false,
      asset_types: ["image" as const],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: 1_000_000,
      max_hashtags: 5,
      max_media_count: 10,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: ["image" as const],
      notes: [],
      platform: "threads" as const,
      publish: true,
      reply: false,
    };
    expect(() =>
      registry.register("threads", {
        capability,
        lookupPublication: async () => ({ state: "not_found" }),
        publish: async () => ({
          outcome: "confirmed_success",
          providerPostId: "post-1",
        }),
        transferModes: ["remote_ingest"],
      }),
    ).toThrow("requires a retry policy");
    expect(() =>
      registry.register("threads", {
        capability,
        lookupPublication: async () => ({ state: "not_found" }),
        publish: async () => ({
          outcome: "confirmed_success",
          providerPostId: "post-1",
        }),
        retryPolicy: {
          baseDelaySeconds: 0,
          maxAttempts: 11,
          maxDelaySeconds: 100_000,
        },
        transferModes: ["remote_ingest"],
      }),
    ).toThrow("outside safe bounds");
    expect(() =>
      registry.register("threads", {
        capability,
        lookupPublication: async () => ({
          result: {
            outcome: "confirmed_success",
            providerPostId: "post-1",
          },
          state: "published",
        }),
        publish: async () => ({
          outcome: "confirmed_success",
          providerPostId: "post-1",
        }),
        retryPolicy: {
          baseDelaySeconds: 15,
          maxAttempts: 5,
          maxDelaySeconds: 300,
        },
        transferModes: [],
      }),
    ).toThrow("requires at least one transfer mode");

    registry.register("threads", {
      capability,
      lookupPublication: async () => ({
        result: {
          outcome: "confirmed_success",
          providerPostId: "post-1",
        },
        state: "published",
      }),
      publish: async () => ({
        outcome: "confirmed_success",
        providerPostId: "post-1",
      }),
      retryPolicy: {
        baseDelaySeconds: 15,
        maxAttempts: 5,
        maxDelaySeconds: 300,
      },
      transferModes: ["remote_ingest"],
    });
    expect(() =>
      registry.register("threads", {
        capability,
        lookupPublication: async () => ({
          result: {
            outcome: "confirmed_failure",
            failure: classifyProviderFailure({ status: 400 }),
          },
          state: "failed",
        }),
        publish: async () => ({
          outcome: "confirmed_failure",
          failure: classifyProviderFailure({ status: 400 }),
        }),
        retryPolicy: {
          baseDelaySeconds: 15,
          maxAttempts: 5,
          maxDelaySeconds: 300,
        },
        transferModes: ["remote_ingest"],
      }),
    ).toThrow("already registered");
  });
});

describe("provider failure classification", () => {
  it.each([
    [{ status: 400 }, "deterministic", false],
    [{ status: 401 }, "auth", false],
    [{ status: 402 }, "quota", false],
    [{ retryAfterSeconds: 30, status: 429 }, "rate_limit", true],
    [{ timedOut: true }, "timeout", true],
    [{ status: 503 }, "transient", true],
    [{ sideEffectPossible: true, timedOut: true }, "ambiguous", false],
  ] as const)("normalizes %o as %s", (input, expectedClass, expectedRetryable) => {
    const failure = classifyProviderFailure(input);
    expect(failure.classification).toBe(expectedClass);
    expect(failure.retryable).toBe(expectedRetryable);
    expect(failure.message).not.toMatch(/https?:|token|secret/i);
  });

  it("accepts only bounded safe codes and retry delays", () => {
    const failure = classifyProviderFailure({
      code: "Bearer secret https://provider.example/failure",
      retryAfterSeconds: 100_000,
      status: 429,
    });
    expect(failure).toEqual({
      classification: "rate_limit",
      code: "provider_rate_limit",
      message: "The provider rate limit has been reached.",
      retryable: true,
    });
    expect(new ProviderAdapterError(failure)).toMatchObject({
      failure,
      message: failure.message,
      name: "ProviderAdapterError",
    });
    expect(
      normalizeProviderFailure({
        classification: "auth",
        code: "Bearer secret https://provider.example/failure",
        message: "access_token=secret",
        retryable: true,
        retryAfterSeconds: 30,
      }),
    ).toEqual({
      classification: "auth",
      code: "provider_auth",
      message: "The provider authorization must be refreshed.",
      retryable: false,
    });
  });
});
