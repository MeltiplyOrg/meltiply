import { describe, expect, it, vi } from "vite-plus/test";

import {
  createInstagramAdapter,
  ProviderAdapterError,
  type ProviderRequestContext,
  type PublishInput,
} from "../src";

const context: ProviderRequestContext = {
  operationId: "operation-1",
  requestId: "request-1",
};
const credentials = {
  accessToken: "access-secret",
  accountId: "account-1",
};
const redirectUri = "https://api.example.com/api/v1/platforms/instagram/callback";

type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
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

function adapter(
  fetcher: typeof fetch,
  now = new Date("2026-07-19T00:00:00Z"),
  engagementEnabled = true,
) {
  return createInstagramAdapter({
    clientId: "instagram-client",
    clientSecret: "instagram-client-secret",
    engagementEnabled,
    fetch: fetcher,
    now: () => now,
    redirectUri,
    timeoutMilliseconds: 100,
  });
}

function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "An Instagram post #launch",
    hashtags: ["launch"],
    idempotencyKey: "publish-1",
    media: [
      {
        contentType: "image/jpeg",
        fileSize: 1_024,
        mode: "remote_ingest",
        url: "https://assets.example/image.jpg?signature=secret",
      },
    ],
    ...patch,
  };
}

describe("createInstagramAdapter", () => {
  it("builds a state-bound Instagram Login URL and pins the callback", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    const value = provider.authorizationUrl!({
      codeChallenge: "unused-by-instagram",
      redirectUri,
      state: "oauth-state",
    });
    const url = new URL(value);
    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "instagram-client",
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights",
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

  it("exchanges a code for a long-lived professional account token", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.origin).toBe("https://api.instagram.com");
        expect(init.method).toBe("POST");
        expect(String(init.body)).toContain("client_secret=instagram-client-secret");
        return json({
          data: [
            {
              access_token: "short-secret",
              user_id: "12345",
              permissions:
                "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights",
            },
          ],
        });
      },
      (url) => {
        expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
        expect(url.searchParams.get("access_token")).toBe("short-secret");
        return json({
          access_token: "long-secret",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/me");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer long-secret");
        return json({
          data: [
            {
              account_type: "Business",
              id: "12345",
              user_id: "17841400000098765",
              name: "Creator Real Name",
              profile_picture_url: "https://cdn.example/avatar.jpg",
              username: "creator",
            },
          ],
        });
      },
    );

    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "unused-by-instagram",
        redirectUri,
      }),
    ).resolves.toEqual({
      accessToken: "long-secret",
      account: {
        avatarUrl: "https://cdn.example/avatar.jpg",
        displayName: "Creator Real Name",
        id: "17841400000098765",
        username: "creator",
      },
      expiresAt: "2026-09-17T00:00:00.000Z",
      refreshToken: "long-secret",
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ],
    });
  });

  it("creates, polls, and publishes a remote-ingest media container", async () => {
    const providerCalls = sequence(
      () => json({ id: "container-1" }),
      () => json({ id: "container-1", status_code: "IN_PROGRESS" }),
      () => json({ id: "container-1", status_code: "FINISHED" }),
      () => json({ id: "media-1" }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.publish!(context, credentials, publishInput())).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:container-1",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-1",
      }),
    ).resolves.toEqual({
      providerOperationId: "created:container-1",
      state: "processing",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-1",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:container-1",
        providerPostId: "media-1",
      },
      state: "published",
    });

    expect(providerCalls.calls.map(({ url }) => url.pathname)).toEqual([
      "/v25.0/account-1/media",
      "/v25.0/container-1",
      "/v25.0/container-1",
      "/v25.0/account-1/media_publish",
    ]);
    expect(providerCalls.calls[1]!.url.searchParams.get("fields")).toBe("id,status_code,status");
    expect(providerCalls.calls[0]!.url.searchParams.get("image_url")).toBe(
      "https://assets.example/image.jpg?signature=secret",
    );
    expect(providerCalls.calls[3]!.url.searchParams.get("creation_id")).toBe("container-1");
  });

  it("uses the Reels surface for a bounded remote video", async () => {
    const providerCalls = sequence(() => json({ id: "video-container" }));
    await adapter(providerCalls.fetcher).publish!(
      context,
      credentials,
      publishInput({
        media: [
          {
            contentType: "video/mp4",
            fileSize: 50 * 1024 * 1024,
            mode: "remote_ingest",
            url: "https://assets.example/video.mp4",
          },
        ],
      }),
    );
    expect(Object.fromEntries(providerCalls.calls[0]!.url.searchParams)).toMatchObject({
      media_type: "REELS",
      share_to_feed: "true",
      video_url: "https://assets.example/video.mp4",
    });
  });

  // Observe the actual mixed-carousel protocol: unpublished VIDEO children,
  // one parent caption, and ordered child ids rather than standalone Reels.
  it("creates one child container per attachment and binds them in creator order", async () => {
    const providerCalls = sequence(
      () => json({ id: "child-1" }),
      () => json({ id: "child-2" }),
      () => json({ id: "child-3" }),
      () => json({ id: "carousel-parent" }),
    );
    const result = await adapter(providerCalls.fetcher).publish!(
      context,
      credentials,
      publishInput({
        media: [
          {
            contentType: "image/jpeg",
            fileSize: 100,
            mode: "remote_ingest",
            url: "https://assets.example/one.jpg",
          },
          {
            contentType: "video/mp4",
            fileSize: 100,
            mode: "remote_ingest",
            url: "https://assets.example/two.mp4",
          },
          {
            contentType: "image/jpeg",
            fileSize: 100,
            mode: "remote_ingest",
            url: "https://assets.example/three.jpg",
          },
        ],
      }),
    );

    // Each child is created unpublished and in its own request, so nothing is
    // published until every attachment is retrievable.
    expect(providerCalls.calls).toHaveLength(4);
    expect(Object.fromEntries(providerCalls.calls[0]!.url.searchParams)).toMatchObject({
      image_url: "https://assets.example/one.jpg",
      is_carousel_item: "true",
    });
    expect(Object.fromEntries(providerCalls.calls[1]!.url.searchParams)).toMatchObject({
      is_carousel_item: "true",
      media_type: "VIDEO",
      video_url: "https://assets.example/two.mp4",
    });
    expect(providerCalls.calls[1]!.url.searchParams.has("share_to_feed")).toBe(false);
    expect(Object.fromEntries(providerCalls.calls[2]!.url.searchParams)).toMatchObject({
      image_url: "https://assets.example/three.jpg",
      is_carousel_item: "true",
    });
    // The parent carries the caption exactly once and the children in order.
    expect(Object.fromEntries(providerCalls.calls[3]!.url.searchParams)).toEqual({
      caption: "An Instagram post #launch",
      children: "child-1,child-2,child-3",
      media_type: "CAROUSEL",
    });
    expect(result).toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:carousel-parent",
    });
  });

  it("does not resubmit a publication after an ambiguous final write", async () => {
    const providerCalls = sequence(
      () => json({ id: "container-ambiguous" }),
      () => json({ id: "container-ambiguous", status_code: "FINISHED" }),
      () => Promise.reject(new Error("connection lost")),
      () => json({ id: "container-ambiguous", status_code: "PUBLISHED" }),
    );
    const provider = adapter(providerCalls.fetcher);
    await provider.publish!(context, credentials, publishInput());
    const firstLookup = await provider.lookupPublication!(context, credentials, {
      providerOperationId: "created:container-ambiguous",
    });
    expect(firstLookup).toMatchObject({
      result: {
        outcome: "unknown",
        providerOperationId: "submitted:container-ambiguous",
      },
      state: "unknown",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "submitted:container-ambiguous",
      }),
    ).resolves.toMatchObject({
      result: {
        outcome: "unknown",
        providerOperationId: "submitted:container-ambiguous",
      },
      state: "unknown",
    });
    expect(
      providerCalls.calls.filter(({ url }) => url.pathname.endsWith("/media_publish")),
    ).toHaveLength(1);
  });

  it.each([
    [
      "Failed downloading video from https://media.example/private?token=abc123",
      "instagram_container_media_retrieval",
    ],
    ["The video format is not supported for this container", "instagram_container_media_format"],
    [
      "Video duration 900 seconds exceeds the allowed maximum",
      "instagram_container_media_duration",
    ],
    ["The media aspect ratio is not supported", "instagram_container_media_dimensions"],
    ["Unexpected processing failure", "instagram_container_error"],
  ] as const)("normalizes container status detail %j to %s", async (detail, code) => {
    const providerCalls = sequence(() =>
      json({
        id: "container-error",
        status: detail,
        status_code: "ERROR",
      }),
    );
    const result = await adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
      providerOperationId: "created:container-error",
    });
    expect(result).toMatchObject({
      result: {
        failure: { classification: "deterministic", code },
        outcome: "confirmed_failure",
        providerOperationId: "created:container-error",
      },
      state: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("media.example");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("rejects missing account identity and invalid media before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = adapter(fetcher);
    await expect(
      provider.publish!(context, { accessToken: "access-secret" }, publishInput()),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
    for (const input of [
      publishInput({ media: [] }),
      publishInput({ caption: "x".repeat(2_201) }),
      publishInput({
        media: [
          {
            contentType: "image/png",
            fileSize: 100,
            mode: "remote_ingest",
            url: "https://assets.example/image.png",
          },
        ],
      }),
      publishInput({
        media: [
          {
            contentType: "image/jpeg",
            fileSize: 8 * 1024 * 1024 + 1,
            mode: "remote_ingest",
            url: "https://assets.example/image.jpg",
          },
        ],
      }),
      publishInput({
        media: Array.from({ length: 11 }, () => ({
          contentType: "image/jpeg",
          fileSize: 100,
          mode: "remote_ingest" as const,
          url: "https://assets.example/image.jpg",
        })),
      }),
    ]) {
      await expect(provider.publish!(context, credentials, input)).rejects.toBeInstanceOf(
        ProviderAdapterError,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("looks up confirmed media and returns a sanitized permalink", async () => {
    const providerCalls = sequence(() =>
      json({
        id: "media-1",
        permalink: "https://www.instagram.com/p/media-1/",
      }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-1",
        providerPostId: "media-1",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:container-1",
        providerPostId: "media-1",
        providerUrl: "https://www.instagram.com/p/media-1/",
      },
      state: "published",
    });
    expect(provider.cancelPublication).toBeUndefined();
  });

  it("normalizes media insights and cursor-paginated comments", async () => {
    const providerCalls = sequence(
      () =>
        json({
          data: [
            { name: "views", values: [{ value: 42 }] },
            { name: "reach", total_value: { value: 30 } },
            { name: "likes", values: [{ value: 8 }] },
            { name: "comments", values: [{ value: 3 }] },
            { name: "shares", values: [{ value: 2 }] },
          ],
        }),
      () =>
        json({
          data: [
            {
              from: { id: "author-1", username: "commenter" },
              id: "comment-1",
              text: "Great post",
              timestamp: "2026-07-18T20:00:00+0000",
            },
          ],
          paging: { cursors: { after: "next-cursor" } },
        }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.listAnalytics!(context, credentials, { providerPostId: "media-1" }, { limit: 100 }),
    ).resolves.toEqual({
      items: [
        {
          comments: 3,
          impressions: 0,
          likes: 8,
          providerPostId: "media-1",
          reach: 30,
          recordedAt: "2026-07-19T00:00:00.000Z",
          shares: 2,
          views: 42,
          watchTimeSeconds: 0,
        },
      ],
    });
    await expect(
      provider.listComments!(
        context,
        credentials,
        { providerPostId: "media-1" },
        { cursor: "current-cursor", limit: 10 },
      ),
    ).resolves.toEqual({
      items: [
        {
          authorDisplayName: "commenter",
          body: "Great post",
          commentedAt: "2026-07-18T20:00:00.000Z",
          providerCommentId: "comment-1",
          providerPostId: "media-1",
        },
      ],
      nextCursor: "next-cursor",
    });
    expect(providerCalls.calls[1]!.url.searchParams.get("after")).toBe("current-cursor");
  });

  it("replies publicly and refreshes a long-lived token", async () => {
    const providerCalls = sequence(
      (_url, init) => {
        expect(init.body).toBe(JSON.stringify({ message: "Thank you" }));
        return json({ id: "reply-1" });
      },
      (url) => {
        expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
        expect(url.searchParams.get("access_token")).toBe("refresh-secret");
        return json({
          access_token: "refreshed-secret",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.reply!(context, credentials, {
        idempotencyKey: "reply-operation-1",
        providerCommentId: "comment-1",
        text: "Thank you",
      }),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerPostId: "reply-1",
    });
    await expect(provider.refreshAccessToken!(context, "refresh-secret")).resolves.toEqual({
      accessToken: "refreshed-secret",
      expiresAt: "2026-09-17T00:00:00.000Z",
      refreshToken: "refreshed-secret",
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ],
    });
  });

  it("can expose publishing without prematurely claiming engagement", () => {
    const provider = adapter(vi.fn<typeof fetch>(), undefined, false);
    expect(provider.capability).toMatchObject({
      analytics: false,
      comments: false,
      publish: true,
      reply: false,
    });
    expect(provider.listAnalytics).toBeUndefined();
    expect(provider.listComments).toBeUndefined();
    expect(provider.reply).toBeUndefined();
    expect(
      new URL(
        provider.authorizationUrl!({
          codeChallenge: "unused",
          redirectUri,
          state: "oauth-state",
        }),
      ).searchParams.get("scope"),
    ).toBe("instagram_business_basic,instagram_business_content_publish");
  });
});
