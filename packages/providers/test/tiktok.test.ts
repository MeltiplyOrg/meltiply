import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ProviderAdapterError } from "../src/failures";
import { createTikTokAdapter } from "../src/tiktok/adapter";
import type { PublishInput, TikTokPublishOptions } from "../src/types";
import {
  failureOf,
  malformedAnswer,
  providerFailure,
  refused,
  unavailable,
  unconfirmed,
} from "./support";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "access", accountId: "o1" };
const redirectUri = "https://api.example.com/api/v1/platforms/tiktok/callback";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const API = "https://open.tiktokapis.com";
const mediaUrl = "https://media.example/assets/a";
const scopes = ["user.info.basic", "video.publish"];

type Answer = Response | Error;

function setup(answers: Answer[] = []) {
  const requests: object[] = [];
  const adapter = createTikTokAdapter({
    clientId: "client",
    clientSecret: "secret",
    mediaUrlPrefix: "https://media.example/assets/",
    now: () => NOW,
    redirectUri,
    fetch: (target, init) => {
      const body = init?.body;
      requests.push({
        method: init?.method,
        url: String(target),
        ...(body === undefined ? {} : { body: String(body) }),
      });
      const answer = answers.shift() ?? new Error("unexpected request");
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  return { adapter, requests };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = (data: object) => json({ data, error: { code: "ok" } });
const down = () => json({}, 503);
const post = (path: string, body?: object) => ({
  method: "POST",
  url: `${API}${path}`,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const get = (path: string) => ({ method: "GET", url: `${API}${path}` });
const choices: TikTokPublishOptions = {
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandContent: false,
  brandOrganic: false,
  isAiGenerated: false,
  musicUsageConfirmed: true,
  privacyLevel: "PUBLIC_TO_EVERYONE",
};
const input = (options: Partial<TikTokPublishOptions> = {}): PublishInput => ({
  caption: "Title",
  hashtags: [],
  idempotencyKey: "k",
  media: [
    {
      contentType: "video/mp4",
      fileSize: 100,
      metadata: { durationSeconds: 30, width: 1_080, height: 1_920 },
      mode: "remote_ingest",
      url: mediaUrl,
    },
  ],
  providerOptions: { tiktok: { ...choices, ...options } },
});
const creator = () =>
  ok({
    creator_username: "u",
    creator_nickname: "N",
    privacy_level_options: ["PUBLIC_TO_EVERYONE"],
    comment_disabled: true,
    duet_disabled: true,
    stitch_disabled: true,
    max_video_post_duration_sec: 600,
  });
const creatorQuery = post("/v2/post/publish/creator_info/query/");
const token = (scope = scopes.join(",")) =>
  json({
    access_token: "access",
    refresh_token: "refresh",
    open_id: "o1",
    expires_in: 3_600,
    scope,
    token_type: "Bearer",
  });
const sourceInfo = { source: "PULL_FROM_URL", video_url: mediaUrl };
const directBody = {
  post_info: {
    brand_content_toggle: false,
    brand_organic_toggle: false,
    disable_comment: true,
    privacy_level: "PUBLIC_TO_EVERYONE",
    disable_duet: true,
    disable_stitch: true,
    is_aigc: false,
    title: "Title",
  },
  source_info: sourceInfo,
};
const exchange = { code: "code", codeVerifier: "unused", redirectUri };

beforeAll(async () => {
  await setup([ok({ publish_id: "v" })]).adapter.publish!(
    context,
    credentials,
    input({ postMode: "inbox" }),
  );
});

describe("createTikTokAdapter", () => {
  it("authorizationUrl", () => {
    const url = setup().adapter.authorizationUrl!({
      codeChallenge: "c",
      redirectUri,
      state: "s",
    });

    expect(url).toEqual(
      `https://www.tiktok.com/v2/auth/authorize/?client_key=client&disable_auto_auth=1&scope=user.info.basic%2Cvideo.publish%2Cvideo.upload%2Cuser.info.profile%2Cuser.info.stats%2Cvideo.list&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=s`,
    );
  });

  it("capability", () => {
    expect(setup().adapter.capability).toEqual({
      accepted_mime_types: ["image/jpeg", "image/webp", "video/mp4", "video/quicktime"],
      analytics: true,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      max_caption_length: 4_000,
      max_file_size: 524_288_000,
      max_hashtags: 30,
      max_media_count: 35,
      max_video_duration_sec: 600,
      min_media_count: 1,
      multi_asset_types: ["image"],
      notes: [
        "One video or up to 35 images can publish directly or be handed to the creator's TikTok inbox for native completion.",
        "A photo post is images only; mixing a video with images is not supported.",
        "Privacy, interaction, commercial-content, AI, and music-usage choices are explicit per target.",
        "Media uses PULL_FROM_URL from an HTTPS URL prefix verified in the TikTok developer portal.",
        "The Channel username appears only when the optional user.info.profile scope is granted.",
        "Direct Post re-queries creator permissions immediately before publication; inbox upload requires video.upload and is not a published outcome.",
        "Analytics reads the creator's own view, like, comment, and share counters; comments and replies are not claimed.",
        "Existing connections must reconnect to grant the video.list analytics scope.",
        "TikTok app audit and approved live-account acceptance remain required.",
      ],
      platform: "tiktok",
      publish: true,
      reply: false,
    });
  });

  describe("exchangeAuthorizationCode", () => {
    const connection = {
      accessToken: "access",
      account: { displayName: "N", id: "o1" },
      expiresAt: "2026-07-19T01:00:00.000Z",
      refreshToken: "refresh",
    };
    const form = `client_key=client&client_secret=secret&code=code&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`;

    it.each([
      ["without profile access", scopes, "open_id%2Cdisplay_name%2Cavatar_url"],
      [
        "with profile access",
        [...scopes, "user.info.profile"],
        "open_id%2Cdisplay_name%2Cavatar_url%2Cusername",
      ],
    ])("a grant %s", async (_example, granted, fields) => {
      const { adapter, requests } = setup([
        token(granted.join(",")),
        ok({ user: { open_id: "o1", display_name: "N" } }),
      ]);

      const result = await adapter.exchangeAuthorizationCode!(context, exchange);

      expect(result).toEqual({ ...connection, scopes: granted });
      expect(requests).toEqual([
        { method: "POST", url: `${API}/v2/oauth/token/`, body: form },
        get(`/v2/user/info/?fields=${fields}`),
      ]);
    });

    it("a grant without publishing", async () => {
      const { adapter, requests } = setup([token("user.info.basic")]);

      const error = await adapter.exchangeAuthorizationCode!(context, exchange).catch(
        (cause: unknown) => cause,
      );

      expect(error).toEqual(
        new ProviderAdapterError(refused("tiktok_scope_not_granted"), {
          missingScopes: ["video.publish"],
        }),
      );
      expect(requests).toEqual([{ method: "POST", url: `${API}/v2/oauth/token/`, body: form }]);
    });

    it.each([
      ["a profile of another user", [token(), ok({ user: { open_id: "o2" } })], malformedAnswer],
      ["TikTok down", [down()], unavailable],
    ])("%s", async (_example, answers, failure) => {
      const { adapter } = setup(answers);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchange))).toEqual(
        failure,
      );
    });
  });

  describe("refreshAccessToken", () => {
    it.each([
      ["a token naming its scopes", scopes.join(","), scopes],
      ["a token without scopes", undefined, []],
    ])("%s", async (_example, scope, expected) => {
      const { adapter, requests } = setup([
        json({ access_token: "a2", refresh_token: "r2", open_id: "o1", expires_in: 60, scope }),
      ]);

      const result = await adapter.refreshAccessToken!(context, "refresh");

      expect(result).toEqual({
        accessToken: "a2",
        expiresAt: "2026-07-19T00:01:00.000Z",
        refreshToken: "r2",
        scopes: expected,
      });
      expect(requests).toEqual([
        {
          method: "POST",
          url: `${API}/v2/oauth/token/`,
          body: "client_key=client&client_secret=secret&grant_type=refresh_token&refresh_token=refresh",
        },
      ]);
    });
  });

  describe("revoke", () => {
    const revocation = {
      method: "POST",
      url: `${API}/v2/oauth/revoke/`,
      body: "client_key=client&client_secret=secret&token=access",
    };

    it("an access token", async () => {
      const { adapter, requests } = setup([json({})]);

      await adapter.revoke!("access");

      expect(requests).toEqual([revocation]);
    });

    it("TikTok down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.revoke!("access", context))).toEqual(unavailable);
    });
  });

  describe("getPublicationRequirements", () => {
    it("the creator's current permissions", async () => {
      const { adapter, requests } = setup([creator()]);

      const result = await adapter.getPublicationRequirements!(context, credentials);

      expect(result).toEqual({
        commentAllowed: false,
        creatorDisplayName: "N",
        creatorUsername: "u",
        duetAllowed: false,
        maxVideoDurationSeconds: 600,
        platform: "tiktok",
        privacyLevels: ["PUBLIC_TO_EVERYONE"],
        stitchAllowed: false,
      });
      expect(requests).toEqual([creatorQuery]);
    });

    it("no account sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(adapter.getPublicationRequirements!(context, { accessToken: "a" })),
      ).toEqual(refused("tiktok_account_required"));
      expect(requests).toEqual([]);
    });
  });

  describe("getAccountAnalytics", () => {
    it("the creator's counters", async () => {
      const { adapter, requests } = setup([ok({ user: { follower_count: 5 } })]);

      const result = await adapter.getAccountAnalytics!(context, credentials);

      expect(result).toEqual({ followers: 5, recordedAt: "2026-07-19T00:00:00.000Z" });
      expect(requests).toEqual([
        get("/v2/user/info/?fields=open_id%2Cfollower_count%2Cfollowing_count%2Cvideo_count"),
      ]);
    });
  });

  describe("listAnalytics", () => {
    const lookup = { providerPostId: "v1" };
    const query = post(
      "/v2/video/query/?fields=id%2Cview_count%2Clike_count%2Ccomment_count%2Cshare_count",
      { filters: { video_ids: ["v1"] } },
    );

    it("a found video", async () => {
      const video = { id: "v1", view_count: 1, like_count: 2, comment_count: 3, share_count: 4 };
      const { adapter, requests } = setup([ok({ videos: [video] })]);

      const result = await adapter.listAnalytics!(context, credentials, lookup, { limit: 1 });

      expect(result).toEqual({
        items: [
          {
            comments: 3,
            impressions: 0,
            likes: 2,
            providerPostId: "v1",
            reach: 0,
            recordedAt: "2026-07-19T00:00:00.000Z",
            shares: 4,
            views: 1,
            watchTimeSeconds: 0,
          },
        ],
      });
      expect(requests).toEqual([query]);
    });

    it("no video", async () => {
      const { adapter } = setup([ok({ videos: [] })]);

      const result = await adapter.listAnalytics!(context, credentials, lookup, { limit: 1 });

      expect(result).toEqual({ items: [] });
    });

    it("a cursor sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.listAnalytics!(context, credentials, lookup, { cursor: "c", limit: 1 }),
        ),
      ).toEqual(refused("tiktok_analytics_not_paginated"));
      expect(requests).toEqual([]);
    });
  });

  describe("publish", () => {
    it("a direct video after checking the creator", async () => {
      const { adapter, requests } = setup([creator(), ok({ publish_id: "v_1" })]);

      const result = await adapter.publish!(context, credentials, input());

      expect(result).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "publish:v_1",
      });
      expect(requests).toEqual([creatorQuery, post("/v2/post/publish/video/init/", directBody)]);
    });

    it("an inbox video without a creator check", async () => {
      const { adapter, requests } = setup([ok({ publish_id: "v_1" })]);

      const result = await adapter.publish!(context, credentials, input({ postMode: "inbox" }));

      expect(result).toEqual({ outcome: "confirmed_success", providerOperationId: "inbox:v_1" });
      expect(requests).toEqual([
        post("/v2/post/publish/inbox/video/init/", { source_info: sourceInfo }),
      ]);
    });

    it("a choice the creator does not allow", async () => {
      const { adapter, requests } = setup([creator()]);

      expect(
        await failureOf(adapter.publish!(context, credentials, input({ allowComment: true }))),
      ).toEqual(refused("tiktok_creator_choice_unavailable"));
      expect(requests).toEqual([creatorQuery]);
    });

    it.each([
      [
        "a rejected write",
        json({ error: { code: "invalid_params" } }),
        { failure: refused("tiktok_invalid_params"), outcome: "confirmed_failure" },
      ],
      ["a write answered without an ID", ok({}), { failure: unconfirmed, outcome: "unknown" }],
      [
        "a lost write",
        new Error("socket"),
        {
          failure: providerFailure("ambiguous", "provider_http_request_failed"),
          outcome: "unknown",
        },
      ],
    ])("%s", async (_example, answer, expected) => {
      const { adapter } = setup([answer]);

      const result = await adapter.publish!(context, credentials, input({ postMode: "inbox" }));

      expect(result).toEqual(expected);
    });

    it.each([
      ["no account", { accessToken: "a" }, input(), refused("tiktok_account_required")],
      [
        "a blank idempotency key",
        credentials,
        { ...input(), idempotencyKey: " " },
        new TypeError("idempotencyKey is invalid"),
      ],
      ["no media", credentials, { ...input(), media: [] }, refused("tiktok_pull_media_required")],
    ])("%s sends nothing", async (_example, who, value, failure) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.publish!(context, who, value))).toEqual(failure);
      expect(requests).toEqual([]);
    });
  });

  describe("lookupPublication", () => {
    const query = post("/v2/post/publish/status/fetch/", { publish_id: "v_1" });

    it("a published post whose ID exceeds safe integers", async () => {
      const { adapter, requests } = setup([
        new Response(
          '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}',
          { headers: { "Content-Type": "application/json" } },
        ),
      ]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "publish:v_1",
      });

      expect(result).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "publish:v_1",
          providerPostId: "7412345678901234567",
        },
        state: "published",
      });
      expect(requests).toEqual([query]);
    });

    it("no publish ID sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.lookupPublication!(context, credentials, {}))).toEqual(
        refused("tiktok_publish_id_required"),
      );
      expect(requests).toEqual([]);
    });
  });

  describe("cancelPublication", () => {
    const operation = { providerOperationId: "publish:v_1" };
    const cancel = post("/v2/post/publish/cancel/", { publish_id: "v_1" });

    it.each([
      [
        "an accepted cancellation",
        ok({}),
        { outcome: "confirmed_success", providerOperationId: "publish:v_1" },
      ],
      [
        "a refused cancellation",
        json({ error: { code: "publish_not_cancellable" } }),
        {
          failure: refused("tiktok_publish_not_cancellable"),
          outcome: "confirmed_failure",
          providerOperationId: "publish:v_1",
        },
      ],
      [
        "TikTok down",
        down(),
        {
          failure: providerFailure("ambiguous", "provider_http_503"),
          outcome: "unknown",
          providerOperationId: "publish:v_1",
        },
      ],
    ])("%s", async (_example, answer, expected) => {
      const { adapter, requests } = setup([answer]);

      const result = await adapter.cancelPublication!(context, credentials, operation);

      expect(result).toEqual(expected);
      expect(requests).toEqual([cancel]);
    });
  });
});
