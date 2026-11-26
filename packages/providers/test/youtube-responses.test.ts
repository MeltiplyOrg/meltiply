import { describe, expect, it } from "vite-plus/test";

import type { ProviderMedia, ProviderStreamMedia, PublishInput } from "../src/types";
import {
  acknowledgedOffset,
  parseGoogleTokenResponse,
  parseYouTubeUploadInput,
  pkce,
  youtubeAccountStatistics,
  youtubeAnalyticsReport,
  youtubeBroadcastRecord,
  youtubeChannelAccount,
  youtubeContinuationMedia,
  youtubeLivePlan,
  youtubeStreamIngest,
  youtubeVideoStatus,
} from "../src/youtube/responses";
import { failureThrownBy, malformedAnswer, providerFailure, refused, thrownBy } from "./support";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const REQUIRED_SCOPES =
  "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

const validToken = {
  access_token: "access-secret",
  expires_in: 3_600,
  refresh_token: "refresh-secret",
  scope: `${REQUIRED_SCOPES} https://www.googleapis.com/auth/yt-analytics.readonly`,
  token_type: "Bearer",
};

const emptyStream = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

const streamMedia = (patch: Partial<ProviderStreamMedia> = {}): ProviderStreamMedia => ({
  body: emptyStream(),
  contentType: "video/mp4",
  fileSize: 4,
  metadata: { durationSeconds: 60, height: 1080, width: 1920 },
  mode: "resumable_upload",
  ...patch,
});

const uploadInput = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: "Title line\nDescription line",
  hashtags: ["launch"],
  idempotencyKey: "publish-1",
  media: [streamMedia()],
  ...patch,
});

const liveInput = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: "Live title\nLive description",
  hashtags: [],
  idempotencyKey: "live-1",
  media: [],
  providerOptions: {
    youtube: { madeForKids: false, postType: "live", privacyStatus: "unlisted" },
  },
  ...patch,
});

const videoItem = (
  patch: Partial<{
    channelId: string;
    id: string;
    privacyStatus: string;
    processingStatus: string;
    uploadStatus: string;
  }> = {},
) => ({
  id: patch.id ?? "video-1",
  processingDetails: { processingStatus: patch.processingStatus ?? "processing" },
  snippet: { channelId: patch.channelId ?? "channel-1" },
  status: {
    privacyStatus: patch.privacyStatus ?? "public",
    uploadStatus: patch.uploadStatus ?? "uploaded",
  },
});

describe("pkce", () => {
  it("a 43-character verifier", () => {
    const value = "a".repeat(43);
    expect(pkce("codeVerifier", value)).toEqual(value);
  });

  it("a 128-character verifier", () => {
    const value = "A_z-0".repeat(25) + "123";
    expect(pkce("codeVerifier", value)).toEqual(value);
  });

  it("refuses a 42-character verifier", () => {
    expect(thrownBy(() => pkce("codeVerifier", "a".repeat(42)))).toEqual(
      new TypeError("codeVerifier is invalid"),
    );
  });

  it("refuses a 129-character verifier", () => {
    expect(thrownBy(() => pkce("codeVerifier", "a".repeat(129)))).toEqual(
      new TypeError("codeVerifier is invalid"),
    );
  });

  it("refuses an invalid character", () => {
    expect(thrownBy(() => pkce("codeChallenge", `${"a".repeat(42)}+`))).toEqual(
      new TypeError("codeChallenge is invalid"),
    );
  });
});

describe("parseGoogleTokenResponse", () => {
  it("a token response with refresh token and scopes", () => {
    expect(parseGoogleTokenResponse(validToken, NOW, true)).toEqual({
      accessToken: "access-secret",
      expiresAt: "2026-07-19T01:00:00.000Z",
      refreshToken: "refresh-secret",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
      ],
    });
  });

  it("a refresh response without a refresh token or scope", () => {
    expect(
      parseGoogleTokenResponse(
        { access_token: "access-2", expires_in: 1_800, token_type: "bearer" },
        NOW,
        false,
      ),
    ).toEqual({
      accessToken: "access-2",
      expiresAt: "2026-07-19T00:30:00.000Z",
      refreshToken: undefined,
    });
  });

  it.each([
    ["no refresh token when required", { ...validToken, refresh_token: undefined }, true],
    ["no access token", { ...validToken, access_token: "" }, true],
    ["another token type", { ...validToken, token_type: "MAC" }, true],
    [
      "a missing publishing scope",
      { ...validToken, scope: "https://www.googleapis.com/auth/youtube.upload" },
      true,
    ],
    [
      "a repeated scope",
      { ...validToken, scope: `${REQUIRED_SCOPES} https://www.googleapis.com/auth/youtube.upload` },
      true,
    ],
    ["an invalid scope character", { ...validToken, scope: `${REQUIRED_SCOPES} bad"scope` }, true],
    [
      "twenty-one scopes",
      {
        ...validToken,
        scope: [
          ...REQUIRED_SCOPES.split(" "),
          ...Array.from({ length: 19 }, (_, index) => `scope-${index}`),
        ].join(" "),
      },
      true,
    ],
    ["a non-string scope", { ...validToken, scope: 123 }, true],
    ["a lifetime over two days", { ...validToken, expires_in: 172_801 }, true],
    ["a body that is not an object", null, true],
  ])("refuses %s", (_example, body, requireRefresh) => {
    expect(
      failureThrownBy(() =>
        requireRefresh
          ? parseGoogleTokenResponse(body, NOW, true)
          : parseGoogleTokenResponse(body, NOW, false),
      ),
    ).toEqual(malformedAnswer);
  });
});

describe("youtubeChannelAccount", () => {
  it("a single channel with avatar and handle", () => {
    expect(
      youtubeChannelAccount({
        items: [
          {
            id: "channel-1",
            snippet: {
              customUrl: " @meltiply ",
              thumbnails: { default: { url: "https://cdn.example/avatar.jpg" } },
              title: "Meltiply Channel",
            },
          },
        ],
      }),
    ).toEqual({
      avatarUrl: "https://cdn.example/avatar.jpg",
      displayName: "Meltiply Channel",
      id: "channel-1",
      username: "meltiply",
    });
  });

  it("a channel without avatar or valid handle", () => {
    expect(
      youtubeChannelAccount({
        items: [
          {
            id: "channel-1",
            snippet: {
              customUrl: "@bad handle!",
              title: "Plain Channel",
            },
          },
        ],
      }),
    ).toEqual({
      displayName: "Plain Channel",
      id: "channel-1",
    });
  });

  it.each([
    ["no channel", { items: [] }],
    ["two channels", { items: [{ id: "c1" }, { id: "c2" }] }],
    ["another page of channels", { items: [{ id: "c1" }], nextPageToken: "next" }],
    ["no items list", {}],
  ])("requires channel selection on %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeChannelAccount(body))).toEqual(
      refused("youtube_channel_selection_required"),
    );
  });

  it.each([
    ["no id", { items: [{ snippet: { title: "Channel" } }] }],
    ["no title", { items: [{ id: "channel-1", snippet: {} }] }],
    [
      "an insecure thumbnail",
      {
        items: [
          {
            id: "channel-1",
            snippet: {
              thumbnails: { default: { url: "http://cdn.example/avatar.jpg" } },
              title: "Channel",
            },
          },
        ],
      },
    ],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeChannelAccount(body))).toEqual(malformedAnswer);
  });
});

describe("youtubeAccountStatistics", () => {
  it("subscribers and video count", () => {
    expect(
      youtubeAccountStatistics({
        items: [{ statistics: { subscriberCount: "1200", videoCount: "45" } }],
      }),
    ).toEqual({ followers: 1200, posts: 45 });
  });

  it("subscribers only when videoCount is omitted", () => {
    expect(
      youtubeAccountStatistics({
        items: [{ statistics: { subscriberCount: "0" } }],
      }),
    ).toEqual({ followers: 0 });
  });

  it.each([
    [
      "hidden subscribers",
      { items: [{ statistics: { hiddenSubscriberCount: true, subscriberCount: "10" } }] },
    ],
    ["a negative subscriber count", { items: [{ statistics: { subscriberCount: "-1" } }] }],
    ["a non-numeric subscriber count", { items: [{ statistics: { subscriberCount: "many" } }] }],
    ["no items", { items: [] }],
    ["two items", { items: [{}, {}] }],
    ["a non-object body", null],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeAccountStatistics(body))).toEqual(malformedAnswer);
  });
});

describe("youtubeAnalyticsReport", () => {
  const headers = [{ name: "views" }, { name: "likes" }, { name: "comments" }, { name: "shares" }];

  it("a report with one row of metrics", () => {
    expect(youtubeAnalyticsReport({ columnHeaders: headers, rows: [[1200, 84, 9, 12]] })).toEqual({
      comments: 9,
      likes: 84,
      shares: 12,
      views: 1200,
    });
  });

  it("a report without rows", () => {
    expect(youtubeAnalyticsReport({ columnHeaders: headers })).toEqual(undefined);
  });

  it("a report with empty rows", () => {
    expect(youtubeAnalyticsReport({ columnHeaders: headers, rows: [] })).toEqual(undefined);
  });

  it.each([
    ["no columnHeaders", {}],
    ["rows that are not a list", { columnHeaders: headers, rows: "none" }],
    [
      "two rows",
      {
        columnHeaders: headers,
        rows: [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ],
      },
    ],
    ["a row shorter than headers", { columnHeaders: headers, rows: [[1, 2, 3]] }],
    [
      "a duplicate column header",
      {
        columnHeaders: [{ name: "views" }, { name: "views" }],
        rows: [[1, 2]],
      },
    ],
    [
      "a missing required metric",
      { columnHeaders: [{ name: "views" }, { name: "likes" }], rows: [[1200, 84]] },
    ],
    ["a negative metric", { columnHeaders: headers, rows: [[1200, -1, 9, 12]] }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeAnalyticsReport(body))).toEqual(malformedAnswer);
  });
});

describe("youtubeLivePlan", () => {
  it("a live broadcast plan", () => {
    expect(youtubeLivePlan(liveInput())).toEqual({
      description: "Live title\nLive description",
      madeForKids: false,
      privacyStatus: "unlisted",
      title: "Live title",
    });
  });

  it.each<[string, Partial<PublishInput>]>([
    ["attached media", { media: [streamMedia()] }],
    ["no YouTube options", { providerOptions: undefined }],
    [
      "an invalid privacy status",
      {
        providerOptions: {
          youtube: { madeForKids: false, postType: "live", privacyStatus: "friends" as never },
        },
      },
    ],
    [
      "missing madeForKids",
      {
        providerOptions: {
          youtube: { postType: "live", privacyStatus: "public" } as never,
        },
      },
    ],
  ])("refuses %s", (_example, patch) => {
    expect(failureThrownBy(() => youtubeLivePlan(liveInput(patch)))).toEqual(
      refused("youtube_live_options_invalid"),
    );
  });

  it("refuses a blank caption", () => {
    expect(thrownBy(() => youtubeLivePlan(liveInput({ caption: "   " })))).toEqual(
      new TypeError("title is invalid"),
    );
  });

  it("refuses a title over 100 code points", () => {
    expect(thrownBy(() => youtubeLivePlan(liveInput({ caption: "a".repeat(101) })))).toEqual(
      new TypeError("title is invalid"),
    );
  });
});

describe("youtubeBroadcastRecord", () => {
  const broadcast = {
    id: "bc-1",
    snippet: { channelId: "channel-1" },
    status: { lifeCycleStatus: "ready" },
  };

  it("a matching broadcast", () => {
    expect(youtubeBroadcastRecord({ items: [broadcast] }, "bc-1", "channel-1")).toEqual({
      broadcast,
      lifecycle: "ready",
    });
  });

  it.each([
    ["another channel", { items: [{ ...broadcast, snippet: { channelId: "channel-2" } }] }],
    [
      "an unknown lifecycle status",
      { items: [{ ...broadcast, status: { lifeCycleStatus: "paused" } }] },
    ],
    ["another id", { items: [{ ...broadcast, id: "bc-2" }] }],
    ["no items", { items: [] }],
    ["two items", { items: [broadcast, broadcast] }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeBroadcastRecord(body, "bc-1", "channel-1"))).toEqual(
      malformedAnswer,
    );
  });
});

describe("youtubeStreamIngest", () => {
  const streamBody = (rtmpsIngestionAddress: unknown, streamName: unknown = "key-1") => ({
    items: [
      {
        cdn: { ingestionInfo: { rtmpsIngestionAddress, streamName } },
        id: "stream-1",
      },
    ],
  });

  it("an rtmps ingest endpoint and stream key", () => {
    expect(
      youtubeStreamIngest(streamBody("rtmps://a.rtmps.youtube.com/live2"), "stream-1"),
    ).toEqual({ ingestUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey: "key-1" });
  });

  it.each([
    ["plain rtmp", streamBody("rtmp://a.rtmp.youtube.com/live2")],
    ["https", streamBody("https://a.rtmps.youtube.com/live2")],
    ["an unparseable URL", streamBody("not a url")],
    ["no stream key", streamBody("rtmps://a.rtmps.youtube.com/live2", "")],
    ["another stream id", { items: [{ id: "stream-2" }] }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => youtubeStreamIngest(body, "stream-1"))).toEqual(malformedAnswer);
  });
});

describe("parseYouTubeUploadInput", () => {
  it("a default public upload", () => {
    const media = streamMedia();
    expect(parseYouTubeUploadInput(uploadInput({ media: [media] }))).toEqual({
      contentType: "video/mp4",
      description: "Title line\nDescription line",
      fileSize: 4,
      media,
      privacyStatus: "public",
      tags: ["launch"],
      title: "Title line",
    });
  });

  it("an unlisted QuickTime upload with madeForKids set", () => {
    const media = streamMedia({ contentType: "video/quicktime; codecs=hvc1" });
    expect(
      parseYouTubeUploadInput(
        uploadInput({
          media: [media],
          providerOptions: { youtube: { madeForKids: true, privacyStatus: "unlisted" } },
        }),
      ),
    ).toEqual({
      contentType: "video/quicktime",
      description: "Title line\nDescription line",
      fileSize: 4,
      madeForKids: true,
      media,
      privacyStatus: "unlisted",
      tags: ["launch"],
      title: "Title line",
    });
  });

  it("a title of 100 emoji and a 5000-byte description", () => {
    const title = "🎬".repeat(100);
    const description = `${title}\n${"a".repeat(5_000 - 401)}`;
    const media = streamMedia({
      metadata: { durationSeconds: 43_200, height: 1, width: 1 },
    });
    expect(parseYouTubeUploadInput(uploadInput({ caption: description, media: [media] }))).toEqual({
      contentType: "video/mp4",
      description,
      fileSize: 4,
      media,
      privacyStatus: "public",
      tags: ["launch"],
      title,
    });
  });

  it("refuses a blank idempotency key", () => {
    expect(thrownBy(() => parseYouTubeUploadInput(uploadInput({ idempotencyKey: " " })))).toEqual(
      new TypeError("idempotencyKey is invalid"),
    );
  });

  it.each([
    ["no media", { media: [] }],
    ["two videos", { media: [streamMedia(), streamMedia()] }],
    [
      "remote ingest media",
      {
        media: [
          {
            contentType: "video/mp4",
            fileSize: 4,
            metadata: { durationSeconds: 60, height: 1080, width: 1920 },
            mode: "remote_ingest",
            url: "https://assets.example/v.mp4",
          } satisfies ProviderMedia,
        ],
      },
    ],
    ["a blank caption", { caption: "   " }],
    ["a title of 101 code points", { caption: "a".repeat(101) }],
    ["a description of 5001 UTF-8 bytes", { caption: `t\n${"a".repeat(4_999)}` }],
    ["angle brackets in the title", { caption: "A <Short>" }],
    ["angle brackets in the description", { caption: "Title\nBody > limit" }],
    ["thirty-one hashtags", { hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
    ["hashtags joined over 500 characters", { hashtags: ["a".repeat(251), "b".repeat(250)] }],
    ["missing metadata", { media: [streamMedia({ metadata: undefined })] }],
    [
      "zero duration",
      { media: [streamMedia({ metadata: { durationSeconds: 0, height: 1080, width: 1920 } })] },
    ],
    [
      "duration over 12 hours",
      {
        media: [streamMedia({ metadata: { durationSeconds: 43_201, height: 1080, width: 1920 } })],
      },
    ],
    [
      "zero width",
      { media: [streamMedia({ metadata: { durationSeconds: 60, height: 1080, width: 0 } })] },
    ],
    [
      "zero height",
      { media: [streamMedia({ metadata: { durationSeconds: 60, height: 0, width: 1920 } })] },
    ],
  ])("refuses %s as youtube_video_invalid", (_example, patch) => {
    expect(failureThrownBy(() => parseYouTubeUploadInput(uploadInput(patch)))).toEqual(
      refused("youtube_video_invalid"),
    );
  });

  it.each([
    ["an unsupported media type", { media: [streamMedia({ contentType: "video/webm" })] }],
    ["an empty file", { media: [streamMedia({ fileSize: 0 })] }],
    ["a file over the limit", { media: [streamMedia({ fileSize: 500 * 1024 * 1024 + 1 })] }],
  ])("refuses %s as youtube_media_invalid", (_example, patch) => {
    expect(failureThrownBy(() => parseYouTubeUploadInput(uploadInput(patch)))).toEqual(
      refused("youtube_media_invalid"),
    );
  });

  it.each<[string, Partial<PublishInput>]>([
    [
      "a non-boolean madeForKids",
      { providerOptions: { youtube: { madeForKids: "no" as never, privacyStatus: "public" } } },
    ],
    [
      "an unknown privacy status",
      { providerOptions: { youtube: { madeForKids: false, privacyStatus: "friends" as never } } },
    ],
  ])("refuses %s as youtube_publish_options_invalid", (_example, patch) => {
    expect(failureThrownBy(() => parseYouTubeUploadInput(uploadInput(patch)))).toEqual(
      refused("youtube_publish_options_invalid"),
    );
  });
});

describe("acknowledgedOffset", () => {
  it("no Range header falls back to absent", () => {
    expect(acknowledgedOffset(new Headers(), 4, 2)).toEqual(2);
  });

  it("a partial Range header", () => {
    expect(acknowledgedOffset(new Headers({ Range: "bytes=0-1" }), 4, 0)).toEqual(2);
  });

  it("a Range header ending on the last byte", () => {
    expect(acknowledgedOffset(new Headers({ Range: "bytes=0-3" }), 4, 0)).toEqual(4);
  });

  it.each([
    ["a Range past fileSize", "bytes=0-4"],
    ["a non-zero start", "bytes=1-3"],
    ["unparseable text", "items=0-1"],
  ])("refuses %s", (_example, range) => {
    expect(failureThrownBy(() => acknowledgedOffset(new Headers({ Range: range }), 4, 0))).toEqual(
      malformedAnswer,
    );
  });
});

describe("youtubeVideoStatus", () => {
  it("no items", () => {
    expect(youtubeVideoStatus({ items: [] }, "video-1", "channel-1", "video:video-1")).toEqual({
      state: "not_found",
    });
  });

  it.each([
    ["uploaded and processing", { processingStatus: "processing", uploadStatus: "uploaded" }],
    [
      "uploaded with terminated processing",
      { processingStatus: "terminated", uploadStatus: "uploaded" },
    ],
  ])("still processing when %s", (_example, patch) => {
    expect(
      youtubeVideoStatus({ items: [videoItem(patch)] }, "video-1", "channel-1", "video:video-1"),
    ).toEqual({
      providerOperationId: "video:video-1",
      state: "processing",
    });
  });

  it.each([
    [
      "processed and succeeded public",
      { privacyStatus: "public", processingStatus: "succeeded", uploadStatus: "processed" },
    ],
    [
      "processed and terminated unlisted",
      { privacyStatus: "unlisted", processingStatus: "terminated", uploadStatus: "processed" },
    ],
    [
      "processed private",
      { privacyStatus: "private", processingStatus: "succeeded", uploadStatus: "processed" },
    ],
  ])("published when %s", (_example, patch) => {
    expect(
      youtubeVideoStatus({ items: [videoItem(patch)] }, "video-1", "channel-1", "video:video-1"),
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

  it("another channel fails with mismatch", () => {
    expect(
      youtubeVideoStatus(
        { items: [videoItem({ channelId: "channel-2" })] },
        "video-1",
        "channel-1",
        "video:video-1",
      ),
    ).toEqual({
      result: {
        failure: providerFailure("deterministic", "youtube_channel_mismatch"),
        outcome: "confirmed_failure",
        providerOperationId: "video:video-1",
      },
      state: "failed",
    });
  });

  it.each([
    ["processing failed", { processingStatus: "failed" }],
    ["upload deleted", { uploadStatus: "deleted" }],
    ["upload failed", { uploadStatus: "failed" }],
    ["upload rejected", { uploadStatus: "rejected" }],
  ])("fails when %s", (_example, patch) => {
    expect(
      youtubeVideoStatus({ items: [videoItem(patch)] }, "video-1", "channel-1", "video:video-1"),
    ).toEqual({
      result: {
        failure: providerFailure("deterministic", "youtube_video_processing_failed"),
        outcome: "confirmed_failure",
        providerOperationId: "video:video-1",
      },
      state: "failed",
    });
  });

  it.each([
    ["two items", { items: [videoItem(), videoItem()] }],
    ["a nextPageToken", { items: [videoItem()], nextPageToken: "next" }],
    ["another video id", { items: [videoItem({ id: "video-2" })] }],
    [
      "an unknown privacy status on processed",
      {
        items: [
          videoItem({
            privacyStatus: "friends",
            processingStatus: "succeeded",
            uploadStatus: "processed",
          }),
        ],
      },
    ],
    ["a missing status field", { items: [{ id: "video-1", snippet: { channelId: "channel-1" } }] }],
  ])("refuses %s", (_example, body) => {
    expect(
      failureThrownBy(() => youtubeVideoStatus(body, "video-1", "channel-1", "video:video-1")),
    ).toEqual(malformedAnswer);
  });
});

describe("youtubeContinuationMedia", () => {
  it("matching stream media", () => {
    const media = streamMedia({ contentType: "video/quicktime; codecs=avc1" });
    expect(youtubeContinuationMedia(media, 4)).toEqual({
      contentType: "video/quicktime",
      media,
    });
  });

  it.each([
    [
      "remote ingest media",
      {
        contentType: "video/mp4",
        fileSize: 4,
        mode: "remote_ingest",
        url: "https://assets.example/v.mp4",
      } satisfies ProviderMedia,
    ],
    ["a mismatched file size", streamMedia({ fileSize: 8 })],
    ["an unsupported media type", streamMedia({ contentType: "video/webm" })],
  ])("returns undefined for %s", (_example, media) => {
    expect(youtubeContinuationMedia(media, 4)).toEqual(undefined);
  });
});
