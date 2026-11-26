import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ProviderAdapterError } from "../src/failures";
import type { ProviderMediaMetadata, ProviderStreamMedia, PublishInput } from "../src/types";
import { createYouTubeAdapter, type YouTubeAdapterOptions } from "../src/youtube/adapter";
import {
  failureOf,
  malformedAnswer,
  providerFailure,
  refused,
  thrownBy,
  unavailable,
  unconfirmed,
} from "./support";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "access-secret", accountId: "channel-1" };
const redirectUri = "https://api.example.com/api/v1/platforms/youtube/callback";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const resumableLocation =
  "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=upload_1&upload_protocol=resumable&alt=json";
const API = "https://www.googleapis.com";
const ANALYTICS = "https://youtubeanalytics.googleapis.com";
const TOKEN = "https://oauth2.googleapis.com/token";
const ALL_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];
const VERIFIER = "b".repeat(43);
const CHALLENGE = "a".repeat(43);

type Answer = Response | Error;

interface RecordedRequest {
  body?: string | number[];
  headers: Record<string, string>;
  method: string | undefined;
  query: Record<string, string>;
  url: string;
}

function setup(answers: Answer[] = [], options: Partial<YouTubeAdapterOptions> = {}) {
  const requests: RecordedRequest[] = [];
  const adapter = createYouTubeAdapter({
    clientId: "youtube-client",
    clientSecret: "youtube-client-secret",
    now: () => NOW,
    redirectUri,
    timeoutMilliseconds: 100,
    fetch: (target, init) => {
      const url = new URL(String(target));
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body =
        init?.body instanceof Uint8Array
          ? init.body.byteLength <= 16
            ? [...init.body]
            : `bytes:${init.body.byteLength}`
          : init?.body === undefined
            ? undefined
            : String(init.body);
      requests.push({
        ...(body === undefined ? {} : { body }),
        headers,
        method: init?.method,
        query: Object.fromEntries(url.searchParams),
        url: `${url.origin}${url.pathname}`,
      });
      const answer = answers.shift() ?? new Error("unexpected provider request");
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    ...options,
  });
  return { adapter, requests };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const empty = (status = 200, headers: HeadersInit = {}) => new Response(null, { headers, status });
const down = () => json({}, 503);
const locationResponse = (location = resumableLocation) => empty(200, { Location: location });

function stream(bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4])) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function failingStream() {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("disk unreadable");
    },
  });
}

function streamMedia(
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4]),
  metadata: ProviderMediaMetadata | undefined = {
    durationSeconds: 179.5,
    height: 1080,
    width: 1080,
  },
): ProviderStreamMedia {
  return {
    body: stream(bytes),
    contentType: "video/mp4",
    fileSize: bytes.byteLength,
    ...(metadata ? { metadata } : {}),
    mode: "resumable_upload",
  };
}

function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A square Short\nLaunch description #launch",
    hashtags: ["launch"],
    idempotencyKey: "publish-1",
    media: [streamMedia()],
    ...patch,
  };
}

function liveInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "Live walkthrough",
    hashtags: [],
    idempotencyKey: "live-1",
    media: [],
    providerOptions: {
      youtube: { madeForKids: false, postType: "live", privacyStatus: "unlisted" },
    },
    ...patch,
  };
}

function videoBody(
  id: string,
  patch: Partial<{
    channelId: string;
    privacyStatus: string;
    processingStatus: string;
    uploadStatus: string;
  }> = {},
) {
  return {
    items: [
      {
        id,
        processingDetails: { processingStatus: patch.processingStatus ?? "processing" },
        snippet: { channelId: patch.channelId ?? "channel-1" },
        status: {
          privacyStatus: patch.privacyStatus ?? "public",
          uploadStatus: patch.uploadStatus ?? "uploaded",
        },
      },
    ],
  };
}

function broadcastBody(id: string, lifecycle: string, boundStreamId?: string) {
  return {
    items: [
      {
        ...(boundStreamId ? { contentDetails: { boundStreamId } } : {}),
        id,
        snippet: { channelId: "channel-1" },
        status: { lifeCycleStatus: lifecycle },
      },
    ],
  };
}

const tokenAnswer = (patch: Record<string, unknown> = {}) =>
  json({
    access_token: "access-secret",
    expires_in: 3_600,
    refresh_token: "refresh-secret",
    scope: ALL_SCOPES.slice(0, 3).join(" "),
    token_type: "Bearer",
    ...patch,
  });

const channelAnswer = () =>
  json({
    items: [
      {
        id: "channel-1",
        snippet: {
          customUrl: "@meltiply",
          thumbnails: { default: { url: "https://cdn.example/channel.jpg" } },
          title: "Meltiply Channel",
        },
      },
    ],
  });

const streamIngestAnswer = (id = "stream-one") =>
  json({
    items: [
      {
        cdn: {
          ingestionInfo: {
            rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
            streamName: "private-encoder-key",
          },
        },
        id,
      },
    ],
  });

beforeAll(async () => {
  await setup([locationResponse(), json({ id: "warm-1" }, 201)]).adapter.publish!(
    context,
    credentials,
    publishInput(),
  );
});

describe("createYouTubeAdapter", () => {
  describe("configuration", () => {
    it("refuses a non-numeric categoryId", () => {
      expect(thrownBy(() => setup([], { categoryId: "abc" }))).toEqual(
        new TypeError("categoryId is invalid"),
      );
    });

    it.each([
      ["below 256 KiB", 256 * 1024 - 1],
      ["not aligned to 256 KiB", 300_000],
      ["above 64 MiB", 64 * 1024 * 1024 + 256 * 1024],
    ])("refuses uploadChunkBytes %s", (_example, uploadChunkBytes) => {
      expect(thrownBy(() => setup([], { uploadChunkBytes }))).toEqual(
        new RangeError("uploadChunkBytes must be a multiple of 256 KiB between 256 KiB and 64 MiB"),
      );
    });
  });

  describe("capability", () => {
    it("declares YouTube video upload and analytics capabilities", () => {
      const { adapter } = setup();
      expect({
        capability: adapter.capability,
        retryPolicy: adapter.retryPolicy,
        transferModes: adapter.transferModes,
      }).toEqual({
        capability: {
          accepted_mime_types: ["video/mp4", "video/quicktime"],
          analytics: true,
          asset_types: ["video"],
          comments: false,
          connect_available: true,
          max_caption_length: 5_000,
          max_file_size: 500 * 1024 * 1024,
          max_hashtags: 15,
          max_media_count: 1,
          max_video_duration_sec: 43_200,
          min_media_count: 1,
          multi_asset_types: [],
          notes: adapter.capability.notes,
          platform: "youtube",
          publish: true,
          reply: false,
        },
        retryPolicy: { baseDelaySeconds: 30, maxAttempts: 8, maxDelaySeconds: 900 },
        transferModes: ["resumable_upload"],
      });
    });
  });

  describe("continuesResumableUpload", () => {
    it.each([
      ["an open session", `session:4:${resumableLocation}`, true],
      ["a submitted session", `submitted:4:2:${resumableLocation}`, true],
      ["a completed video", "video:video-1", false],
      ["a live broadcast", "live:broadcast-1", false],
      ["an empty value", "", false],
    ])("%s", (_example, operationId, expected) => {
      expect(setup().adapter.continuesResumableUpload!(operationId)).toEqual(expected);
    });
  });

  describe("authorizationUrl", () => {
    it("an offline PKCE-bound URL", () => {
      const { adapter } = setup();
      const url = new URL(
        adapter.authorizationUrl!({ codeChallenge: CHALLENGE, redirectUri, state: "oauth-state" }),
      );
      expect({
        origin: url.origin,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
      }).toEqual({
        origin: "https://accounts.google.com",
        pathname: "/o/oauth2/v2/auth",
        query: {
          access_type: "offline",
          client_id: "youtube-client",
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
          include_granted_scopes: "true",
          prompt: "consent select_account",
          redirect_uri: redirectUri,
          response_type: "code",
          scope: ALL_SCOPES.join(" "),
          state: "oauth-state",
        },
      });
    });

    it("a foreign redirect URI", () => {
      const { adapter } = setup();
      expect(
        thrownBy(() =>
          adapter.authorizationUrl!({
            codeChallenge: CHALLENGE,
            redirectUri: "https://attacker.example/callback",
            state: "oauth-state",
          }),
        ),
      ).toEqual(new TypeError("OAuth redirect URI does not match configuration"));
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("a grant with explicit scopes and one channel", async () => {
      const { adapter, requests } = setup([tokenAnswer(), channelAnswer()]);

      const connection = await adapter.exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: VERIFIER,
        redirectUri,
      });

      expect(connection).toEqual({
        accessToken: "access-secret",
        account: {
          avatarUrl: "https://cdn.example/channel.jpg",
          displayName: "Meltiply Channel",
          id: "channel-1",
          username: "meltiply",
        },
        expiresAt: "2026-07-19T01:00:00.000Z",
        refreshToken: "refresh-secret",
        scopes: ALL_SCOPES.slice(0, 3),
      });
      expect(requests).toEqual([
        {
          body: `client_id=youtube-client&client_secret=youtube-client-secret&code=authorization-code&code_verifier=${VERIFIER}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`,
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
          query: {},
          url: TOKEN,
        },
        {
          headers: { accept: "application/json", authorization: "Bearer access-secret" },
          method: "GET",
          query: { maxResults: "2", mine: "true", part: "id,snippet" },
          url: `${API}/youtube/v3/channels`,
        },
      ]);
    });

    it("a grant omitting scopes defaults to configured scopes", async () => {
      const { adapter } = setup([tokenAnswer({ scope: undefined }), channelAnswer()]);

      const connection = await adapter.exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: VERIFIER,
        redirectUri,
      });

      expect(connection).toEqual({
        accessToken: "access-secret",
        account: {
          avatarUrl: "https://cdn.example/channel.jpg",
          displayName: "Meltiply Channel",
          id: "channel-1",
          username: "meltiply",
        },
        expiresAt: "2026-07-19T01:00:00.000Z",
        refreshToken: "refresh-secret",
        scopes: ALL_SCOPES,
      });
    });

    it("a grant with no channel stops with channel selection required", async () => {
      const { adapter } = setup([tokenAnswer(), json({ items: [] })]);

      expect(
        await failureOf(
          adapter.exchangeAuthorizationCode!(context, {
            code: "authorization-code",
            codeVerifier: VERIFIER,
            redirectUri,
          }),
        ),
      ).toEqual(refused("youtube_channel_selection_required"));
    });

    it("a token missing a publishing scope stops before reading channels", async () => {
      const { adapter, requests } = setup([
        tokenAnswer({ scope: "https://www.googleapis.com/auth/youtube.upload" }),
      ]);

      expect(
        await failureOf(
          adapter.exchangeAuthorizationCode!(context, {
            code: "authorization-code",
            codeVerifier: VERIFIER,
            redirectUri,
          }),
        ),
      ).toEqual(malformedAnswer);
      expect(requests).toHaveLength(1);
    });

    it("a foreign redirect URI sends nothing", async () => {
      const { adapter, requests } = setup();

      await expect(
        adapter.exchangeAuthorizationCode!(context, {
          code: "authorization-code",
          codeVerifier: VERIFIER,
          redirectUri: "https://evil.example/callback",
        }),
      ).rejects.toEqual(new TypeError("OAuth redirect URI does not match configuration"));
      expect(requests).toEqual([]);
    });

    it("YouTube down", async () => {
      const { adapter } = setup([down()]);

      expect(
        await failureOf(
          adapter.exchangeAuthorizationCode!(context, {
            code: "authorization-code",
            codeVerifier: VERIFIER,
            redirectUri,
          }),
        ),
      ).toEqual(unavailable);
    });
  });

  describe("refreshAccessToken", () => {
    it("an omitted refresh token keeps the current token and scopes", async () => {
      const publishingOnly = ALL_SCOPES.slice(0, 2);
      const { adapter, requests } = setup([
        json({
          access_token: "access-2",
          expires_in: 3_600,
          scope: publishingOnly.join(" "),
          token_type: "Bearer",
        }),
      ]);

      const refreshed = await adapter.refreshAccessToken!(context, "refresh-original");

      expect(refreshed).toEqual({
        accessToken: "access-2",
        expiresAt: "2026-07-19T01:00:00.000Z",
        refreshToken: "refresh-original",
        scopes: publishingOnly,
      });
      expect(requests).toEqual([
        {
          body: "client_id=youtube-client&client_secret=youtube-client-secret&grant_type=refresh_token&refresh_token=refresh-original",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
          query: {},
          url: TOKEN,
        },
      ]);
    });

    it("a rotated refresh token without scopes", async () => {
      const { adapter } = setup([
        json({
          access_token: "access-3",
          expires_in: 7_200,
          refresh_token: "refresh-rotated",
          token_type: "Bearer",
        }),
      ]);

      expect(await adapter.refreshAccessToken!(context, "refresh-original")).toEqual({
        accessToken: "access-3",
        expiresAt: "2026-07-19T02:00:00.000Z",
        refreshToken: "refresh-rotated",
        scopes: [],
      });
    });

    it("a blank refresh token sends nothing", async () => {
      const { adapter, requests } = setup();

      await expect(adapter.refreshAccessToken!(context, "   ")).rejects.toEqual(
        new TypeError("refreshToken is invalid"),
      );
      expect(requests).toEqual([]);
    });

    it("YouTube down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.refreshAccessToken!(context, "refresh-original"))).toEqual(
        unavailable,
      );
    });
  });

  describe("getAccountAnalytics", () => {
    it("subscriber and video counts", async () => {
      const { adapter, requests } = setup([
        json({ items: [{ statistics: { subscriberCount: "1200", videoCount: "45" } }] }),
      ]);

      expect(await adapter.getAccountAnalytics!(context, credentials)).toEqual({
        followers: 1200,
        posts: 45,
        recordedAt: NOW.toISOString(),
      });
      expect(requests).toEqual([
        {
          headers: { accept: "application/json", authorization: "Bearer access-secret" },
          method: "GET",
          query: { mine: "true", part: "statistics" },
          url: `${API}/youtube/v3/channels`,
        },
      ]);
    });

    it("YouTube down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.getAccountAnalytics!(context, credentials))).toEqual(
        unavailable,
      );
    });
  });

  describe("listAnalytics", () => {
    it("lifetime metrics for one video", async () => {
      const { adapter, requests } = setup([
        json({
          columnHeaders: [
            { name: "views" },
            { name: "likes" },
            { name: "comments" },
            { name: "shares" },
          ],
          rows: [[1200, 84, 9, 12]],
        }),
      ]);

      expect(
        await adapter.listAnalytics!(
          context,
          credentials,
          { providerPostId: "video-1" },
          { limit: 100 },
        ),
      ).toEqual({
        items: [
          {
            comments: 9,
            impressions: 0,
            likes: 84,
            providerPostId: "video-1",
            recordedAt: NOW.toISOString(),
            reach: 0,
            shares: 12,
            views: 1200,
            watchTimeSeconds: 0,
          },
        ],
      });
      expect(requests).toEqual([
        {
          headers: { accept: "application/json", authorization: "Bearer access-secret" },
          method: "GET",
          query: {
            endDate: "2026-07-19",
            filters: "video==video-1",
            ids: "channel==channel-1",
            metrics: "views,likes,comments,shares",
            startDate: "2005-02-14",
          },
          url: `${ANALYTICS}/v2/reports`,
        },
      ]);
    });

    it("no rows returns an empty page", async () => {
      const { adapter } = setup([
        json({
          columnHeaders: [
            { name: "views" },
            { name: "likes" },
            { name: "comments" },
            { name: "shares" },
          ],
        }),
      ]);

      expect(
        await adapter.listAnalytics!(
          context,
          credentials,
          { providerPostId: "video-1" },
          { limit: 100 },
        ),
      ).toEqual({ items: [] });
    });

    it("a cursor sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.listAnalytics!(
            context,
            credentials,
            { providerPostId: "video-1" },
            { cursor: "next", limit: 100 },
          ),
        ),
      ).toEqual(refused("youtube_analytics_not_paginated"));
      expect(requests).toEqual([]);
    });

    it("no video ID sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(adapter.listAnalytics!(context, credentials, {}, { limit: 100 })),
      ).toEqual(refused("youtube_video_id_required"));
      expect(requests).toEqual([]);
    });

    it("no channel sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.listAnalytics!(
            context,
            { accessToken: "access-secret" },
            { providerPostId: "video-1" },
            { limit: 100 },
          ),
        ),
      ).toEqual(refused("youtube_channel_required"));
      expect(requests).toEqual([]);
    });

    it("YouTube down", async () => {
      const { adapter } = setup([down()]);

      expect(
        await failureOf(
          adapter.listAnalytics!(
            context,
            credentials,
            { providerPostId: "video-1" },
            { limit: 100 },
          ),
        ),
      ).toEqual(unavailable);
    });
  });

  describe("publish", () => {
    it("a single-chunk video upload", async () => {
      const { adapter, requests } = setup([locationResponse(), json({ id: "video-1" }, 201)]);

      const result = await adapter.publish!(context, credentials, publishInput());

      expect(result).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-1",
      });
      expect(requests).toEqual([
        {
          body: JSON.stringify({
            snippet: {
              categoryId: "22",
              description: "A square Short\nLaunch description #launch",
              tags: ["launch"],
              title: "A square Short",
            },
            status: { privacyStatus: "public" },
          }),
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": "4",
            "x-upload-content-type": "video/mp4",
          },
          method: "POST",
          query: { part: "snippet,status", uploadType: "resumable" },
          url: `${API}/upload/youtube/v3/videos`,
        },
        {
          body: [1, 2, 3, 4],
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-length": "4",
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
          method: "PUT",
          query: { alt: "json", upload_id: "upload_1", upload_protocol: "resumable" },
          url: `${API}/upload/youtube/v3/videos`,
        },
      ]);
    });

    it("an unlisted video with madeForKids and a custom category", async () => {
      const { adapter, requests } = setup([locationResponse(), json({ id: "video-2" }, 201)], {
        categoryId: "28",
      });

      const result = await adapter.publish!(
        context,
        credentials,
        publishInput({
          providerOptions: { youtube: { madeForKids: true, privacyStatus: "unlisted" } },
        }),
      );

      expect(result).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-2",
      });
      expect(JSON.parse(String(requests[0]?.body))).toEqual({
        snippet: {
          categoryId: "28",
          description: "A square Short\nLaunch description #launch",
          tags: ["launch"],
          title: "A square Short",
        },
        status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: true },
      });
    });

    it("an opaque session URI is used verbatim", async () => {
      const opaque = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=opaque-session";
      const { adapter, requests } = setup([
        locationResponse(opaque),
        json({ id: "v-opaque" }, 201),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:v-opaque",
      });
      expect(requests[1]?.query).toEqual({ upload_id: "opaque-session" });
    });

    it("a fragmented multi-chunk upload aligns to uploadChunkBytes", async () => {
      const fileSize = 270_000;
      const fragmentSize = 2_000;
      const bytes = new Uint8Array(fileSize);
      for (let index = 0; index < fileSize; index += 1) bytes[index] = index % 251;
      const sentChunks: Uint8Array[] = [];
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const start = reads * fragmentSize;
          reads += 1;
          if (start >= fileSize) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(start, start + fragmentSize));
        },
      });
      const answers: Answer[] = [
        locationResponse(),
        empty(308, { Range: "bytes=0-262143" }),
        json({ id: "video-big" }, 201),
      ];
      const ranges: (string | null)[] = [];
      const adapter = createYouTubeAdapter({
        clientId: "youtube-client",
        clientSecret: "youtube-client-secret",
        now: () => NOW,
        redirectUri,
        uploadChunkBytes: 256 * 1024,
        fetch: (_target, init) => {
          ranges.push(new Headers(init?.headers).get("Content-Range"));
          const rawBody = init?.body;
          if (rawBody instanceof Uint8Array) sentChunks.push(new Uint8Array(rawBody));
          return Promise.resolve(answers.shift() as Response);
        },
      });

      const result = await adapter.publish!(
        context,
        credentials,
        publishInput({
          media: [
            {
              body,
              contentType: "video/mp4",
              fileSize,
              metadata: { durationSeconds: 179.5, height: 1080, width: 1080 },
              mode: "resumable_upload",
            },
          ],
        }),
      );

      expect(result).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-big",
      });
      expect(ranges).toEqual([null, "bytes 0-262143/270000", "bytes 262144-269999/270000"]);
      expect(sentChunks.map((chunk) => chunk.byteLength)).toEqual([262_144, 7_856]);
      expect(Buffer.compare(sentChunks[0]!, bytes.subarray(0, 262_144))).toEqual(0);
      expect(Buffer.compare(sentChunks[1]!, bytes.subarray(262_144))).toEqual(0);
    });

    it("resumes an interrupted chunk from the probed Range", async () => {
      const { adapter, requests } = setup([
        locationResponse(),
        new TypeError("network reset"),
        empty(308, { Range: "bytes=0-1" }),
        json({ id: "video-1" }, 201),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-1",
      });
      expect(
        requests.map(({ body, headers, method }) => ({
          body,
          range: headers["content-range"],
          method,
        })),
      ).toEqual([
        { body: requests[0]?.body, method: "POST", range: undefined },
        { body: [1, 2, 3, 4], method: "PUT", range: "bytes 0-3/4" },
        { body: undefined, method: "PUT", range: "bytes */4" },
        { body: [3, 4], method: "PUT", range: "bytes 2-3/4" },
      ]);
    });

    it("completes when the recovery probe reports the video finished", async () => {
      const { adapter } = setup([
        locationResponse(),
        new TypeError("network reset"),
        json({ id: "video-done" }),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-done",
      });
    });

    it("bounds network retries and retains the acknowledged offset", async () => {
      const { adapter, requests } = setup([
        locationResponse(),
        new TypeError("reset 1"),
        empty(308, { Range: "bytes=0-1" }),
        new TypeError("reset 2"),
        empty(308, { Range: "bytes=0-1" }),
        new TypeError("reset 3"),
        empty(308, { Range: "bytes=0-1" }),
        new TypeError("reset 4"),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("ambiguous", "provider_http_request_failed"),
        outcome: "unknown",
        providerOperationId: `submitted:4:2:${resumableLocation}`,
      });
      expect(requests).toHaveLength(8);
    });

    it("retries when a 308 omits Range and succeeds on the next attempt", async () => {
      const { adapter, requests } = setup([
        locationResponse(),
        empty(308),
        json({ id: "video-1" }, 201),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:video-1",
      });
      expect(requests.slice(1).map((request) => request.body)).toEqual([
        [1, 2, 3, 4],
        [1, 2, 3, 4],
      ]);
    });

    it("interrupts when repeated 308 answers acknowledge no progress", async () => {
      const { adapter, requests } = setup([
        locationResponse(),
        empty(308),
        empty(308),
        empty(308),
        empty(308),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("ambiguous", "youtube_upload_incomplete"),
        outcome: "unknown",
        providerOperationId: `submitted:4:0:${resumableLocation}`,
      });
      expect(requests).toHaveLength(5);
    });

    it("interrupts when a chunk receives a rate limit", async () => {
      const { adapter } = setup([locationResponse(), json({}, 429)]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("ambiguous", "provider_http_429"),
        outcome: "unknown",
        providerOperationId: `submitted:4:0:${resumableLocation}`,
      });
    });

    it("confirms failure when a chunk is rejected deterministically", async () => {
      const { adapter } = setup([locationResponse(), json({}, 400)]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("deterministic", "provider_http_400"),
        outcome: "confirmed_failure",
        providerOperationId: `session:4:${resumableLocation}`,
      });
    });

    it("confirms failure when the media stream ends short", async () => {
      const { adapter } = setup([locationResponse()]);
      const short = streamMedia(new Uint8Array(0));
      short.fileSize = 4;

      expect(
        await adapter.publish!(context, credentials, publishInput({ media: [short] })),
      ).toEqual({
        failure: refused("youtube_media_invalid"),
        outcome: "confirmed_failure",
        providerOperationId: `session:4:${resumableLocation}`,
      });
    });

    it("confirms failure when reading the media stream throws", async () => {
      const { adapter } = setup([locationResponse()]);
      const broken: ProviderStreamMedia = {
        body: failingStream(),
        contentType: "video/mp4",
        fileSize: 4,
        metadata: { durationSeconds: 60, height: 1080, width: 1080 },
        mode: "resumable_upload",
      };

      expect(
        await adapter.publish!(context, credentials, publishInput({ media: [broken] })),
      ).toEqual({
        failure: refused("youtube_media_unreadable"),
        outcome: "confirmed_failure",
        providerOperationId: `session:4:${resumableLocation}`,
      });
    });

    it.each([
      ["quotaExceeded", providerFailure("quota", "youtube_quota_exceeded")],
      ["userRateLimitExceeded", providerFailure("rate_limit", "youtube_rate_limited")],
      ["forbidden", providerFailure("auth", "provider_http_403")],
    ])("classifies a 403 %s response without leaking its message", async (reason, expected) => {
      const { adapter } = setup([
        json(
          {
            error: {
              errors: [{ message: "token=secret-leak https://private.example/x", reason }],
            },
          },
          403,
        ),
      ]);

      const error = await adapter.publish!(context, credentials, publishInput()).catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect((error as ProviderAdapterError).failure).toEqual(expected);
      expect(JSON.stringify(error)).not.toMatch(/secret-leak|private\.example/);
    });

    it("an unsafe Location header stops before uploading bytes", async () => {
      const { adapter, requests } = setup([
        locationResponse("https://attacker.example/upload/youtube/v3/videos?upload_id=u1"),
      ]);

      expect(await failureOf(adapter.publish!(context, credentials, publishInput()))).toEqual(
        malformedAnswer,
      );
      expect(requests).toHaveLength(1);
    });

    it("invalid upload input sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(adapter.publish!(context, credentials, publishInput({ media: [] }))),
      ).toEqual(refused("youtube_video_invalid"));
      expect(requests).toEqual([]);
    });

    it("no channel sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.publish!(context, { accessToken: "access-secret" }, publishInput()),
        ),
      ).toEqual(refused("youtube_channel_required"));
      expect(requests).toEqual([]);
    });

    it("a live broadcast creates, binds, and returns a broadcast operation", async () => {
      const { adapter, requests } = setup([
        json({ id: "broadcast-one" }),
        json({ id: "stream-one" }),
        json({ contentDetails: { boundStreamId: "stream-one" }, id: "broadcast-one" }),
      ]);

      const result = await adapter.publish!(context, credentials, liveInput());

      expect(result).toEqual({
        delivery: "broadcast",
        outcome: "confirmed_success",
        providerOperationId: "live:broadcast-one",
      });
      expect(requests).toEqual([
        {
          body: JSON.stringify({
            snippet: {
              title: "Live walkthrough",
              description: "Live walkthrough",
              scheduledStartTime: "2026-07-19T00:01:00.000Z",
            },
            status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
            contentDetails: {
              enableAutoStart: true,
              enableAutoStop: true,
              monitorStream: { enableMonitorStream: false },
            },
          }),
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-type": "application/json",
          },
          method: "POST",
          query: { part: "snippet,status,contentDetails" },
          url: `${API}/youtube/v3/liveBroadcasts`,
        },
        {
          body: JSON.stringify({
            snippet: { title: "Live walkthrough" },
            cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
            contentDetails: { isReusable: false },
          }),
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-type": "application/json",
          },
          method: "POST",
          query: { part: "snippet,cdn,contentDetails" },
          url: `${API}/youtube/v3/liveStreams`,
        },
        {
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-type": "application/json",
          },
          method: "POST",
          query: { id: "broadcast-one", part: "id,contentDetails", streamId: "stream-one" },
          url: `${API}/youtube/v3/liveBroadcasts/bind`,
        },
      ]);
    });

    it("a live broadcast whose stream binding fails retains the broadcast operation", async () => {
      const { adapter } = setup([json({ id: "broadcast-one" }), down()]);

      expect(await adapter.publish!(context, credentials, liveInput())).toEqual({
        failure: providerFailure("ambiguous", "provider_http_503"),
        outcome: "unknown",
        providerOperationId: "live:broadcast-one",
      });
    });

    it("a live broadcast without an idempotency key sends nothing", async () => {
      const { adapter, requests } = setup();

      await expect(
        adapter.publish!(context, credentials, liveInput({ idempotencyKey: " " })),
      ).rejects.toEqual(new TypeError("idempotencyKey is invalid"));
      expect(requests).toEqual([]);
    });
  });

  describe("getBroadcastInfo", () => {
    it.each([
      ["ready", "ready", {}],
      ["testing", "testing", {}],
      ["live", "live", { providerPostId: "broadcast-one" }],
    ] as const)("an active %s broadcast", async (lifecycle, state, extra) => {
      const { adapter } = setup([
        json(broadcastBody("broadcast-one", lifecycle, "stream-one")),
        streamIngestAnswer(),
      ]);

      expect(
        await adapter.getBroadcastInfo!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
        providerUrl: "https://youtu.be/broadcast-one",
        state,
        streamKey: "private-encoder-key",
        ...extra,
      });
    });

    it("a complete broadcast ends with its watch URL", async () => {
      const { adapter, requests } = setup([json(broadcastBody("broadcast-one", "complete"))]);

      expect(
        await adapter.getBroadcastInfo!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        providerPostId: "broadcast-one",
        providerUrl: "https://youtu.be/broadcast-one",
        state: "ended",
      });
      expect(requests).toHaveLength(1);
    });

    it("a revoked broadcast ends without a video ID", async () => {
      const { adapter } = setup([json(broadcastBody("broadcast-one", "revoked"))]);

      expect(
        await adapter.getBroadcastInfo!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({ state: "ended" });
    });

    it("an active broadcast with no bound stream is malformed", async () => {
      const { adapter } = setup([json(broadcastBody("broadcast-one", "ready"))]);

      expect(
        await failureOf(
          adapter.getBroadcastInfo!(context, credentials, {
            providerOperationId: "live:broadcast-one",
          }),
        ),
      ).toEqual(malformedAnswer);
    });

    it("a non-live operation sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.getBroadcastInfo!(context, credentials, {
            providerOperationId: "video:video-1",
          }),
        ),
      ).toEqual(malformedAnswer);
      expect(requests).toEqual([]);
    });
  });

  describe("endBroadcast", () => {
    it("a live broadcast transitions to complete", async () => {
      const { adapter, requests } = setup([
        json(broadcastBody("broadcast-one", "live")),
        json({ id: "broadcast-one", status: { lifeCycleStatus: "complete" } }),
      ]);

      expect(
        await adapter.endBroadcast!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "ended_live:broadcast-one",
        providerPostId: "broadcast-one",
        providerUrl: "https://youtu.be/broadcast-one",
      });
      expect(requests[1]).toEqual({
        headers: { accept: "application/json", authorization: "Bearer access-secret" },
        method: "POST",
        query: { broadcastStatus: "complete", id: "broadcast-one", part: "id,status" },
        url: `${API}/youtube/v3/liveBroadcasts/transition`,
      });
    });

    it("an already complete broadcast does not write again", async () => {
      const { adapter, requests } = setup([json(broadcastBody("broadcast-one", "complete"))]);

      expect(
        await adapter.endBroadcast!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "ended_live:broadcast-one",
        providerPostId: "broadcast-one",
        providerUrl: "https://youtu.be/broadcast-one",
      });
      expect(requests).toHaveLength(1);
    });

    it("an unstarted broadcast is deleted without claiming a video", async () => {
      const { adapter, requests } = setup([json(broadcastBody("never-live", "ready")), empty(204)]);

      expect(
        await adapter.endBroadcast!(context, credentials, {
          providerOperationId: "live:never-live",
        }),
      ).toEqual({
        delivery: "broadcast",
        outcome: "confirmed_success",
        providerOperationId: "ended_live:never-live",
      });
      expect(requests[1]).toEqual({
        headers: { accept: "application/json", authorization: "Bearer access-secret" },
        method: "DELETE",
        query: { id: "never-live" },
        url: `${API}/youtube/v3/liveBroadcasts`,
      });
    });

    it("a transition answering another ID is ambiguous", async () => {
      const { adapter } = setup([
        json(broadcastBody("broadcast-one", "live")),
        json({ id: "other" }),
      ]);

      expect(
        await failureOf(
          adapter.endBroadcast!(context, credentials, {
            providerOperationId: "live:broadcast-one",
          }),
        ),
      ).toEqual(unconfirmed);
    });
  });

  describe("lookupPublication", () => {
    it("an ended_live operation resolves without contacting YouTube", async () => {
      const { adapter, requests } = setup();

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "ended_live:broadcast-one",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "ended_live:broadcast-one",
          providerPostId: "broadcast-one",
          providerUrl: "https://youtu.be/broadcast-one",
        },
        state: "published",
      });
      expect(requests).toEqual([]);
    });

    it("a live broadcast that is on air resolves as published", async () => {
      const { adapter } = setup([
        json(broadcastBody("broadcast-one", "live", "stream-one")),
        streamIngestAnswer(),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "live:broadcast-one",
          providerPostId: "broadcast-one",
          providerUrl: "https://youtu.be/broadcast-one",
        },
        state: "published",
      });
    });

    it("a ready broadcast resolves as delivered", async () => {
      const { adapter } = setup([
        json(broadcastBody("broadcast-one", "ready", "stream-one")),
        streamIngestAnswer(),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "live:broadcast-one",
        }),
      ).toEqual({
        result: {
          delivery: "broadcast",
          outcome: "confirmed_success",
          providerOperationId: "live:broadcast-one",
        },
        state: "delivered",
      });
    });

    it("a video still processing", async () => {
      const { adapter } = setup([json(videoBody("video-1"))]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "video:video-1",
        }),
      ).toEqual({
        providerOperationId: "video:video-1",
        state: "processing",
      });
    });

    it("a processed video resolves as published", async () => {
      const { adapter } = setup([
        json(videoBody("video-1", { processingStatus: "succeeded", uploadStatus: "processed" })),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerPostId: "video-1",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "video:video-1",
          providerPostId: "video-1",
          providerUrl: "https://youtu.be/video-1",
        },
        state: "published",
      });
    });

    it("a missing video (404) returns not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "video:video-1",
        }),
      ).toEqual({ state: "not_found" });
    });

    it("a video operation ignores supplied continuation media", async () => {
      const { adapter } = setup([json(videoBody("video-1"))]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: "video:video-1",
        }),
      ).toEqual({
        providerOperationId: "video:video-1",
        state: "processing",
      });
    });

    it("a submitted session without media retains the highest acknowledged offset", async () => {
      const { adapter } = setup([empty(308, { Range: "bytes=0-2" })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: `submitted:4:1:${resumableLocation}`,
        }),
      ).toEqual({
        result: {
          failure: providerFailure("ambiguous", "youtube_upload_incomplete"),
          outcome: "unknown",
          providerOperationId: `submitted:4:3:${resumableLocation}`,
        },
        state: "unknown",
      });
    });

    it("a session without media that completed promotes to video processing", async () => {
      const { adapter } = setup([json({ id: "video-1" })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: `submitted:4:0:${resumableLocation}`,
        }),
      ).toEqual({
        providerOperationId: "video:video-1",
        state: "processing",
      });
    });

    it("a session without media whose probe returns 404 is not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: `session:4:${resumableLocation}`,
        }),
      ).toEqual({ state: "not_found" });
    });

    it("a submitted session with media resumes after the probed Range", async () => {
      const { adapter, requests } = setup([
        empty(308, { Range: "bytes=0-1" }),
        json({ id: "recovered-video" }, 201),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        }),
      ).toEqual({
        providerOperationId: "video:recovered-video",
        state: "processing",
      });
      expect(requests).toEqual([
        {
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-length": "0",
            "content-range": "bytes */4",
          },
          method: "PUT",
          query: { alt: "json", upload_id: "upload_1", upload_protocol: "resumable" },
          url: `${API}/upload/youtube/v3/videos`,
        },
        {
          body: [3, 4],
          headers: {
            accept: "application/json",
            authorization: "Bearer access-secret",
            "content-length": "2",
            "content-range": "bytes 2-3/4",
            "content-type": "video/mp4",
          },
          method: "PUT",
          query: { alt: "json", upload_id: "upload_1", upload_protocol: "resumable" },
          url: `${API}/upload/youtube/v3/videos`,
        },
      ]);
    });

    it("a session-phase operation with media resumes from byte zero", async () => {
      const { adapter, requests } = setup([empty(308), json({ id: "video-1" }, 201)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `session:4:${resumableLocation}`,
        }),
      ).toEqual({
        providerOperationId: "video:video-1",
        state: "processing",
      });
      expect(requests[1]?.body).toEqual([1, 2, 3, 4]);
    });

    it("a completed session with media promotes without uploading again", async () => {
      const { adapter, requests } = setup([json({ id: "video-1" })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        }),
      ).toEqual({
        providerOperationId: "video:video-1",
        state: "processing",
      });
      expect(requests).toHaveLength(1);
    });

    it("a continuation with mismatched media fails without contacting YouTube", async () => {
      const { adapter, requests } = setup();

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(new Uint8Array(8)),
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        }),
      ).toEqual({
        result: {
          failure: refused("youtube_media_invalid"),
          outcome: "confirmed_failure",
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        },
        state: "failed",
      });
      expect(requests).toEqual([]);
    });

    it("a continuation interrupted by rate limit retains the highest acknowledged offset", async () => {
      const { adapter } = setup([empty(308, { Range: "bytes=0-0" }), json({}, 429)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        }),
      ).toEqual({
        result: {
          failure: providerFailure("ambiguous", "provider_http_429"),
          outcome: "unknown",
          providerOperationId: `submitted:4:2:${resumableLocation}`,
        },
        state: "unknown",
      });
    });

    it("a continuation rejected deterministically fails", async () => {
      const { adapter } = setup([empty(308), json({}, 400)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `session:4:${resumableLocation}`,
        }),
      ).toEqual({
        result: {
          failure: providerFailure("deterministic", "provider_http_400"),
          outcome: "confirmed_failure",
          providerOperationId: `session:4:${resumableLocation}`,
        },
        state: "failed",
      });
    });

    it("a continuation whose probe returns 404 is not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          media: streamMedia(),
          providerOperationId: `session:4:${resumableLocation}`,
        }),
      ).toEqual({ state: "not_found" });
    });

    it.each([
      ["an unusable post ID", { providerPostId: "bad id" }],
      ["an unusable operation ID", { providerOperationId: "unknown:1" }],
      [
        "a mismatched post and video operation",
        { providerOperationId: "video:v1", providerPostId: "v2" },
      ],
      ["no operation or post ID", {}],
    ])("%s sends nothing", async (_example, lookup) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.lookupPublication!(context, credentials, lookup))).toEqual(
        malformedAnswer,
      );
      expect(requests).toEqual([]);
    });
  });
});
