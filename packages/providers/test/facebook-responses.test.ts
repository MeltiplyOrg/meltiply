import { describe, expect, it } from "vite-plus/test";

import type { FacebookReelStatus } from "../src/facebook/types";
import {
  decodeRefreshSecret,
  encodeRefreshSecret,
  expiryDiagnostic,
  facebookAccountFollowers,
  facebookBroadcastInfo,
  facebookInspectedExpiry,
  facebookPageConnection,
  facebookPostStatus,
  facebookReelEngagement,
  facebookReelLookupStatus,
  facebookStoryStatus,
  facebookVideoStatus,
  grantedPermissions,
  liveOperation,
  nextPageCursor,
  oauthMalformed,
  photoUrl,
  remoteVideoUrl,
} from "../src/facebook/responses";
import type { ProviderMedia, PublishInput } from "../src/types";
import { failureThrownBy, malformedAnswer, providerFailure, refused, thrownBy } from "./support";

const NOW = new Date("2026-07-19T00:00:00.123Z");

const remoteVideo = (patch: Partial<ProviderMedia> = {}) =>
  ({
    contentType: "video/mp4",
    fileSize: 1024,
    mode: "remote_ingest",
    url: "https://assets.example/video.mp4",
    ...patch,
  }) as ProviderMedia;

const remoteImage = (patch: Partial<ProviderMedia> = {}) =>
  ({
    contentType: "image/jpeg",
    fileSize: 1024,
    mode: "remote_ingest",
    url: "https://assets.example/photo.jpg",
    ...patch,
  }) as ProviderMedia;

const publishInput = (media: ProviderMedia[]): PublishInput => ({
  caption: "Caption",
  hashtags: [],
  idempotencyKey: "publish-1",
  media,
});

describe("oauthMalformed and expiryDiagnostic", () => {
  it("builds a transient malformed error with the field code", () => {
    const cause = expiryDiagnostic("exchange", {
      expiry: 0,
      ignored: undefined,
      flag: true,
      raw: "x",
    });
    const error = oauthMalformed("token_expiry", cause);

    expect(error.failure).toEqual(
      providerFailure("transient", "facebook_oauth_token_expiry_invalid"),
    );
    expect(cause.message).toEqual(
      "Facebook OAuth expiry rejected: source=exchange, expiry=0, flag=true, raw=string, maximum_seconds=7776000",
    );
  });
});

describe("decodeRefreshSecret and encodeRefreshSecret", () => {
  it("round trips a page refresh secret", () => {
    const secret = { pageId: "page-1", userAccessToken: "user-token" };
    const encoded = encodeRefreshSecret(secret);

    expect(encoded).toEqual('{"pageId":"page-1","userAccessToken":"user-token"}');
    expect(decodeRefreshSecret(encoded)).toEqual(secret);
  });

  it.each([
    ["non-JSON", "not-json"],
    ["an extra key", '{"pageId":"page-1","userAccessToken":"t","extra":1}'],
    ["missing pageId", '{"pageId":"","userAccessToken":"t"}'],
    ["missing token", '{"pageId":"page-1","userAccessToken":""}'],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => decodeRefreshSecret(value))).toEqual(
      refused("facebook_refresh_secret_invalid"),
    );
  });

  it("refuses a blank secret", () => {
    expect(thrownBy(() => decodeRefreshSecret("   "))).toEqual(
      new TypeError("refreshToken is invalid"),
    );
  });
});

describe("grantedPermissions", () => {
  it("keeps only unique granted permissions", () => {
    expect(
      grantedPermissions({
        data: [
          { permission: "pages_show_list", status: "GRANTED" },
          { permission: "pages_show_list", status: "granted" },
          { permission: "email", status: "declined" },
        ],
      }),
    ).toEqual(["pages_show_list"]);
  });

  it.each([
    ["no data list", { data: null }],
    ["an entry without permission", { data: [{ status: "granted" }] }],
    ["an entry without status", { data: [{ permission: "pages_show_list" }] }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => grantedPermissions(body))).toEqual(
      providerFailure("transient", "facebook_oauth_permissions_invalid"),
    );
  });
});

describe("nextPageCursor", () => {
  it("absent paging returns undefined", () => {
    expect(nextPageCursor(undefined, new Set())).toEqual(undefined);
  });

  it("paging without next returns undefined", () => {
    expect(nextPageCursor({ cursors: { after: "cursor-1" } }, new Set())).toEqual(undefined);
  });

  it("valid next URL with matching after cursor", () => {
    const seen = new Set<string>();
    const cursor = nextPageCursor(
      {
        cursors: { after: "cursor-2" },
        next: "https://graph.facebook.com/v25.0/me/accounts?after=cursor-2",
      },
      seen,
    );

    expect(cursor).toEqual("cursor-2");
    expect([...seen]).toEqual(["cursor-2"]);
  });

  it("valid next URL providing the cursor alone", () => {
    expect(
      nextPageCursor(
        { next: "https://graph.facebook.com/v25.0/me/accounts?after=cursor-2" },
        new Set(),
      ),
    ).toEqual("cursor-2");
  });

  it.each([
    ["non-object paging", "bad", []],
    ["non-object cursors", { cursors: "bad" }, []],
    ["a control character in cursors.after", { cursors: { after: "\u0000bad" } }, []],
    ["an unparseable next URL", { next: "not a url" }, []],
    ["another origin in next", { next: "https://evil.example/v25.0/me/accounts?after=c1" }, []],
    [
      "conflicting cursors",
      {
        cursors: { after: "c1" },
        next: "https://graph.facebook.com/v25.0/me/accounts?after=c2",
      },
      [],
    ],
    ["next without any cursor", { next: "https://graph.facebook.com/v25.0/me/accounts" }, []],
    [
      "a repeated cursor",
      {
        cursors: { after: "c1" },
        next: "https://graph.facebook.com/v25.0/me/accounts?after=c1",
      },
      ["c1"],
    ],
  ])("refuses %s", (_example, paging, seen) => {
    expect(failureThrownBy(() => nextPageCursor(paging, new Set(seen)))).toEqual(
      providerFailure("transient", "facebook_oauth_page_pagination_invalid"),
    );
  });
});

describe("facebookInspectedExpiry", () => {
  it("zero expires_at means non-expiring", () => {
    expect(
      facebookInspectedExpiry(
        { data: { app_id: "fb-app", expires_at: 0, is_valid: true } },
        "fb-app",
        NOW,
      ),
    ).toEqual(undefined);
  });

  it("a future timestamp returns ISO expiry aligned to seconds", () => {
    expect(
      facebookInspectedExpiry(
        { data: { app_id: "fb-app", expires_at: 1_788_566_400, is_valid: true } },
        "fb-app",
        NOW,
      ),
    ).toEqual("2026-09-05T00:00:00.000Z");
  });

  it.each([
    ["another app", { app_id: "other", expires_at: 0, is_valid: true }],
    ["invalid token", { app_id: "fb-app", expires_at: 0, is_valid: false }],
    ["negative expiry", { app_id: "fb-app", expires_at: -1, is_valid: true }],
    ["past expiry", { app_id: "fb-app", expires_at: 1_700_000_000, is_valid: true }],
    ["expiry past max lifetime", { app_id: "fb-app", expires_at: 2_000_000_000, is_valid: true }],
    ["string expiry", { app_id: "fb-app", expires_at: "1788566400", is_valid: true }],
    ["missing expiry", { app_id: "fb-app", is_valid: true }],
  ])("refuses %s", (_example, data) => {
    expect(failureThrownBy(() => facebookInspectedExpiry({ data }, "fb-app", NOW))).toEqual(
      providerFailure("transient", "facebook_oauth_token_expiry_invalid"),
    );
  });
});

describe("facebookPageConnection", () => {
  const longToken = { accessToken: "long-user", expiresAt: "2026-09-17T00:00:00.000Z" };
  const scopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

  it("a publishable Page with avatar and vanity handle", () => {
    expect(
      facebookPageConnection(
        {
          access_token: "page-token",
          id: "page-1",
          link: "https://www.facebook.com/meltiply.page",
          name: "Meltiply Page",
          picture: { data: { url: "https://cdn.example/page.jpg" } },
          tasks: ["CREATE_CONTENT"],
        },
        longToken,
        scopes,
      ),
    ).toEqual({
      accessToken: "page-token",
      account: {
        avatarUrl: "https://cdn.example/page.jpg",
        displayName: "Meltiply Page",
        id: "page-1",
        username: "meltiply.page",
      },
      expiresAt: "2026-09-17T00:00:00.000Z",
      refreshToken: '{"pageId":"page-1","userAccessToken":"long-user"}',
      scopes,
    });
  });

  it("ignores reserved, numeric, query-based, and foreign links", () => {
    expect(
      facebookPageConnection(
        {
          access_token: "page-token",
          id: "page-2",
          link: "https://www.facebook.com/profile.php?id=page-2",
          name: "Page Two",
          picture: "https://cdn.example/flat.jpg",
          tasks: ["PROFILE_PLUS_CREATE_CONTENT"],
        },
        { accessToken: "long-user" },
        scopes,
      ),
    ).toEqual({
      accessToken: "page-token",
      account: {
        avatarUrl: "https://cdn.example/flat.jpg",
        displayName: "Page Two",
        id: "page-2",
      },
      refreshToken: '{"pageId":"page-2","userAccessToken":"long-user"}',
      scopes,
    });
  });

  it("returns undefined for a Page without content tasks", () => {
    expect(
      facebookPageConnection(
        {
          access_token: "page-token",
          id: "page-3",
          name: "Read Only Page",
          tasks: ["ANALYZE", "MODERATE"],
        },
        longToken,
        scopes,
      ),
    ).toEqual(undefined);
  });

  it.each([
    [
      "missing identity",
      { access_token: "t", tasks: ["CREATE_CONTENT"] },
      "facebook_oauth_page_identity_invalid",
    ],
    [
      "missing page token",
      { id: "page-1", name: "Page", tasks: ["CREATE_CONTENT"] },
      "facebook_oauth_page_access_token_invalid",
    ],
    [
      "non-array tasks",
      { access_token: "t", id: "page-1", name: "Page", tasks: "CREATE_CONTENT" },
      "facebook_oauth_page_tasks_invalid",
    ],
    [
      "lowercase task",
      { access_token: "t", id: "page-1", name: "Page", tasks: ["create_content"] },
      "facebook_oauth_page_tasks_invalid",
    ],
  ])("refuses %s", (_example, page, code) => {
    expect(failureThrownBy(() => facebookPageConnection(page, longToken, scopes))).toEqual(
      providerFailure("transient", code),
    );
  });
});

describe("facebookAccountFollowers", () => {
  it("a follower count", () => {
    expect(facebookAccountFollowers({ followers_count: 420 })).toEqual(420);
  });

  it("refuses a missing follower count", () => {
    expect(failureThrownBy(() => facebookAccountFollowers({ fan_count: 10 }))).toEqual(
      malformedAnswer,
    );
  });
});

describe("facebookReelEngagement", () => {
  it("derives shares from social actions minus comments", () => {
    expect(
      facebookReelEngagement(
        new Map([
          ["blue_reels_play_count", 1200],
          ["post_video_social_actions", 21],
        ]),
        { comments: { summary: { total_count: 9 } }, likes: { summary: { total_count: 84 } } },
      ),
    ).toEqual({ comments: 9, likes: 84, shares: 12, views: 1200 });
  });

  it("refuses social actions lower than comments", () => {
    expect(
      failureThrownBy(() =>
        facebookReelEngagement(
          new Map([
            ["blue_reels_play_count", 1200],
            ["post_video_social_actions", 4],
          ]),
          { comments: { summary: { total_count: 9 } }, likes: { summary: { total_count: 84 } } },
        ),
      ),
    ).toEqual(malformedAnswer);
  });

  it("refuses a missing metric", () => {
    expect(
      failureThrownBy(() =>
        facebookReelEngagement(new Map([["post_video_social_actions", 0]]), {
          comments: { summary: { total_count: 0 } },
          likes: { summary: { total_count: 0 } },
        }),
      ),
    ).toEqual(malformedAnswer);
  });
});

describe("remoteVideoUrl", () => {
  it("a valid remote MP4 URL", () => {
    expect(remoteVideoUrl(publishInput([remoteVideo()]))).toEqual(
      "https://assets.example/video.mp4",
    );
  });

  it.each([
    ["no media", []],
    ["two videos", [remoteVideo(), remoteVideo()]],
    [
      "byte_upload media",
      [
        {
          body: new ReadableStream<Uint8Array>(),
          contentType: "video/mp4",
          fileSize: 1024,
          mode: "byte_upload",
        } satisfies ProviderMedia,
      ],
    ],
  ])("refuses %s as facebook_reel_invalid", (_example, media) => {
    expect(failureThrownBy(() => remoteVideoUrl(publishInput(media)))).toEqual(
      refused("facebook_reel_invalid"),
    );
  });

  it.each([
    ["unsupported content type", remoteVideo({ contentType: "video/webm" })],
    ["insecure URL", remoteVideo({ url: "http://assets.example/video.mp4" })],
    ["empty file", remoteVideo({ fileSize: 0 })],
  ])("refuses %s as facebook_reel_media_invalid", (_example, media) => {
    expect(failureThrownBy(() => remoteVideoUrl(publishInput([media])))).toEqual(
      refused("facebook_reel_media_invalid"),
    );
  });
});

describe("photoUrl", () => {
  it("a valid remote JPEG URL", () => {
    expect(photoUrl(remoteImage())).toEqual("https://assets.example/photo.jpg");
  });

  it.each([
    ["an unsupported type", remoteImage({ contentType: "image/webp" })],
    ["an insecure URL", remoteImage({ url: "http://assets.example/photo.jpg" })],
    ["a file over the image limit", remoteImage({ fileSize: 10 * 1024 * 1024 + 1 })],
    [
      "streamed media",
      {
        body: new ReadableStream<Uint8Array>(),
        contentType: "image/jpeg",
        fileSize: 100,
        mode: "byte_upload",
      } satisfies ProviderMedia,
    ],
  ])("refuses %s", (_example, media) => {
    expect(failureThrownBy(() => photoUrl(media))).toEqual(refused("facebook_photo_invalid"));
  });
});

describe("liveOperation", () => {
  it("a live operation", () => {
    expect(liveOperation({ providerOperationId: "live:live-1" })).toEqual({
      id: "live-1",
      phase: "live",
    });
  });

  it("refuses a non-live operation", () => {
    expect(
      failureThrownBy(() => liveOperation({ providerOperationId: "ended_live:live-1" })),
    ).toEqual(malformedAnswer);
  });
});

describe("facebookBroadcastInfo", () => {
  const stream = "rtmps://live-api.facebook.com:443/rtmp/secret";

  it.each([
    ["LIVE", "live", { providerPostId: "live-1" }],
    ["LIVE_NOW", "live", { providerPostId: "live-1" }],
    ["PREVIEW", "testing", {}],
    ["UNPUBLISHED", "ready", {}],
  ] as const)("an active %s broadcast", (status, state, extra) => {
    expect(
      facebookBroadcastInfo({ id: "live-1", secure_stream_url: stream, status }, "live-1"),
    ).toEqual({
      ingestUrl: stream,
      providerUrl: "https://www.facebook.com/live-1",
      state,
      ...extra,
    });
  });

  it("a VOD broadcast ends with its permalink", () => {
    expect(facebookBroadcastInfo({ id: "live-1", status: "VOD" }, "live-1")).toEqual({
      providerPostId: "live-1",
      providerUrl: "https://www.facebook.com/live-1",
      state: "ended",
    });
  });

  it("a canceled broadcast ends without a video ID", () => {
    expect(facebookBroadcastInfo({ id: "live-1", status: "SCHEDULED_CANCELED" }, "live-1")).toEqual(
      {
        state: "ended",
      },
    );
  });

  it.each([
    ["another ID", { id: "live-2", status: "VOD" }],
    ["an unknown status", { id: "live-1", status: "UNKNOWN" }],
    ["non-rtmps ingest URL", { id: "live-1", secure_stream_url: "https://x.test", status: "LIVE" }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => facebookBroadcastInfo(body, "live-1"))).toEqual(malformedAnswer);
  });
});

describe("facebookStoryStatus", () => {
  it("a published story with permalink", () => {
    expect(
      facebookStoryStatus(
        {
          data: [
            {
              media_id: "media-1",
              post_id: 987,
              status: "PUBLISHED",
              url: "https://www.facebook.com/stories/987",
            },
          ],
        },
        "media-1",
      ),
    ).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "story:media-1",
        providerPostId: "987",
        providerUrl: "https://www.facebook.com/stories/987",
      },
      state: "published",
    });
  });

  it("an absent story stays unknown", () => {
    expect(facebookStoryStatus({ data: [] }, "media-1")).toEqual({
      result: {
        failure: providerFailure("ambiguous", "facebook_story_evidence_pending"),
        outcome: "unknown",
        providerOperationId: "story:media-1",
      },
      state: "unknown",
    });
  });

  it.each([
    ["no data list", {}],
    [
      "an unconfirmed story status",
      { data: [{ media_id: "media-1", post_id: "1", status: "DRAFT" }] },
    ],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => facebookStoryStatus(body, "media-1"))).toEqual(malformedAnswer);
  });
});

describe("facebookVideoStatus", () => {
  it("a ready video resolves as published", () => {
    expect(
      facebookVideoStatus(
        { id: "vid-1", status: { video_status: "ready" } },
        { id: "vid-1", phase: "video" },
      ),
    ).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "video:vid-1",
        providerPostId: "vid-1",
        providerUrl: "https://www.facebook.com/vid-1",
      },
      state: "published",
    });
  });

  it("a ready video draft resolves as delivered", () => {
    expect(
      facebookVideoStatus(
        { id: "vid-1", status: { video_status: "ready" } },
        { id: "vid-1", phase: "video_draft" },
      ),
    ).toEqual({
      result: {
        delivery: "draft",
        outcome: "confirmed_success",
        providerOperationId: "video_draft:vid-1",
      },
      state: "delivered",
    });
  });

  it("a processing video stays processing", () => {
    expect(
      facebookVideoStatus(
        { id: "vid-1", status: { video_status: "processing" } },
        { id: "vid-1", phase: "video" },
      ),
    ).toEqual({ providerOperationId: "video:vid-1", state: "processing" });
  });

  it("a failed video resolves as confirmed_failure", () => {
    expect(
      facebookVideoStatus(
        { id: "vid-1", status: { video_status: "expired" } },
        { id: "vid-1", phase: "video" },
      ),
    ).toEqual({
      result: {
        failure: refused("facebook_video_processing_failed"),
        outcome: "confirmed_failure",
        providerOperationId: "video:vid-1",
      },
      state: "failed",
    });
  });

  it("refuses another video ID", () => {
    expect(
      failureThrownBy(() =>
        facebookVideoStatus(
          { id: "vid-2", status: { video_status: "ready" } },
          { id: "vid-1", phase: "video" },
        ),
      ),
    ).toEqual(malformedAnswer);
  });
});

describe("facebookPostStatus", () => {
  it("a published post", () => {
    expect(facebookPostStatus({ id: "p_1", is_published: true }, "p_1", "post")).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "post:p_1",
        providerPostId: "p_1",
        providerUrl: "https://www.facebook.com/p_1",
      },
      state: "published",
    });
  });

  it("an unpublished post_draft is delivered", () => {
    expect(facebookPostStatus({ id: "p_1", is_published: false }, "p_1", "post_draft")).toEqual({
      result: {
        delivery: "draft",
        outcome: "confirmed_success",
        providerOperationId: "post_draft:p_1",
      },
      state: "delivered",
    });
  });

  it("an unpublished post stays processing", () => {
    expect(facebookPostStatus({ id: "p_1", is_published: false }, "p_1", "post")).toEqual({
      providerOperationId: "post:p_1",
      state: "processing",
    });
  });

  it("refuses a non-boolean is_published", () => {
    expect(
      failureThrownBy(() => facebookPostStatus({ id: "p_1", is_published: "yes" }, "p_1", "post")),
    ).toEqual(malformedAnswer);
  });
});

describe("facebookReelLookupStatus", () => {
  const base: FacebookReelStatus = {
    processing: "in_progress",
    publishing: "not_started",
    uploading: "complete",
    video: "processing",
  };

  it("a failed status resolves as failed", () => {
    expect(
      facebookReelLookupStatus({ ...base, video: "expired" }, "vid-1", {
        id: "vid-1",
        phase: "finishing",
      }),
    ).toEqual({
      result: {
        failure: refused("facebook_reel_processing_failed"),
        outcome: "confirmed_failure",
        providerOperationId: "finishing:vid-1",
      },
      state: "failed",
    });
  });

  it("a published status resolves as published", () => {
    expect(
      facebookReelLookupStatus({ ...base, publishing: "completed" }, "vid-1", {
        id: "vid-1",
        phase: "finish_submitted",
      }),
    ).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "finish_submitted:vid-1",
        providerPostId: "vid-1",
      },
      state: "published",
    });
  });

  it("a ready reel_draft resolves as delivered", () => {
    expect(
      facebookReelLookupStatus({ ...base, video: "ready" }, "vid-1", {
        id: "vid-1",
        phase: "reel_draft",
      }),
    ).toEqual({
      result: {
        delivery: "draft",
        outcome: "confirmed_success",
        providerOperationId: "reel_draft:vid-1",
      },
      state: "delivered",
    });
  });

  it("a processing reel_draft stays processing", () => {
    expect(facebookReelLookupStatus(base, "vid-1", { id: "vid-1", phase: "reel_draft" })).toEqual({
      providerOperationId: "reel_draft:vid-1",
      state: "processing",
    });
  });

  it.each([
    ["finish_submitted", "facebook_finish_evidence_pending"],
    ["upload_submitted", "facebook_upload_evidence_pending"],
  ] as const)("an unconfirmed %s phase stays unknown", (phase, code) => {
    expect(facebookReelLookupStatus(base, "vid-1", { id: "vid-1", phase })).toEqual({
      result: {
        failure: providerFailure("ambiguous", code),
        outcome: "unknown",
        providerOperationId: `${phase}:vid-1`,
      },
      state: "unknown",
    });
  });

  it("a finishing phase stays processing", () => {
    expect(facebookReelLookupStatus(base, "vid-1", undefined)).toEqual({
      providerOperationId: "finishing:vid-1",
      state: "processing",
    });
  });
});
