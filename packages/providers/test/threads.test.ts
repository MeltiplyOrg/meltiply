import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadsAdapter,
  ProviderAdapterError,
  type ProviderRequestContext,
  type PublishInput,
} from "../src";

const context: ProviderRequestContext = {
  operationId: "operation-1",
  requestId: "request-1",
};
const credentials = { accessToken: "access-secret" };
const redirectUri = "https://api.example.com/api/v1/platforms/threads/callback";

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

function adapter(fetcher: typeof fetch, now = new Date("2026-07-19T00:00:00Z")) {
  return createThreadsAdapter({
    clientId: "threads-client",
    clientSecret: "threads-client-secret",
    fetch: fetcher,
    now: () => now,
    redirectUri,
    timeoutMilliseconds: 100,
  });
}

function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A Threads post",
    hashtags: [],
    idempotencyKey: "publish-1",
    media: [],
    ...patch,
  };
}

describe("createThreadsAdapter", () => {
  it.each([
    { gif_attachment: { gif_id: "native-gif", provider: "GIPHY" as const } },
    { text_attachment: { plaintext: "A long-text attachment with no teaser caption" } },
  ])("creates provider-hosted content without inventing a teaser caption: %j", async (options) => {
    const calls = sequence((url) => {
      expect(url.searchParams.get("media_type")).toBe("TEXT");
      expect(url.searchParams.has("text")).toBe(false);
      return json({ id: "native-container" });
    });
    await expect(
      adapter(calls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "",
          providerOptions: { threads: options },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed_success",
      providerOperationId: "created:native-container",
    });
  });

  it("rejects overlapping long-text styling before creating a remote container", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).publish!(
        context,
        credentials,
        publishInput({
          providerOptions: {
            threads: {
              text_attachment: {
                plaintext: "A long-text attachment",
                text_with_styling_info: [
                  { offset: 0, length: 6, styling_info: ["bold"] },
                  { offset: 5, length: 4, styling_info: ["italic"] },
                ],
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ failure: { code: "threads_publish_options_invalid" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not substitute an ordinary Post for incomplete ghost intent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).publish!(
        context,
        credentials,
        publishInput({
          providerOptions: { threads: { post_type: "ghost" } },
        }),
      ),
    ).rejects.toMatchObject({ failure: { code: "threads_publish_options_invalid" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains primary publication when Instagram cross-sharing fails", async () => {
    const calls = sequence(
      () => json({ id: "container-one" }),
      () => json({ id: "container-one", status: "FINISHED" }),
      () => json({ id: "threads-published", crossreshare_to_ig_status: "FAILED" }),
    );
    const provider = adapter(calls.fetcher);
    const submitted = await provider.publish!(
      context,
      credentials,
      publishInput({
        providerOptions: { threads: { crossreshare_to_ig: true } },
      }),
    );
    await expect(
      provider.lookupPublication!(context, credentials, submitted),
    ).resolves.toMatchObject({
      state: "published",
      result: {
        outcome: "confirmed_success",
        providerPostId: "threads-published",
        warnings: ["instagram_crossshare_failed"],
      },
    });
  });

  it.each([
    { poll_attachment: { option_a: "A", option_b: "B", option_c: "C" } },
    { gif_attachment: { gif_id: "giphy-one", provider: "GIPHY" as const } },
    { text_attachment: { plaintext: "An essay ".repeat(1000) } },
    { is_ghost_post: true },
    { quote_post_id: "quoted-one" },
    { reply_to_id: "parent-one" },
  ])("creates the native content form %j without losing its options", async (options) => {
    const calls = sequence((url) => {
      expect(url.pathname).toBe("/me/threads");
      for (const [key, value] of Object.entries(options)) {
        expect(url.searchParams.get(key)).toBe(
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
      }
      return json({ id: "container-one" });
    });
    await expect(
      adapter(calls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          providerOptions: { threads: options },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed_success",
      providerOperationId: "created:container-one",
    });
  });

  it("reposts the specified source without creating a text container", async () => {
    const calls = sequence((url) => {
      expect(url.pathname).toBe("/source-one/repost");
      return json({ id: "repost-one" });
    });
    await expect(
      adapter(calls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "",
          providerOptions: { threads: { repost_id: "source-one" } },
        }),
      ),
    ).resolves.toEqual({ outcome: "confirmed_success", providerPostId: "repost-one" });
  });

  it("rejects poll and long-text combinations before creating remote content", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).publish!(
        context,
        credentials,
        publishInput({
          providerOptions: {
            threads: {
              poll_attachment: { option_a: "A", option_b: "B" },
              text_attachment: { plaintext: "Not valid together" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ failure: { code: "threads_publish_options_invalid" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("builds a state-bound authorization URL and pins the callback", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    const value = provider.authorizationUrl!({
      codeChallenge: "unused-by-threads",
      redirectUri,
      state: "oauth-state",
    });
    const url = new URL(value);
    expect(url.origin).toBe("https://threads.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "threads-client",
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "threads_basic,threads_content_publish,threads_delete,threads_location_tagging,threads_share_to_instagram,threads_keyword_search,threads_manage_mentions,threads_manage_insights,threads_manage_replies,threads_read_replies",
      state: "oauth-state",
    });
    expect(() =>
      provider.authorizationUrl!({
        codeChallenge: "unused-by-threads",
        redirectUri: "https://attacker.example/callback",
        state: "oauth-state",
      }),
    ).toThrow("does not match configuration");
  });

  it("exchanges a code for a long-lived token and bounded profile", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.origin).toBe("https://graph.threads.com");
        expect(init.method).toBe("POST");
        expect(String(init.body)).toContain("client_secret=threads-client-secret");
        return json({ access_token: "short-secret", user_id: 12345 });
      },
      (url) => {
        expect(url.origin).toBe("https://graph.threads.com");
        expect(url.searchParams.get("access_token")).toBe("short-secret");
        return json({
          access_token: "long-secret",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
      (_url, init) => {
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer long-secret");
        return json({
          id: "12345",
          name: "Threads Creator Name",
          threads_profile_picture_url: "https://cdn.example/avatar.jpg",
          username: "creator",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v1.0/debug_token");
        expect(new Headers(init.headers).get("Authorization")).toBe(
          "Bearer TH|threads-client|threads-client-secret",
        );
        return json({
          data: {
            is_valid: true,
            user_id: "12345",
            scopes: ["threads_basic", "threads_content_publish"],
          },
        });
      },
    );
    const connection = await adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
      code: "authorization-code",
      codeVerifier: "unused-by-threads",
      redirectUri,
    });

    expect(connection).toEqual({
      accessToken: "long-secret",
      account: {
        avatarUrl: "https://cdn.example/avatar.jpg",
        displayName: "Threads Creator Name",
        id: "12345",
        username: "creator",
      },
      expiresAt: "2026-09-17T00:00:00.000Z",
      refreshToken: "long-secret",
      scopes: ["threads_basic", "threads_content_publish"],
    });
    expect(providerCalls.calls[0]!.url.search).toBe("");
    expect(providerCalls.calls[0]!.url.toString()).not.toContain("threads-client-secret");
    expect(providerCalls.calls[1]!.url.searchParams.get("client_secret")).toBe(
      "threads-client-secret",
    );
    expect(providerCalls.calls[2]!.url.searchParams.get("fields")).toBe(
      "id,username,name,threads_profile_picture_url",
    );
  });

  it("waits for text-container readiness before publishing the retained container", async () => {
    const providerCalls = sequence(
      () => json({ id: "container-1" }),
      () => json({ id: "container-1", status: "IN_PROGRESS" }),
      () => json({ id: "container-1", status: "FINISHED" }),
      (url) => {
        expect(url.searchParams.get("creation_id")).toBe("container-1");
        return json({ id: "post-1" });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    const result = await provider.publish!(
      context,
      credentials,
      publishInput({ caption: "Hello #launch", hashtags: ["launch"] }),
    );
    expect(result).toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:container-1",
    });
    await expect(provider.lookupPublication!(context, credentials, result)).resolves.toEqual({
      state: "processing",
      providerOperationId: "created:container-1",
    });
    await expect(provider.lookupPublication!(context, credentials, result)).resolves.toMatchObject({
      state: "published",
      result: { providerPostId: "post-1" },
    });
    expect(providerCalls.calls.filter(({ init }) => init.method === "POST")).toHaveLength(2);
  });

  it("creates an image container without publishing before readiness", async () => {
    const providerCalls = sequence(() => json({ id: "container-image" }));
    await expect(
      adapter(providerCalls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "Image post",
          media: [
            {
              contentType: "image/jpeg",
              fileSize: 1024,
              mode: "remote_ingest",
              url: "https://assets.example/image.jpg?X-Signature=secret",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:container-image",
    });

    expect(providerCalls.calls).toHaveLength(1);
    expect(providerCalls.calls[0]!.url.searchParams.get("media_type")).toBe("IMAGE");
    expect(providerCalls.calls[0]!.url.searchParams.get("image_url")).toBe(
      "https://assets.example/image.jpg?X-Signature=secret",
    );
  });

  it("waits for video container readiness and finalizes it exactly once", async () => {
    const providerCalls = sequence(
      () => json({ id: "container-video" }),
      () => json({ id: "container-video", status: "IN_PROGRESS" }),
      () => json({ id: "container-video", status: "FINISHED" }),
      () => json({ id: "post-video" }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({
          caption: "Video post",
          media: [
            {
              contentType: "video/mp4",
              fileSize: 20 * 1024 * 1024,
              mode: "remote_ingest",
              url: "https://assets.example/video.mp4",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:container-video",
    });
    expect(providerCalls.calls[0]!.url.searchParams.get("media_type")).toBe("VIDEO");
    expect(providerCalls.calls[0]!.url.searchParams.get("video_url")).toBe(
      "https://assets.example/video.mp4",
    );

    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-video",
      }),
    ).resolves.toEqual({
      providerOperationId: "created:container-video",
      state: "processing",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-video",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:container-video",
        providerPostId: "post-video",
      },
      state: "published",
    });
    expect(providerCalls.calls.map(({ url }) => url.pathname)).toEqual([
      "/me/threads",
      "/container-video",
      "/container-video",
      "/me/threads_publish",
    ]);
    expect(providerCalls.calls[3]!.url.searchParams.get("creation_id")).toBe("container-video");
  });

  it("records a submitted container and never republishes it", async () => {
    const providerCalls = sequence(
      () => json({ id: "container-lost" }),
      () => json({ id: "container-lost", status: "FINISHED" }),
      async () => {
        throw new Error("connection lost after publish write");
      },
      () => json({ id: "container-lost", status: "FINISHED" }),
      () => json({ id: "container-lost", status: "PUBLISHED" }),
    );
    const provider = adapter(providerCalls.fetcher);
    await provider.publish!(
      context,
      credentials,
      publishInput({
        media: [
          {
            contentType: "video/mp4",
            fileSize: 1024,
            mode: "remote_ingest",
            url: "https://assets.example/video.mp4",
          },
        ],
      }),
    );
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:container-lost",
      }),
    ).resolves.toMatchObject({
      result: {
        failure: { classification: "ambiguous" },
        outcome: "unknown",
        providerOperationId: "submitted:container-lost",
      },
      state: "unknown",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "submitted:container-lost",
      }),
    ).resolves.toMatchObject({
      result: {
        failure: { code: "threads_publish_evidence_missing" },
        outcome: "unknown",
        providerOperationId: "submitted:container-lost",
      },
      state: "unknown",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "submitted:container-lost",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "submitted:container-lost",
      },
      state: "published",
    });
    expect(
      providerCalls.calls.filter(({ url }) => url.pathname.endsWith("/threads_publish")),
    ).toHaveLength(1);
  });

  it("allows ordinary in-text hashtags beyond the one native topic tag", async () => {
    const calls = sequence(() => json({ id: "tagged-container" }));
    await expect(
      adapter(calls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "Launch #one #two",
          hashtags: ["one", "two"],
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed_success",
      providerOperationId: "created:tagged-container",
    });
  });

  it("rejects unsupported media, oversize images, and excessive content locally", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = adapter(fetcher);
    const invalidInputs: PublishInput[] = [
      publishInput({ caption: "x".repeat(501) }),
      publishInput({
        media: [
          {
            body: new ReadableStream<Uint8Array>(),
            contentType: "image/jpeg",
            fileSize: 100,
            mode: "byte_upload",
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
        caption: "  ",
        hashtags: [],
        media: [],
      }),
      publishInput({
        media: Array.from({ length: 21 }, () => ({
          contentType: "image/jpeg" as const,
          fileSize: 100,
          mode: "remote_ingest" as const,
          url: "https://assets.example/image.jpg",
        })),
      }),
    ];
    for (const input of invalidInputs) {
      await expect(provider.publish!(context, credentials, input)).rejects.toBeInstanceOf(
        ProviderAdapterError,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  /**
   * Strict Threads container creation fixture that models Meta Graph API requirements:
   * child containers must be marked is_carousel_item=true with a valid media_type discriminator
   * (IMAGE with image_url, or VIDEO with video_url), while carousel parent containers must specify
   * media_type=CAROUSEL with comma-separated children ids. Rejects omitted or mismatched
   * discriminators with HTTP 400.
   */
  function strictThreadsContainer(expectedId: string): Responder {
    return (url) => {
      const isCarouselItem = url.searchParams.get("is_carousel_item");
      const mediaType = url.searchParams.get("media_type");
      if (isCarouselItem === "true") {
        const hasImage = url.searchParams.has("image_url");
        const hasVideo = url.searchParams.has("video_url");
        if (mediaType === "IMAGE" && hasImage && !hasVideo) {
          return json({ id: expectedId });
        }
        if (mediaType === "VIDEO" && hasVideo && !hasImage) {
          return json({ id: expectedId });
        }
        return json(
          {
            error: {
              code: 100,
              message:
                "Threads container rejected: carousel items require media_type (IMAGE with image_url or VIDEO with video_url)",
              type: "OAuthException",
            },
          },
          { status: 400 },
        );
      }
      if (mediaType === "CAROUSEL") {
        const children = url.searchParams.get("children");
        if (!children) {
          return json(
            {
              error: {
                code: 100,
                message: "Threads container rejected: CAROUSEL requires children",
                type: "OAuthException",
              },
            },
            { status: 400 },
          );
        }
        return json({ id: expectedId });
      }
      return json({ id: expectedId });
    };
  }

  it("creates one item container per attachment and binds them in creator order", async () => {
    const providerCalls = sequence(
      strictThreadsContainer("item-1"),
      strictThreadsContainer("item-2"),
      strictThreadsContainer("carousel-parent"),
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "Carousel post",
          media: [
            {
              contentType: "image/jpeg",
              fileSize: 100,
              mode: "remote_ingest",
              url: "https://assets.example/one.jpg",
            },
            {
              contentType: "video/mp4",
              fileSize: 1024,
              mode: "remote_ingest",
              url: "https://assets.example/two.mp4",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:carousel-parent",
    });

    expect(providerCalls.calls).toHaveLength(3);
    // Items stay unpublished and carry no text; the parent owns the post text.
    // Child containers require the IMAGE or VIDEO discriminator alongside is_carousel_item.
    expect(Object.fromEntries(providerCalls.calls[0]!.url.searchParams)).toEqual({
      image_url: "https://assets.example/one.jpg",
      is_carousel_item: "true",
      media_type: "IMAGE",
    });
    expect(Object.fromEntries(providerCalls.calls[1]!.url.searchParams)).toEqual({
      is_carousel_item: "true",
      media_type: "VIDEO",
      video_url: "https://assets.example/two.mp4",
    });
    expect(Object.fromEntries(providerCalls.calls[2]!.url.searchParams)).toEqual({
      children: "item-1,item-2",
      media_type: "CAROUSEL",
      text: "Carousel post",
    });
  });

  // A rejected item container must stop the carousel where it failed: the
  // provider error surfaces unchanged and no later item or parent container is
  // created, so a partially created carousel never looks publishable.
  it("surfaces a provider rejection and halts carousel creation on the first failed item", async () => {
    const providerCalls = sequence(() =>
      json(
        {
          error: {
            code: 100,
            message: "Param media_type must be IMAGE or VIDEO for carousel items",
            type: "OAuthException",
          },
        },
        { status: 400 },
      ),
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          caption: "Carousel post",
          media: [
            {
              contentType: "image/jpeg",
              fileSize: 100,
              mode: "remote_ingest",
              url: "https://assets.example/one.jpg",
            },
            {
              contentType: "video/mp4",
              fileSize: 1024,
              mode: "remote_ingest",
              url: "https://assets.example/two.mp4",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
    expect(providerCalls.calls).toHaveLength(1);
  });

  it.each([
    ["IN_PROGRESS", "processing"],
    ["FINISHED", "unknown"],
    ["PUBLISHED", "published"],
    ["ERROR", "failed"],
    ["EXPIRED", "failed"],
  ] as const)(
    "maps a submitted container %s to %s without republishing",
    async (providerStatus, state) => {
      const providerCalls = sequence(() =>
        json({
          error_message: "provider detail must remain private",
          id: "container-lookup",
          status: providerStatus,
        }),
      );
      const result = await adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "submitted:container-lookup",
      });
      expect(result.state).toBe(state);
      expect(JSON.stringify(result)).not.toContain("provider detail");
      expect(providerCalls.calls).toHaveLength(1);
      expect(providerCalls.calls[0]!.url.searchParams.get("fields")).toBe(
        "id,status,error_message",
      );
    },
  );

  it.each([
    [
      "Failed to fetch video at https://media.example/private?token=abc123",
      "threads_container_media_retrieval",
    ],
    [
      "Unable to retrieve the video while processing the container",
      "threads_container_media_retrieval",
    ],
    ["The video format is not supported for this container", "threads_container_media_format"],
    ["Video duration 900 seconds exceeds the allowed maximum", "threads_container_media_duration"],
    ["The media aspect ratio is not supported", "threads_container_media_dimensions"],
    ["Unexpected processing failure", "threads_container_error"],
  ] as const)("normalizes container error detail %j to %s", async (detail, code) => {
    const providerCalls = sequence(() =>
      json({ error_message: detail, id: "container-error", status: "ERROR" }),
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

  it("looks up a published post and treats HTTP 404 as not found", async () => {
    const foundCalls = sequence(() =>
      json({
        id: "post-lookup",
        permalink: "https://www.threads.net/@creator/post/abc",
      }),
    );
    await expect(
      adapter(foundCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "created:container-lookup",
        providerPostId: "post-lookup",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:container-lookup",
        providerPostId: "post-lookup",
        providerUrl: "https://www.threads.net/@creator/post/abc",
      },
      state: "published",
    });

    const missingCalls = sequence(() => json({ error: { message: "private" } }, { status: 404 }));
    await expect(
      adapter(missingCalls.fetcher).lookupPublication!(context, credentials, {
        providerPostId: "post-missing",
      }),
    ).resolves.toEqual({ state: "not_found" });
  });

  it("confirms the matching published Post when Meta withholds its permalink", async () => {
    const calls = sequence(() => json({ id: "copyright-restricted-post" }));
    await expect(
      adapter(calls.fetcher).lookupPublication!(context, credentials, {
        providerPostId: "copyright-restricted-post",
      }),
    ).resolves.toEqual({
      state: "published",
      result: { outcome: "confirmed_success", providerPostId: "copyright-restricted-post" },
    });
  });

  it("deletes a published post idempotently and does not guess from a live container", async () => {
    const deletedCalls = sequence(() => json({ deleted_id: "post-delete", success: true }));
    await expect(
      adapter(deletedCalls.fetcher).cancelPublication!(context, credentials, {
        providerOperationId: "created:container-delete",
        providerPostId: "post-delete",
      }),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:container-delete",
      providerPostId: "post-delete",
    });
    expect(deletedCalls.calls[0]!.init.method).toBe("DELETE");

    const missingCalls = sequence(() => json({}, { status: 404 }));
    await expect(
      adapter(missingCalls.fetcher).cancelPublication!(context, credentials, {
        providerPostId: "post-delete",
      }),
    ).resolves.toMatchObject({ outcome: "confirmed_success" });

    const containerCalls = sequence(() => json({ id: "container-live", status: "PUBLISHED" }));
    await expect(
      adapter(containerCalls.fetcher).cancelPublication!(context, credentials, {
        providerOperationId: "created:container-live",
      }),
    ).resolves.toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "unknown",
      providerOperationId: "created:container-live",
    });
    expect(containerCalls.calls[0]!.init.method).toBe("GET");
  });

  it("normalizes post insights without inventing reach or impressions", async () => {
    const providerCalls = sequence(() =>
      json({
        data: [
          { name: "views", values: [{ value: 101 }] },
          { name: "likes", values: [{ value: 12 }] },
          { name: "replies", values: [{ value: 3 }] },
          { name: "reposts", values: [{ value: 4 }] },
          { name: "quotes", values: [{ value: 5 }] },
          { name: "shares", values: [{ value: 6 }] },
        ],
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "post-insights" },
        { limit: 1 },
      ),
    ).resolves.toEqual({
      items: [
        {
          comments: 3,
          impressions: 0,
          likes: 12,
          providerPostId: "post-insights",
          reach: 0,
          recordedAt: "2026-07-19T00:00:00.000Z",
          shares: 15,
          views: 101,
          watchTimeSeconds: 0,
        },
      ],
    });
    expect(providerCalls.calls[0]!.url.pathname).toBe("/post-insights/insights");
    expect(providerCalls.calls[0]!.url.searchParams.get("metric")).toBe(
      "views,likes,replies,reposts,quotes,shares",
    );
  });

  it("returns flattened conversation replies with an opaque next cursor", async () => {
    const providerCalls = sequence(() =>
      json({
        data: [
          {
            id: "reply-1",
            profile_picture_url: "https://cdn.example/reply-avatar.jpg",
            text: "First reply",
            timestamp: "2024-09-17T20:54:47+0000",
            username: "reader",
          },
          {
            id: "reply-2",
            text: "",
            timestamp: "2024-09-17T20:55:47+0000",
          },
        ],
        paging: { cursors: { after: "opaque+/cursor==" } },
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).listComments!(
        context,
        credentials,
        { providerPostId: "post-comments" },
        { cursor: "previous+/cursor==", limit: 2 },
      ),
    ).resolves.toEqual({
      items: [
        {
          authorAvatarUrl: "https://cdn.example/reply-avatar.jpg",
          authorDisplayName: "reader",
          body: "First reply",
          commentedAt: "2024-09-17T20:54:47.000Z",
          providerCommentId: "reply-1",
          providerPostId: "post-comments",
        },
        {
          body: "",
          commentedAt: "2024-09-17T20:55:47.000Z",
          providerCommentId: "reply-2",
          providerPostId: "post-comments",
        },
      ],
      nextCursor: "opaque+/cursor==",
    });
    const request = providerCalls.calls[0]!.url;
    expect(request.pathname).toBe("/post-comments/conversation");
    expect(request.searchParams.get("after")).toBe("previous+/cursor==");
    expect(request.searchParams.get("limit")).toBe("2");
    expect(request.searchParams.get("reverse")).toBe("false");
  });

  it("rejects malformed metrics, duplicate comments, and unsupported cursors", async () => {
    const malformedMetrics = sequence(() =>
      json({
        data: [
          { name: "views", values: [{ value: 1 }] },
          { name: "views", values: [{ value: 2 }] },
        ],
      }),
    );
    await expect(
      adapter(malformedMetrics.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "post-1" },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({
      failure: { classification: "transient" },
    });

    const duplicateComments = sequence(() =>
      json({
        data: [
          { id: "reply-1", text: "one", timestamp: "2026-07-19T00:00:00Z" },
          { id: "reply-1", text: "two", timestamp: "2026-07-19T00:00:01Z" },
        ],
      }),
    );
    await expect(
      adapter(duplicateComments.fetcher).listComments!(
        context,
        credentials,
        { providerPostId: "post-1" },
        { limit: 2 },
      ),
    ).rejects.toMatchObject({
      failure: { classification: "transient" },
    });

    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "post-1" },
        { cursor: "not-supported", limit: 1 },
      ),
    ).rejects.toMatchObject({
      failure: { classification: "deterministic" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("publishes replies through the same readiness-gated container flow", async () => {
    const providerCalls = sequence(
      () => json({ id: "reply-container" }),
      () => json({ id: "reply-container", status: "FINISHED" }),
      () => json({ id: "reply-post" }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.reply!(context, credentials, {
        idempotencyKey: "reply-operation",
        providerCommentId: "comment-1",
        text: "Thanks for reading",
      }),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "created:reply-container",
    });
    expect(Object.fromEntries(providerCalls.calls[0]!.url.searchParams)).toEqual({
      media_type: "TEXT",
      reply_to_id: "comment-1",
      text: "Thanks for reading",
    });

    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "created:reply-container",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:reply-container",
        providerPostId: "reply-post",
      },
      state: "published",
    });
    expect(providerCalls.calls.map(({ url }) => url.pathname)).toEqual([
      "/me/threads",
      "/reply-container",
      "/me/threads_publish",
    ]);
  });

  it("refreshes a Threads long-lived access token", async () => {
    const providerCalls = sequence(
      (url) => {
        expect(url.origin).toBe("https://graph.threads.com");
        expect(url.searchParams.get("grant_type")).toBe("th_refresh_token");
        expect(url.searchParams.get("access_token")).toBe("current-long-token");
        return json({
          access_token: "refreshed-long-token",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
      () =>
        json({
          data: {
            is_valid: true,
            user_id: "12345",
            scopes: ["threads_basic", "threads_content_publish"],
          },
        }),
    );
    await expect(
      adapter(providerCalls.fetcher).refreshAccessToken!(context, "current-long-token"),
    ).resolves.toEqual({
      accessToken: "refreshed-long-token",
      expiresAt: "2026-09-17T00:00:00.000Z",
      refreshToken: "refreshed-long-token",
      scopes: ["threads_basic", "threads_content_publish"],
    });
    expect(providerCalls.calls[0]!.url.pathname).toBe("/refresh_access_token");
  });
});
