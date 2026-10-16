import { describe, expect, it, vi } from "vite-plus/test";

import {
  createYouTubeAdapter,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderRequestContext,
  type ProviderMediaMetadata,
  type ProviderStreamMedia,
  type PublishInput,
} from "../src";

const context: ProviderRequestContext = {
  operationId: "operation-1",
  requestId: "request-1",
};
const credentials = {
  accessToken: "access-secret",
  accountId: "channel-1",
};
const redirectUri = "https://api.example.com/api/v1/platforms/youtube/callback";

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

/**
 * Builds the YouTube adapter under test with deterministic credentials, redirect
 * URI, and a 100 ms timeout so each spec only supplies its scripted `fetch`
 * double. `now` fixes the adapter clock (default 2026-07-19) for stable expiry
 * math; `uploadChunkBytes`, when given, overrides the resumable-upload chunk
 * size. Returns the real adapter wired to the test doubles, not a mock.
 */
function adapter(
  fetcher: typeof fetch,
  now = new Date("2026-07-19T00:00:00Z"),
  uploadChunkBytes?: number,
) {
  return createYouTubeAdapter({
    clientId: "youtube-client",
    clientSecret: "youtube-client-secret",
    fetch: fetcher,
    now: () => now,
    redirectUri,
    timeoutMilliseconds: 100,
    ...(uploadChunkBytes === undefined ? {} : { uploadChunkBytes }),
  });
}

function stream(bytes = new Uint8Array([1, 2, 3, 4])) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A square Short\nLaunch description #launch",
    hashtags: ["launch"],
    idempotencyKey: "publish-1",
    media: [
      {
        body: stream(),
        contentType: "video/mp4",
        fileSize: 4,
        metadata: {
          durationSeconds: 179.5,
          height: 1080,
          width: 1080,
        },
        mode: "resumable_upload",
      },
    ],
    ...patch,
  };
}

/** One resumable attachment carrying the given verified facts. */
function shot(metadata: ProviderMediaMetadata | undefined): ProviderStreamMedia {
  return {
    body: stream(),
    contentType: "video/mp4",
    fileSize: 4,
    ...(metadata ? { metadata } : {}),
    mode: "resumable_upload",
  };
}

function video(
  id: string,
  patch: Partial<{
    channelId: string;
    privacyStatus: string;
    processingStatus: string;
    uploadStatus: string;
  }> = {},
) {
  const status = {
    channelId: "channel-1",
    privacyStatus: "public",
    processingStatus: "processing",
    uploadStatus: "uploaded",
    ...patch,
  };
  return {
    id,
    processingDetails: { processingStatus: status.processingStatus },
    snippet: { channelId: status.channelId },
    status: {
      privacyStatus: status.privacyStatus,
      uploadStatus: status.uploadStatus,
    },
  };
}

describe("createYouTubeAdapter", () => {
  it("advertises only the implemented YouTube Shorts candidate subset", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    expect(provider.capability).toMatchObject({
      analytics: false,
      asset_types: ["video"],
      comments: false,
      connect_available: true,
      max_caption_length: 5_000,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 15,
      max_video_duration_sec: 180,
      max_media_count: 1,
      min_media_count: 1,
      multi_asset_types: [],
      platform: "youtube",
      publish: true,
      reply: false,
    });
    expect(provider.transferModes).toEqual(["resumable_upload"]);
    expect(provider.listAnalytics).toBeUndefined();
    expect(provider.listComments).toBeUndefined();
    expect(provider.reply).toBeUndefined();
    expect(provider.cancelPublication).toBeUndefined();
    const registry = new ProviderRegistry();
    expect(() => registry.register("youtube", provider)).not.toThrow();
  });

  it("builds an offline, PKCE-bound Google authorization URL", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    const url = new URL(
      provider.authorizationUrl!({
        codeChallenge: "a".repeat(43),
        redirectUri,
        state: "oauth-state",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_type: "offline",
      client_id: "youtube-client",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      include_granted_scopes: "true",
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      state: "oauth-state",
    });
    expect(() =>
      provider.authorizationUrl!({
        codeChallenge: "a".repeat(43),
        redirectUri: "https://attacker.example/callback",
        state: "oauth-state",
      }),
    ).toThrow("does not match configuration");
  });

  it("exchanges a code and binds the connection to one YouTube channel", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.toString()).toBe("https://oauth2.googleapis.com/token");
        expect(String(init.body)).toContain("code=authorization-code");
        expect(String(init.body)).toContain(`code_verifier=${"b".repeat(43)}`);
        return json({
          access_token: "access-secret",
          expires_in: 3_600,
          refresh_token: "refresh-secret",
          scope:
            "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/youtube/v3/channels");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          maxResults: "2",
          mine: "true",
          part: "id,snippet",
        });
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-secret");
        return json({
          items: [
            {
              id: "channel-1",
              snippet: {
                thumbnails: {
                  default: { url: "https://cdn.example/channel.jpg" },
                },
                customUrl: "@meltiply",
                title: "Meltiply Channel",
              },
            },
          ],
        });
      },
    );

    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "b".repeat(43),
        redirectUri,
      }),
    ).resolves.toEqual({
      accessToken: "access-secret",
      account: {
        avatarUrl: "https://cdn.example/channel.jpg",
        displayName: "Meltiply Channel",
        id: "channel-1",
        username: "meltiply",
      },
      expiresAt: "2026-07-19T01:00:00.000Z",
      refreshToken: "refresh-secret",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
    });
  });

  it("fails closed when the authorized YouTube channel is not unique", async () => {
    const providerCalls = sequence(
      () =>
        json({
          access_token: "access-secret",
          expires_in: 3_600,
          refresh_token: "refresh-secret",
          token_type: "Bearer",
        }),
      () => json({ items: [] }),
    );
    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "b".repeat(43),
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: {
        classification: "deterministic",
        code: "youtube_channel_selection_required",
      },
    });
  });

  it("rejects an exchange response that explicitly omits a required scope", async () => {
    const providerCalls = sequence(() =>
      json({
        access_token: "access-secret",
        expires_in: 3_600,
        refresh_token: "refresh-secret",
        scope: "https://www.googleapis.com/auth/youtube.upload",
        token_type: "Bearer",
      }),
    );
    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "b".repeat(43),
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: { classification: "transient", code: "provider_transient" },
    });
    expect(providerCalls.calls).toHaveLength(1);
  });

  it("initiates and completes a full resumable upload without buffering", async () => {
    const body = stream();
    const providerCalls = sequence(
      (url, init) => {
        expect(url.pathname).toBe("/upload/youtube/v3/videos");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          part: "snippet,status",
          uploadType: "resumable",
        });
        expect(new Headers(init.headers).get("X-Upload-Content-Length")).toBe("4");
        expect(new Headers(init.headers).get("X-Upload-Content-Type")).toBe("video/mp4");
        expect(JSON.parse(String(init.body))).toEqual({
          snippet: {
            categoryId: "22",
            description: "A square Short\nLaunch description #launch",
            tags: ["launch"],
            title: "A square Short",
          },
          status: { privacyStatus: "public" },
        });
        return new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        });
      },
      (url, init) => {
        expect(url.origin).toBe("https://www.googleapis.com");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          part: "snippet,status",
          uploadType: "resumable",
          upload_id: "upload_1",
        });
        expect(init.body).toBeInstanceOf(Uint8Array);
        expect([...(init.body as Uint8Array)]).toEqual([1, 2, 3, 4]);
        expect(new Headers(init.headers).get("Content-Length")).toBe("4");
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-3/4");
        expect(new Headers(init.headers).get("Content-Type")).toBe("video/mp4");
        return json({ id: "video-1" }, { status: 201 });
      },
    );

    await expect(
      adapter(providerCalls.fetcher).publish!(
        context,
        credentials,
        publishInput({
          media: [
            {
              body,
              contentType: "video/mp4",
              fileSize: 4,
              metadata: {
                durationSeconds: 179.5,
                height: 1080,
                width: 1080,
              },
              mode: "resumable_upload",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "video:video-1",
    });
  });

  it.each([
    ["missing metadata", { media: [shot(undefined)] }],
    ["landscape media", { media: [shot({ durationSeconds: 60, height: 720, width: 1280 })] }],
    ["overlong media", { media: [shot({ durationSeconds: 181, height: 1080, width: 1080 })] }],
    ["an overlong title", { caption: "x".repeat(101) }],
    ["angle brackets", { caption: "A <Short>" }],
    ["no attachment at all", { media: [] }],
    [
      // YouTube uploads one video per post, so several attachments are rejected
      // rather than silently uploading only the first.
      "several attachments",
      {
        media: [
          shot({ durationSeconds: 60, height: 1080, width: 1080 }),
          shot({ durationSeconds: 60, height: 1080, width: 1080 }),
        ],
      },
    ],
  ] as const)("rejects %s before creating an upload session", async (_name, patch) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).publish!(context, credentials, publishInput(patch as Partial<PublishInput>)),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls processing until the channel-owned public Short is ready", async () => {
    const providerCalls = sequence(
      () => json({ items: [video("video-1")] }),
      () =>
        json({
          items: [
            video("video-1", {
              processingStatus: "succeeded",
              uploadStatus: "processed",
            }),
          ],
        }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "video:video-1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "video:video-1",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "video:video-1",
        providerPostId: "video-1",
        providerUrl: "https://www.youtube.com/shorts/video-1",
      },
      state: "published",
    });
  });

  it.each([
    ["processing failure", { processingStatus: "failed" }, "youtube_video_processing_failed"],
    ["channel mismatch", { channelId: "channel-2" }, "youtube_channel_mismatch"],
  ] as const)("fails a publication on %s", async (_name, patch, code) => {
    const providerCalls = sequence(() => json({ items: [video("video-1", patch)] }));
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "video:video-1",
      }),
    ).resolves.toMatchObject({
      result: { failure: { code }, outcome: "confirmed_failure" },
      state: "failed",
    });
  });

  it.each(["unlisted", "private"] as const)(
    "confirms a processed %s video as published",
    async (privacyStatus) => {
      const providerCalls = sequence(() =>
        json({
          items: [
            video("video-1", {
              privacyStatus,
              processingStatus: "succeeded",
              uploadStatus: "processed",
            }),
          ],
        }),
      );
      await expect(
        adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
          providerOperationId: "video:video-1",
        }),
      ).resolves.toMatchObject({
        result: {
          outcome: "confirmed_success",
          providerPostId: "video-1",
        },
        state: "published",
      });
    },
  );

  it("resumes an interrupted chunk after Google's acknowledged Range", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      () => {
        throw new TypeError("network reset");
      },
      (_url, init) => {
        expect(init.body).toBeUndefined();
        expect(new Headers(init.headers).get("Content-Length")).toBe("0");
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes */4");
        return new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        });
      },
      (_url, init) => {
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 2-3/4");
        expect(new Headers(init.headers).get("Content-Length")).toBe("2");
        expect([...(init.body as Uint8Array)]).toEqual([3, 4]);
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.publish!(context, credentials, publishInput())).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "video:video-1",
    });
    expect(providerCalls.calls).toHaveLength(4);
  });

  it("retains the acknowledged offset when the resume budget is exhausted", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-3" },
          status: 308,
        }),
    );
    const provider = adapter(providerCalls.fetcher);
    const published = await provider.publish!(context, credentials, publishInput());
    expect(published).toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "unknown",
      providerOperationId: "submitted:4:2:upload_1",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "submitted:4:2:upload_1",
      }),
    ).resolves.toMatchObject({
      result: {
        outcome: "unknown",
        providerOperationId: "submitted:4:4:upload_1",
      },
      state: "unknown",
    });
    expect(providerCalls.calls).toHaveLength(9);
  });

  it("uploads bounded aligned chunks instead of one unbounded request", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      (_url, init) => {
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-262143/300000");
        expect(new Headers(init.headers).get("Content-Length")).toBe("262144");
        return new Response(null, {
          headers: { Range: "bytes=0-262143" },
          status: 308,
        });
      },
      (_url, init) => {
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 262144-299999/300000");
        expect(new Headers(init.headers).get("Content-Length")).toBe("37856");
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    const provider = adapter(providerCalls.fetcher, new Date("2026-07-19T00:00:00Z"), 256 * 1024);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({
          media: [
            {
              body: stream(new Uint8Array(300_000)),
              contentType: "video/mp4",
              fileSize: 300_000,
              metadata: {
                durationSeconds: 179.5,
                height: 1080,
                width: 1080,
              },
              mode: "resumable_upload",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "video:video-1",
    });
    expect(providerCalls.calls).toHaveLength(3);
  });

  it("promotes a completed upload session to video processing", async () => {
    const providerCalls = sequence(() => json({ id: "video-1" }));
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        providerOperationId: "submitted:4:0:upload_1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
  });

  it.each(["unlisted", "private"] as const)(
    "sends configured %s privacy and made-for-kids in initiation",
    async (privacyStatus) => {
      const providerCalls = sequence(
        (_url, init) => {
          expect(JSON.parse(String(init.body))).toEqual({
            snippet: {
              categoryId: "22",
              description: "A square Short\nLaunch description #launch",
              tags: ["launch"],
              title: "A square Short",
            },
            status: { madeForKids: true, privacyStatus },
          });
          return new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
            },
          });
        },
        () => json({ id: "video-1" }, { status: 201 }),
      );
      await expect(
        adapter(providerCalls.fetcher).publish!(
          context,
          credentials,
          publishInput({
            providerOptions: {
              youtube: { madeForKids: true, privacyStatus },
            },
          }),
        ),
      ).resolves.toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-1",
      });
    },
  );

  it("rejects invalid YouTube publish options before initiating", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).publish!(
        context,
        credentials,
        publishInput({
          providerOptions: {
            youtube: {
              madeForKids: true,
              privacyStatus: "friends" as never,
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      failure: {
        classification: "deterministic",
        code: "youtube_publish_options_invalid",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["quotaExceeded", { classification: "quota", code: "youtube_quota_exceeded" }],
    ["dailyLimitExceeded", { classification: "quota", code: "youtube_quota_exceeded" }],
    ["userRateLimitExceeded", { classification: "rate_limit", code: "youtube_rate_limited" }],
    ["forbidden", { classification: "auth", code: "provider_http_403" }],
  ] as const)(
    "classifies a Google 403 %s reason distinctly without leaking the body",
    async (reason, expected) => {
      const providerCalls = sequence(() =>
        json(
          {
            error: {
              errors: [
                {
                  domain: "youtube.quota",
                  message: "token=must-not-leak https://private.example/x",
                  reason,
                },
              ],
            },
          },
          { status: 403 },
        ),
      );
      const error = await adapter(providerCalls.fetcher).publish!(
        context,
        credentials,
        publishInput(),
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect(error).toMatchObject({
        failure: {
          ...expected,
          retryable: expected.classification === "rate_limit",
        },
      });
      expect(JSON.stringify(error)).not.toMatch(/must-not-leak|private\.example/);
    },
  );

  it("rejects a resumable Location outside the exact Google session shape", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://attacker.example/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).rejects.toMatchObject({
      failure: { classification: "transient", code: "provider_transient" },
    });
    expect(providerCalls.calls).toHaveLength(1);
  });

  it("preserves an omitted refresh token and accepts explicit rotation", async () => {
    const providerCalls = sequence(
      () =>
        json({
          access_token: "access-2",
          expires_in: 3_600,
          token_type: "Bearer",
        }),
      () =>
        json({
          access_token: "access-3",
          expires_in: 7_200,
          refresh_token: "refresh-rotated",
          token_type: "Bearer",
        }),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.refreshAccessToken!(context, "refresh-original")).resolves.toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-original",
    });
    await expect(provider.refreshAccessToken!(context, "refresh-original")).resolves.toMatchObject({
      accessToken: "access-3",
      refreshToken: "refresh-rotated",
    });
  });

  it("declares resumable continuation only for open upload sessions", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    expect(provider.continuesResumableUpload!("submitted:4:2:upload_1")).toBe(true);
    expect(provider.continuesResumableUpload!("session:4:upload_1")).toBe(true);
    expect(provider.continuesResumableUpload!("video:video-1")).toBe(false);
    expect(provider.continuesResumableUpload!("garbage")).toBe(false);
  });

  it("resumes a persisted submitted session after Google's acknowledged offset", async () => {
    const providerCalls = sequence(
      (_url, init) => {
        // The continuation probes the session; it never re-initiates (no POST).
        expect(init.method).toBe("PUT");
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes */4");
        return new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        });
      },
      (_url, init) => {
        expect(init.method).toBe("PUT");
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 2-3/4");
        expect(new Headers(init.headers).get("Content-Length")).toBe("2");
        expect([...(init.body as Uint8Array)]).toEqual([3, 4]);
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 4,
          mode: "resumable_upload",
        },
        providerOperationId: "submitted:4:2:upload_1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
    expect(providerCalls.calls).toHaveLength(2);
    expect(providerCalls.calls.every(({ init }) => init.method === "PUT")).toBe(true);
  });

  it("resumes a session-phase operation from byte zero", async () => {
    const providerCalls = sequence(
      () => new Response(null, { status: 308 }),
      (_url, init) => {
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-3/4");
        expect([...(init.body as Uint8Array)]).toEqual([1, 2, 3, 4]);
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 4,
          mode: "resumable_upload",
        },
        providerOperationId: "session:4:upload_1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
  });

  it("promotes a completed session to processing without reading the media", async () => {
    const providerCalls = sequence(() => json({ id: "video-1" }));
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 4,
          mode: "resumable_upload",
        },
        providerOperationId: "submitted:4:2:upload_1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
    expect(providerCalls.calls).toHaveLength(1);
  });

  it("keeps the refreshed submitted identity when continuation is interrupted", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-1" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-2" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-2" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
      () =>
        new Response(null, {
          headers: { Range: "bytes=0-2" },
          status: 308,
        }),
      () => {
        throw new TypeError("network reset");
      },
    );
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 4,
          mode: "resumable_upload",
        },
        providerOperationId: "submitted:4:2:upload_1",
      }),
    ).resolves.toMatchObject({
      result: {
        outcome: "unknown",
        providerOperationId: "submitted:4:3:upload_1",
      },
      state: "unknown",
    });
  });

  it("fails a continuation whose media does not match the persisted session", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 8,
          mode: "resumable_upload",
        },
        providerOperationId: "submitted:4:2:upload_1",
      }),
    ).resolves.toMatchObject({
      result: {
        failure: { code: "youtube_media_invalid" },
        outcome: "confirmed_failure",
      },
      state: "failed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ignores supplied media for completed video operations", async () => {
    const providerCalls = sequence(() => json({ items: [video("video-1")] }));
    await expect(
      adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
        media: {
          body: stream(),
          contentType: "video/mp4",
          fileSize: 4,
          mode: "resumable_upload",
        },
        providerOperationId: "video:video-1",
      }),
    ).resolves.toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
  });

  it("does not skip bytes when a chunk acknowledgement omits the Range header", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      (_url, init) => {
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-3/4");
        return new Response(null, { status: 308 });
      },
      (_url, init) => {
        // A 308 without Range acknowledges nothing: the same range is resent.
        expect(new Headers(init.headers).get("Content-Range")).toBe("bytes 0-3/4");
        expect([...(init.body as Uint8Array)]).toEqual([1, 2, 3, 4]);
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "video:video-1",
    });
    expect(providerCalls.calls).toHaveLength(3);
  });

  it("interrupts a session that never acknowledges new bytes", async () => {
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      () => new Response(null, { status: 308 }),
      () => new Response(null, { status: 308 }),
      () => new Response(null, { status: 308 }),
      () => new Response(null, { status: 308 }),
    );
    const published = await adapter(providerCalls.fetcher).publish!(
      context,
      credentials,
      publishInput(),
    );
    expect(published).toMatchObject({
      outcome: "unknown",
      providerOperationId: "submitted:4:0:upload_1",
    });
    expect(providerCalls.calls).toHaveLength(5);
  });

  it("assembles fragmented streams into bounded payloads without quadratic copying", async () => {
    // 1 200 fragments of 250 bytes force multi-part assembly across two
    // chunks — a fragment straddles the 256 KiB boundary — and the bounded
    // read count plus exact payloads prove every byte arrives once, in
    // order, at the right offset.
    const fileSize = 300_000;
    const fragmentSize = 250;
    const fragments = fileSize / fragmentSize;
    const bytes = new Uint8Array(fileSize).map((_, index) => index % 251);
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        const start = (reads - 1) * fragmentSize;
        if (start >= fileSize) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(start, start + fragmentSize));
      },
    });
    const providerCalls = sequence(
      () =>
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=upload_1&part=snippet%2Cstatus",
          },
        }),
      (_url, init) => {
        const headers = new Headers(init.headers);
        expect(headers.get("Content-Range")).toBe("bytes 0-262143/300000");
        expect(headers.get("Content-Length")).toBe("262144");
        const sent = init.body as Uint8Array;
        const expected = bytes.subarray(0, 262_144);
        expect(sent.byteLength).toBe(expected.byteLength);
        expect(sent.findIndex((byte, index) => byte !== expected[index])).toBe(-1);
        return new Response(null, {
          headers: { Range: "bytes=0-262143" },
          status: 308,
        });
      },
      (_url, init) => {
        const headers = new Headers(init.headers);
        expect(headers.get("Content-Range")).toBe("bytes 262144-299999/300000");
        expect(headers.get("Content-Length")).toBe("37856");
        const sent = init.body as Uint8Array;
        const expected = bytes.subarray(262_144);
        expect(sent.byteLength).toBe(expected.byteLength);
        expect(sent.findIndex((byte, index) => byte !== expected[index])).toBe(-1);
        return json({ id: "video-1" }, { status: 201 });
      },
    );
    await expect(
      adapter(providerCalls.fetcher, undefined, 256 * 1024).publish!(
        context,
        credentials,
        publishInput({
          media: [
            {
              body,
              contentType: "video/mp4",
              fileSize,
              metadata: {
                durationSeconds: 179.5,
                height: 1080,
                width: 1080,
              },
              mode: "resumable_upload",
            },
          ],
        }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "video:video-1",
    });
    expect(providerCalls.calls).toHaveLength(3);
    expect(reads).toBeLessThanOrEqual(fragments + 4);
  });
});
