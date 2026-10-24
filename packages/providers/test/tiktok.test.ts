import { describe, expect, it, vi } from "vite-plus/test";

import {
  createTikTokAdapter,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderRequestContext,
  type PublishInput,
} from "../src";

const context: ProviderRequestContext = {
  operationId: "operation-1",
  requestId: "request-1",
};
const credentials = {
  accessToken: "access-secret",
  accountId: "open-id-1",
};
const redirectUri = "https://api.example.com/api/v1/platforms/tiktok/callback";
const mediaUrlPrefix = "https://media.example.com/tiktok/";

type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function success(data: Record<string, unknown>): Response {
  return json({ data, error: { code: "ok", log_id: "safe-log" } });
}

function creator(
  patch: Partial<{
    comment_disabled: boolean;
    duet_disabled: boolean;
    max_video_post_duration_sec: number;
    privacy_level_options: string[];
    stitch_disabled: boolean;
  }> = {},
): Response {
  return success({
    comment_disabled: false,
    creator_avatar_url: "https://cdn.example.com/avatar.jpg",
    creator_nickname: "Meltiply Creator",
    creator_username: "meltiply.creator",
    duet_disabled: false,
    max_video_post_duration_sec: 300,
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    stitch_disabled: false,
    ...patch,
  });
}

function sequence(...responders: Responder[]) {
  const calls: { init: RequestInit; url: URL }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(input.toString());
    calls.push({ init, url });
    const responder = responders.shift();
    if (!responder) throw new Error("unexpected provider request");
    return responder(url, init);
  });
  return { calls, fetcher };
}

function adapter(fetcher: typeof fetch, now = new Date("2026-07-19T00:00:00Z")) {
  return createTikTokAdapter({
    clientKey: "tiktok-client-key",
    clientSecret: "tiktok-client-secret",
    fetch: fetcher,
    mediaUrlPrefix,
    now: () => now,
    redirectUri,
    timeoutMilliseconds: 100,
  });
}

/**
 * Returns the canonical valid TikTok Direct Post publish request — a 120 s
 * portrait MP4 ingested from a `mediaUrlPrefix` URL with full creator options —
 * so each spec overrides only the dimension it exercises. `patch` is spread
 * last, so its keys replace whole top-level fields (e.g. `media`,
 * `providerOptions`) rather than deep-merging into the defaults.
 */
function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A direct post\n\n#launch",
    hashtags: ["launch"],
    idempotencyKey: "publish-1",
    media: [
      {
        contentType: "video/mp4",
        fileSize: 1024,
        metadata: {
          durationSeconds: 120,
          height: 1920,
          width: 1080,
        },
        mode: "remote_ingest",
        url: `${mediaUrlPrefix}org/asset/video.mp4`,
      },
    ],
    providerOptions: {
      tiktok: {
        allowComment: true,
        allowDuet: true,
        allowStitch: false,
        brandContent: false,
        brandOrganic: false,
        isAiGenerated: true,
        musicUsageConfirmed: true,
        privacyLevel: "PUBLIC_TO_EVERYONE",
      },
    },
    ...patch,
  };
}

describe("createTikTokAdapter", () => {
  it("advertises only the implemented TikTok Direct Post subset", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    expect(provider.capability).toMatchObject({
      accepted_mime_types: ["image/jpeg", "image/webp", "video/mp4", "video/quicktime"],
      analytics: true,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      max_caption_length: 2_200,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 30,
      max_video_duration_sec: 600,
      max_media_count: 35,
      min_media_count: 1,
      multi_asset_types: ["image"],
      platform: "tiktok",
      publish: true,
      reply: false,
    });
    expect(provider.getPublicationRequirements).toBeTypeOf("function");
    expect(provider.listAnalytics).toBeTypeOf("function");
    expect(provider.listComments).toBeUndefined();
    expect(provider.reply).toBeUndefined();
    expect(() => new ProviderRegistry().register("tiktok", provider)).not.toThrow();
  });

  it("builds the exact state-bound TikTok web authorization URL", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    const url = new URL(
      provider.authorizationUrl!({
        codeChallenge: "unused-by-tiktok-web",
        redirectUri,
        state: "oauth-state",
      }),
    );
    expect(url.origin).toBe("https://www.tiktok.com");
    expect(url.pathname).toBe("/v2/auth/authorize/");
    expect(new Set(url.searchParams.get("scope")?.split(","))).toEqual(
      new Set(["user.info.basic", "user.info.stats", "video.publish", "video.list"]),
    );
    const { scope: _scope, ...parameters } = Object.fromEntries(url.searchParams);
    expect(parameters).toEqual({
      client_key: "tiktok-client-key",
      disable_auto_auth: "1",
      redirect_uri: redirectUri,
      response_type: "code",
      state: "oauth-state",
    });
    expect(() =>
      provider.authorizationUrl!({
        codeChallenge: "unused",
        redirectUri: "https://attacker.example/callback",
        state: "oauth-state",
      }),
    ).toThrow("does not match configuration");
  });

  it.each([
    "user.info.basic,user.info.stats,video.publish,video.list",
    "user.info.basic,video.publish",
    "user.info.basic,video.publish,video.list",
  ])("connects with granted scopes %s and binds the token open ID", async (grantedScopes) => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.toString()).toBe("https://open.tiktokapis.com/v2/oauth/token/");
        const form = new URLSearchParams(String(init.body));
        expect(Object.fromEntries(form)).toEqual({
          client_key: "tiktok-client-key",
          client_secret: "tiktok-client-secret",
          code: "authorization-code",
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });
        return json({
          access_token: "access-secret",
          expires_in: 86_400,
          open_id: "open-id-1",
          refresh_expires_in: 31_536_000,
          refresh_token: "refresh-secret",
          scope: grantedScopes,
          token_type: "Bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v2/user/info/");
        expect(url.searchParams.get("fields")).toBe("open_id,display_name,avatar_url");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret");
        return success({
          user: {
            avatar_url: "https://cdn.example.com/avatar.jpg",
            display_name: "Meltiply Creator",
            open_id: "open-id-1",
          },
        });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "unused-by-tiktok-web",
        redirectUri,
      }),
    ).resolves.toEqual({
      accessToken: "access-secret",
      account: {
        avatarUrl: "https://cdn.example.com/avatar.jpg",
        displayName: "Meltiply Creator",
        id: "open-id-1",
      },
      expiresAt: "2026-07-20T00:00:00.000Z",
      refreshToken: "refresh-secret",
      scopes: grantedScopes.split(","),
    });
  });

  it("rejects a profile that does not match the token open ID", async () => {
    const providerCalls = sequence(
      () =>
        json({
          access_token: "access-secret",
          expires_in: 86_400,
          open_id: "open-id-1",
          refresh_token: "refresh-secret",
          scope: "user.info.basic,user.info.stats,video.publish,video.list",
          token_type: "Bearer",
        }),
      () =>
        success({
          user: { display_name: "Wrong account", open_id: "open-id-2" },
        }),
    );
    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: { code: "provider_transient" },
    });
  });

  it.each(["user.info.basic", "video.publish"])(
    "rejects a partial TikTok grant containing only %s before reading a profile",
    async (scope) => {
      const providerCalls = sequence(() =>
        json({
          access_token: "access-secret",
          expires_in: 86_400,
          open_id: "open-id-1",
          refresh_token: "refresh-secret",
          scope,
          token_type: "Bearer",
        }),
      );
      await expect(
        adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
          code: "authorization-code",
          codeVerifier: "unused-by-tiktok-web",
          redirectUri,
        }),
      ).rejects.toBeInstanceOf(ProviderAdapterError);
      expect(providerCalls.calls.map(({ url }) => url.pathname)).toEqual(["/v2/oauth/token/"]);
    },
  );

  it("normalizes current creator publication requirements", async () => {
    const providerCalls = sequence(() =>
      creator({ duet_disabled: true, max_video_post_duration_sec: 180 }),
    );
    await expect(
      adapter(providerCalls.fetcher).getPublicationRequirements!(context, credentials),
    ).resolves.toEqual({
      commentAllowed: true,
      creatorAvatarUrl: "https://cdn.example.com/avatar.jpg",
      creatorDisplayName: "Meltiply Creator",
      creatorUsername: "meltiply.creator",
      duetAllowed: false,
      maxVideoDurationSeconds: 180,
      platform: "tiktok",
      privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      stitchAllowed: true,
    });
  });

  it("queries creator info immediately before a bounded video Direct Post", async () => {
    const providerCalls = sequence(
      () => creator(),
      (url, init) => {
        expect(url.pathname).toBe("/v2/post/publish/video/init/");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret");
        expect(JSON.parse(String(init.body))).toEqual({
          post_info: {
            brand_content_toggle: false,
            brand_organic_toggle: false,
            disable_comment: false,
            disable_duet: false,
            disable_stitch: true,
            is_aigc: true,
            privacy_level: "PUBLIC_TO_EVERYONE",
            title: "A direct post\n\n#launch",
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: `${mediaUrlPrefix}org/asset/video.mp4`,
          },
        });
        return success({ publish_id: "v_pub_url~v2.123" });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "publish:v_pub_url~v2.123",
    });
    expect(providerCalls.calls.map(({ url }) => url.pathname)).toEqual([
      "/v2/post/publish/creator_info/query/",
      "/v2/post/publish/video/init/",
    ]);
  });

  it("submits one JPEG through the photo Direct Post surface", async () => {
    const photoUrl = `${mediaUrlPrefix}org/asset/photo.jpg?signature=safe`;
    const providerCalls = sequence(
      () => creator({ duet_disabled: true, stitch_disabled: true }),
      (url, init) => {
        expect(url.pathname).toBe("/v2/post/publish/content/init/");
        expect(JSON.parse(String(init.body))).toEqual({
          media_type: "PHOTO",
          post_info: {
            auto_add_music: false,
            brand_content_toggle: false,
            brand_organic_toggle: true,
            description: "Photo launch\n\n#launch",
            disable_comment: false,
            privacy_level: "SELF_ONLY",
            title: "Photo launch",
          },
          post_mode: "DIRECT_POST",
          source_info: {
            photo_cover_index: 0,
            photo_images: [photoUrl],
            source: "PULL_FROM_URL",
          },
        });
        return success({ publish_id: "p_pub_url~v2.456" });
      },
    );
    const input = publishInput({
      caption: "Photo launch\n\n#launch",
      media: [
        {
          contentType: "image/jpeg",
          fileSize: 1024,
          metadata: { height: 1080, width: 1080 },
          mode: "remote_ingest",
          url: photoUrl,
        },
      ],
      providerOptions: {
        tiktok: {
          allowComment: true,
          allowDuet: false,
          allowStitch: false,
          brandContent: false,
          brandOrganic: true,
          isAiGenerated: false,
          musicUsageConfirmed: true,
          privacyLevel: "SELF_ONLY",
        },
      },
    });
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, input),
    ).resolves.toMatchObject({
      outcome: "confirmed_success",
      providerOperationId: "publish:p_pub_url~v2.456",
    });
  });

  it("stops before init when a selected creator choice is unavailable", async () => {
    const providerCalls = sequence(() => creator({ comment_disabled: true }));
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).rejects.toMatchObject({
      failure: { code: "tiktok_creator_choice_unavailable" },
    });
    expect(providerCalls.calls).toHaveLength(1);
  });

  it.each([
    [
      "a URL outside the verified prefix",
      publishInput({
        media: [
          {
            contentType: "video/mp4",
            fileSize: 1024,
            mode: "remote_ingest",
            url: "https://attacker.example/video.mp4",
          },
        ],
      }),
      "tiktok_media_prefix_invalid",
    ],
    [
      "a WebM video TikTok cannot distribute",
      publishInput({
        media: [
          {
            contentType: "video/webm",
            fileSize: 1024,
            mode: "remote_ingest",
            url: `${mediaUrlPrefix}org/asset/video.webm`,
          },
        ],
      }),
      "tiktok_video_invalid",
    ],
    [
      "video beyond the creator duration",
      publishInput({
        media: [
          {
            contentType: "video/mp4",
            fileSize: 1024,
            metadata: { durationSeconds: 301, height: 1920, width: 1080 },
            mode: "remote_ingest",
            url: `${mediaUrlPrefix}org/asset/video.mp4`,
          },
        ],
      }),
      "tiktok_video_invalid",
    ],
    [
      "AI-generated photo when the photo API cannot declare it",
      publishInput({
        caption: "Photo",
        media: [
          {
            contentType: "image/webp",
            fileSize: 1024,
            metadata: { height: 1080, width: 1080 },
            mode: "remote_ingest",
            url: `${mediaUrlPrefix}org/asset/photo.webp?signature=safe`,
          },
        ],
        providerOptions: {
          tiktok: {
            allowComment: false,
            allowDuet: false,
            allowStitch: false,
            brandContent: false,
            brandOrganic: false,
            isAiGenerated: true,
            musicUsageConfirmed: true,
            privacyLevel: "SELF_ONLY",
          },
        },
      }),
      "tiktok_photo_invalid",
    ],
  ])("rejects %s", async (_label, input, code) => {
    const providerCalls = sequence(() => creator());
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, input),
    ).rejects.toMatchObject({ failure: { code } });
  });

  it("returns unknown without retrying when init may have succeeded", async () => {
    const providerCalls = sequence(
      () => creator(),
      () =>
        new Response("not-json", {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).resolves.toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "unknown",
    });
    expect(providerCalls.calls).toHaveLength(2);
  });

  it.each([
    [
      "PROCESSING_DOWNLOAD",
      {},
      {
        providerOperationId: "publish:v_pub_url~v2.123",
        state: "processing",
      },
    ],
    [
      "SEND_TO_USER_INBOX",
      {},
      {
        result: {
          failure: { code: "tiktok_sent_to_inbox", retryable: false },
          outcome: "confirmed_failure",
          providerOperationId: "publish:v_pub_url~v2.123",
        },
        state: "failed",
      },
    ],
    [
      "PUBLISH_COMPLETE",
      { publicaly_available_post_id: ["741234567890"] },
      {
        result: {
          outcome: "confirmed_success",
          providerOperationId: "publish:v_pub_url~v2.123",
          providerPostId: "741234567890",
        },
        state: "published",
      },
    ],
    [
      "FAILED",
      { fail_reason: "video_pull_failed" },
      {
        result: {
          failure: { code: "tiktok_video_pull_failed", retryable: false },
          outcome: "confirmed_failure",
          providerOperationId: "publish:v_pub_url~v2.123",
        },
        state: "failed",
      },
    ],
  ])("maps %s publication status", async (status, patch, expected) => {
    const providerCalls = sequence((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({
        publish_id: "v_pub_url~v2.123",
      });
      return success({ status, ...patch });
    });
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.123",
      }),
    ).resolves.toMatchObject(expected);
  });

  it("adopts the primary identifier from a documented multi-ID list", async () => {
    const providerCalls = sequence(() =>
      success({
        publicaly_available_post_id: ["741234567890", "741234567891"],
        status: "PUBLISH_COMPLETE",
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.123",
      }),
    ).resolves.toMatchObject({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "publish:v_pub_url~v2.123",
        providerPostId: "741234567890",
      },
      state: "published",
    });
  });

  it("rejects a publication identifier list containing an invalid entry", async () => {
    const providerCalls = sequence(() =>
      success({
        publicaly_available_post_id: ["741234567890", "not a post id"],
        status: "PUBLISH_COMPLETE",
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.123",
      }),
    ).rejects.toMatchObject({
      failure: { code: "provider_transient" },
    });
  });

  it("maps TikTok's invalid publish ID envelope to not found", async () => {
    const providerCalls = sequence(() =>
      json({
        data: {},
        error: { code: "invalid_publish_id", log_id: "safe-log" },
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.missing",
      }),
    ).resolves.toEqual({ state: "not_found" });
  });

  it("performs best-effort cancel and preserves ambiguous cancellation", async () => {
    const successful = sequence((url, init) => {
      expect(url.pathname).toBe("/v2/post/publish/cancel/");
      expect(JSON.parse(String(init.body))).toEqual({
        publish_id: "v_pub_url~v2.123",
      });
      return success({});
    });
    await expect(
      adapter(successful.fetcher).cancelPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.123",
      }),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "publish:v_pub_url~v2.123",
    });

    const ambiguous = sequence(
      () =>
        new Response("not-json", {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      adapter(ambiguous.fetcher).cancelPublication!(context, credentials, {
        providerOperationId: "publish:v_pub_url~v2.123",
      }),
    ).resolves.toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "unknown",
      providerOperationId: "publish:v_pub_url~v2.123",
    });
  });

  it.each([
    "user.info.basic,user.info.stats,video.publish,video.list",
    "user.info.basic,video.publish",
  ])("refreshes and revokes with actual grants %s", async (grantedScopes) => {
    const providerCalls = sequence(
      (_url, init) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("refresh_token")).toBe("refresh-original");
        return json({
          access_token: "access-rotated",
          expires_in: 86_400,
          open_id: "open-id-1",
          refresh_token: "refresh-rotated",
          scope: grantedScopes,
          token_type: "Bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v2/oauth/revoke/");
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          client_key: "tiktok-client-key",
          client_secret: "tiktok-client-secret",
          token: "access-rotated",
        });
        return new Response(null, { status: 200 });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.refreshAccessToken!(context, "refresh-original")).resolves.toEqual({
      accessToken: "access-rotated",
      expiresAt: "2026-07-20T00:00:00.000Z",
      refreshToken: "refresh-rotated",
      scopes: grantedScopes.split(","),
    });
    await expect(provider.revoke!("access-rotated")).resolves.toBeUndefined();
  });

  it("normalizes TikTok error envelopes without leaking provider messages", async () => {
    const providerCalls = sequence(() =>
      json({
        data: {},
        error: {
          code: "rate_limit_exceeded",
          log_id: "safe-log",
          message: "raw provider detail must not escape",
        },
      }),
    );
    const error = await adapter(providerCalls.fetcher).getPublicationRequirements!(
      context,
      credentials,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error).toMatchObject({
      failure: {
        classification: "rate_limit",
        code: "tiktok_rate_limit_exceeded",
        message: "The provider rate limit has been reached.",
      },
    });
    expect(JSON.stringify(error)).not.toContain("raw provider detail");
  });

  it("reads the creator's video counters without inventing measurements", async () => {
    const providerCalls = sequence((url, init) => {
      expect(url.origin).toBe("https://open.tiktokapis.com");
      expect(url.pathname).toBe("/v2/video/query/");
      expect(url.searchParams.get("fields")).toBe(
        "id,view_count,like_count,comment_count,share_count",
      );
      expect(JSON.parse(String(init.body))).toEqual({ filters: { video_ids: ["video-1"] } });
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret");
      return success({
        videos: [
          {
            comment_count: 9,
            id: "video-1",
            like_count: 84,
            share_count: 12,
            view_count: 1200,
          },
        ],
      });
    });
    await expect(
      adapter(providerCalls.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).resolves.toEqual({
      items: [
        {
          comments: 9,
          impressions: 0,
          likes: 84,
          providerPostId: "video-1",
          recordedAt: "2026-07-19T00:00:00.000Z",
          reach: 0,
          shares: 12,
          views: 1200,
          watchTimeSeconds: 0,
        },
      ],
    });
  });

  it("writes no snapshot when TikTok no longer reports the video", async () => {
    const providerCalls = sequence(() => success({ videos: [] }));
    await expect(
      adapter(providerCalls.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).resolves.toEqual({ items: [] });
  });

  it("rejects a metric row that omits a requested counter", async () => {
    const providerCalls = sequence(() =>
      success({ videos: [{ id: "video-1", like_count: 1, view_count: 2 }] }),
    );
    await expect(
      adapter(providerCalls.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});
