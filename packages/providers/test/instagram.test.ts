import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createInstagramAdapter, type InstagramAdapterOptions } from "../src/instagram/adapter";
import type { PublishInput } from "../src/types";
import {
  failureOf,
  malformedAnswer,
  refused,
  unavailable,
  unconfirmed,
  providerFailure,
} from "./support";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "access", accountId: "account-1" };
const redirectUri = "https://api.example.com/api/v1/platforms/instagram/callback";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const EXPIRES = "2026-09-17T00:00:00.000Z";
const allScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];
const GRAPH = "https://graph.instagram.com/v25.0";

type Answer = Response | Error;

function setup(answers: Answer[] = [], options: Partial<InstagramAdapterOptions> = {}) {
  const requests: object[] = [];
  const adapter = createInstagramAdapter({
    clientId: "client",
    clientSecret: "secret",
    now: () => NOW,
    redirectUri,
    fetch: (target, init) => {
      const url = new URL(String(target));
      requests.push({
        method: init?.method,
        url: `${url.origin}${url.pathname}`,
        query: Object.fromEntries(url.searchParams),
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
      });
      const answer = answers.shift() ?? new Error("unexpected request");
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    ...options,
  });
  return { adapter, requests };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const down = () => json({}, 503);
const post = (path: string, query: object) => ({ method: "POST", url: `${GRAPH}/${path}`, query });
const get = (path: string, query: object) => ({ method: "GET", url: `${GRAPH}/${path}`, query });
const photo = (name: string) => ({
  contentType: "image/jpeg",
  fileSize: 100,
  mode: "remote_ingest" as const,
  url: `https://assets.example/${name}.jpg`,
});
const clip = {
  contentType: "video/mp4",
  fileSize: 100,
  mode: "remote_ingest" as const,
  url: "https://assets.example/clip.mp4",
};
const input = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: "A post",
  hashtags: [],
  idempotencyKey: "publish-1",
  media: [photo("one")],
  ...patch,
});
const created = (id: string) => ({
  outcome: "confirmed_success",
  providerOperationId: `created:${id}`,
});
const token = () => json({ access_token: "long", expires_in: 5_184_000, token_type: "bearer" });
const grant = (permissions?: unknown) =>
  json({ data: [{ access_token: "short", user_id: "12345", permissions }] });
const me = () =>
  json({ data: [{ account_type: "Business", id: "98765", user_id: "178", username: "creator" }] });
const exchange = { code: "code", codeVerifier: "unused", redirectUri };
const tokenForm = `client_id=client&client_secret=secret&code=code&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`;

beforeAll(async () => {
  await setup([json({ id: "1" })]).adapter.publish!(context, credentials, input());
});

describe("createInstagramAdapter", () => {
  describe("authorizationUrl", () => {
    it.each([
      ["with engagement", true, allScopes.join("%2C")],
      ["without engagement", false, allScopes.slice(0, 2).join("%2C")],
    ])("%s", (_example, engagementEnabled, scope) => {
      const { adapter } = setup([], { engagementEnabled });

      expect(adapter.authorizationUrl!({ codeChallenge: "c", redirectUri, state: "s" })).toEqual(
        `https://www.instagram.com/oauth/authorize?client_id=client&force_reauth=true&scope=${scope}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=s`,
      );
    });

    it("a foreign redirect URI", () => {
      const { adapter } = setup();
      const foreign = { codeChallenge: "c", redirectUri: "https://evil.example", state: "s" };

      expect(() => adapter.authorizationUrl!(foreign)).toThrow(
        new TypeError("OAuth redirect URI does not match configuration"),
      );
    });
  });

  describe("capability", () => {
    it.each([
      ["with engagement", true],
      ["without engagement", false],
    ])("%s", (_example, engagementEnabled) => {
      const { adapter } = setup([], { engagementEnabled });

      expect(adapter.capability).toEqual({
        accepted_mime_types: ["image/jpeg", "video/mp4", "video/quicktime"],
        analytics: engagementEnabled,
        asset_types: ["image", "video"],
        comments: engagementEnabled,
        connect_available: true,
        max_caption_length: 2_200,
        max_file_size: 524_288_000,
        max_hashtags: 30,
        max_media_count: 20,
        max_video_duration_sec: null,
        min_media_count: 1,
        multi_asset_types: ["image", "video"],
        notes: [
          "Professional Business or Creator accounts use Instagram Login.",
          "Single images, videos, Reels, and Stories use public HTTPS remote-ingest URLs.",
          "Up to 20 images and videos combine as one feed carousel post.",
          "Trial Reels are shared to non-followers first and support manual or performance graduation.",
          "Images are limited to 8 MiB; Reels are limited to 300 MB and 15 minutes, and Story videos to 100 MB and 60 seconds.",
          "Live-account acceptance remains required before runtime enablement.",
        ],
        platform: "instagram",
        publish: true,
        reply: engagementEnabled,
      });
    });

    it.each([
      ["listAnalytics", true, "function"],
      ["listComments", true, "function"],
      ["reply", true, "function"],
      ["listAnalytics", false, "undefined"],
      ["listComments", false, "undefined"],
      ["reply", false, "undefined"],
    ] as const)("%s with engagement %s", (method, engagementEnabled, kind) => {
      const { adapter } = setup([], { engagementEnabled });

      expect(typeof adapter[method]).toEqual(kind);
    });

    it("the metrics it normalizes to zero", () => {
      expect(setup().adapter.ambiguousZeroMetrics).toEqual([
        "views",
        "reactions",
        "comments",
        "shares",
      ]);
    });
  });

  describe("exchangeAuthorizationCode", () => {
    const connection = {
      accessToken: "long",
      account: { displayName: "creator", id: "178", username: "creator" },
      expiresAt: EXPIRES,
      refreshToken: "long",
      scopes: allScopes,
    };

    it.each([
      ["permissions as a string", allScopes.join(",")],
      ["permissions as a list", allScopes],
      ["no permission list", undefined],
    ])("a grant with %s", async (_example, permissions) => {
      const { adapter, requests } = setup([grant(permissions), token(), me()]);

      const result = await adapter.exchangeAuthorizationCode!(context, exchange);

      expect(result).toEqual(connection);
      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://api.instagram.com/oauth/access_token",
          query: {},
          body: tokenForm,
        },
        {
          method: "GET",
          url: "https://graph.instagram.com/access_token",
          query: {
            grant_type: "ig_exchange_token",
            client_secret: "secret",
            access_token: "short",
          },
        },
        get("me", { fields: "id,user_id,username,name,profile_picture_url,account_type" }),
      ]);
    });

    it.each([
      ["a missing permission", "instagram_business_basic"],
      ["a permission that is not text", [...allScopes, null]],
    ])("%s stops before the token exchange", async (_example, permissions) => {
      const { adapter, requests } = setup([grant(permissions)]);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchange))).toEqual(
        providerFailure("auth", "instagram_permissions_missing"),
      );
      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://api.instagram.com/oauth/access_token",
          query: {},
          body: tokenForm,
        },
      ]);
    });

    it.each([
      ["no short token", [json({ user_id: "12345" })]],
      ["no user ID", [json({ access_token: "short" })]],
      ["an unusable profile", [grant(), token(), json({ account_type: "PERSONAL" })]],
    ])("%s", async (_example, answers) => {
      const { adapter } = setup(answers);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchange))).toEqual(
        malformedAnswer,
      );
    });

    it("a foreign redirect URI sends nothing", async () => {
      const { adapter, requests } = setup();

      const foreign = { ...exchange, redirectUri: "https://evil.example" };

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, foreign))).toEqual(
        new TypeError("OAuth redirect URI does not match configuration"),
      );
      expect(requests).toEqual([]);
    });

    it("Instagram down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchange))).toEqual(
        unavailable,
      );
    });
  });

  describe("getAccountAnalytics", () => {
    const recordedAt = "2026-07-19T00:00:00.000Z";

    it.each([
      [
        "every count",
        { data: [{ followers_count: 0, follows_count: 4, media_count: 2 }] },
        { followers: 0, following: 4, posts: 2, recordedAt },
      ],
      ["followers only", { followers_count: 7 }, { followers: 7, recordedAt }],
    ])("%s", async (_example, body, analytics) => {
      const { adapter, requests } = setup([json(body)]);

      const result = await adapter.getAccountAnalytics!(context, credentials);

      expect(result).toEqual(analytics);
      expect(requests).toEqual([
        get("me", { fields: "followers_count,follows_count,media_count" }),
      ]);
    });

    it.each([
      ["no follower count", json({}), malformedAnswer],
      ["Instagram down", down(), unavailable],
    ])("%s", async (_example, answer, failure) => {
      const { adapter } = setup([answer]);

      expect(await failureOf(adapter.getAccountAnalytics!(context, credentials))).toEqual(failure);
    });
  });

  describe("listAnalytics", () => {
    const lookup = { providerPostId: "media-1" };
    const counts = { comments: 0, likes: 0, reach: 0, shares: 0, views: 0 };
    const record = (patch: object) => ({
      items: [
        {
          ...counts,
          impressions: 0,
          providerPostId: "media-1",
          recordedAt: "2026-07-19T00:00:00.000Z",
          watchTimeSeconds: 0,
          ...patch,
        },
      ],
    });
    const metric = (name: string, value: number) => ({ name, total_value: { value } });

    it.each([
      [
        "every metric",
        [
          metric("views", 42),
          metric("reach", 30),
          metric("likes", 8),
          metric("comments", 3),
          metric("shares", 2),
        ],
        { comments: 3, likes: 8, reach: 30, shares: 2, views: 42 },
      ],
      ["no metric", [], counts],
    ])("%s", async (_example, data, expected) => {
      const { adapter, requests } = setup([json({ data })]);

      const result = await adapter.listAnalytics!(context, credentials, lookup, { limit: 100 });

      expect(result).toEqual(record(expected));
      expect(requests).toEqual([
        get("media-1/insights", { metric: "views,reach,likes,comments,shares" }),
      ]);
    });

    it.each([
      ["a cursor", lookup, { cursor: "c", limit: 1 }, "instagram_analytics_not_paginated"],
      ["no post ID", {}, { limit: 1 }, "instagram_media_id_required"],
    ])("%s sends nothing", async (_example, target, page, code) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.listAnalytics!(context, credentials, target, page))).toEqual(
        refused(code),
      );
      expect(requests).toEqual([]);
    });
  });

  describe("listComments", () => {
    const lookup = { providerPostId: "media-1" };

    it("a page after a cursor", async () => {
      const comment = {
        from: { username: "ann" },
        id: "c1",
        text: "hi",
        timestamp: "2026-07-18T20:00:00+0000",
      };
      const { adapter, requests } = setup([
        json({ data: [comment], paging: { cursors: { after: "next" } } }),
      ]);

      const result = await adapter.listComments!(context, credentials, lookup, {
        cursor: "current",
        limit: 10,
      });

      expect(result).toEqual({
        items: [
          {
            authorDisplayName: "ann",
            body: "hi",
            commentedAt: "2026-07-18T20:00:00.000Z",
            providerCommentId: "c1",
            providerPostId: "media-1",
          },
        ],
        nextCursor: "next",
      });
      expect(requests).toEqual([
        get("media-1/comments", {
          fields: "id,text,timestamp,from{id,username}",
          limit: "10",
          after: "current",
        }),
      ]);
    });

    it("a limit of zero sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(adapter.listComments!(context, credentials, lookup, { limit: 0 })),
      ).toEqual(refused("instagram_page_invalid"));
      expect(requests).toEqual([]);
    });
  });

  describe("reply", () => {
    const reply = {
      idempotencyKey: "r1",
      providerCommentId: "c1",
      providerPostId: "p",
      text: " Thanks ",
    };

    it("a public reply", async () => {
      const { adapter, requests } = setup([json({ id: "reply-1" })]);

      const result = await adapter.reply!(context, credentials, reply);

      expect(result).toEqual({ outcome: "confirmed_success", providerPostId: "reply-1" });
      expect(requests).toEqual([{ ...post("c1/replies", {}), body: '{"message":"Thanks"}' }]);
    });

    it("a blank reply sends nothing", async () => {
      const { adapter, requests } = setup();

      const result = await adapter.reply!(context, credentials, { ...reply, text: " " });

      expect(result).toEqual({
        failure: refused("instagram_reply_invalid"),
        outcome: "confirmed_failure",
      });
      expect(requests).toEqual([]);
    });

    it("an answer without a reply ID", async () => {
      const { adapter } = setup([json({})]);

      expect(await failureOf(adapter.reply!(context, credentials, reply))).toEqual(unconfirmed);
    });
  });

  describe("lookupPublication", () => {
    it("a published post", async () => {
      const { adapter, requests } = setup([
        json({ id: "media-1", permalink: "https://www.instagram.com/p/media-1/" }),
      ]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "created:c1",
        providerPostId: "media-1",
      });

      expect(result).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "created:c1",
          providerPostId: "media-1",
          providerUrl: "https://www.instagram.com/p/media-1/",
        },
        state: "published",
      });
      expect(requests).toEqual([get("media-1", { fields: "id,permalink" })]);
    });

    it("a container still processing", async () => {
      const { adapter, requests } = setup([json({ id: "c1", status_code: "IN_PROGRESS" })]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({ providerOperationId: "created:c1", state: "processing" });
      expect(requests).toEqual([get("c1", { fields: "id,status_code,status" })]);
    });

    it("a finished container is published with its warnings", async () => {
      const { adapter, requests } = setup([
        json({ id: "c1", status_code: "FINISHED" }),
        json({ id: "media-1", config_issue: "CAPTION_NOT_ATTACHED" }),
      ]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "created:c1",
          providerPostId: "media-1",
          warnings: ["instagram_publish_partial"],
        },
        state: "published",
      });
      expect(requests).toEqual([
        get("c1", { fields: "id,status_code,status" }),
        post("account-1/media_publish", { creation_id: "c1" }),
      ]);
    });

    it("a submitted container Instagram reports published", async () => {
      const { adapter } = setup([json({ id: "c1", status_code: "PUBLISHED" })]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({
        result: { outcome: "confirmed_success", providerOperationId: "submitted:c1" },
        state: "published",
      });
    });

    it("a failed container keeps Instagram's text out of the result", async () => {
      const { adapter } = setup([
        json({
          id: "c1",
          status: "Failed downloading https://m.example?token=x",
          status_code: "ERROR",
        }),
      ]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({
        result: {
          failure: {
            classification: "deterministic",
            code: "instagram_container_media_retrieval",
            message: "The provider rejected this request.",
            retryable: false,
          },
          outcome: "confirmed_failure",
          providerOperationId: "created:c1",
        },
        state: "failed",
      });
    });

    it.each([
      ["an unusable post ID", credentials, { providerPostId: "a b" }, malformedAnswer],
      ["no operation or post", credentials, {}, malformedAnswer],
      [
        "no professional account",
        { accessToken: "access" },
        { providerOperationId: "created:c1" },
        refused("instagram_professional_account_required"),
      ],
    ])("%s sends nothing", async (_example, who, lookup, failure) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.lookupPublication!(context, who, lookup))).toEqual(failure);
      expect(requests).toEqual([]);
    });
  });

  describe("publish", () => {
    const media = "account-1/media";

    it("a single image", async () => {
      const { adapter, requests } = setup([json({ id: "c1" })]);

      const result = await adapter.publish!(context, credentials, input());

      expect(result).toEqual(created("c1"));
      expect(requests).toEqual([
        post(media, { caption: "A post", image_url: "https://assets.example/one.jpg" }),
      ]);
    });

    it("a single video with Reel metadata", async () => {
      const { adapter, requests } = setup([json({ id: "c1" })]);
      const content = {
        cover_url: "https://assets.example/cover.jpg",
        audio_name: "Tutorial",
        thumb_offset: 1500,
        share_to_feed: false,
      };

      await adapter.publish!(
        context,
        credentials,
        input({ media: [clip], providerOptions: { instagram: { content } } }),
      );

      expect(requests).toEqual([
        post(media, {
          caption: "A post",
          video_url: clip.url,
          media_type: "REELS",
          share_to_feed: "false",
          cover_url: "https://assets.example/cover.jpg",
          audio_name: "Tutorial",
          thumb_offset: "1500",
        }),
      ]);
    });

    it("a carousel in creator order with its metadata", async () => {
      const { adapter, requests } = setup([
        json({ id: "a" }),
        json({ id: "b" }),
        json({ id: "p" }),
      ]);

      const result = await adapter.publish!(
        context,
        credentials,
        input({
          media: [photo("one"), clip],
          providerOptions: {
            instagram: {
              content: { is_ai_generated: true, collaborators: ["friend"] },
              mediaOptions: [{ alt_text: "First image" }],
            },
          },
        }),
      );

      expect(result).toEqual(created("p"));
      expect(requests).toEqual([
        post(media, {
          is_carousel_item: "true",
          image_url: "https://assets.example/one.jpg",
          alt_text: "First image",
        }),
        post(media, { is_carousel_item: "true", media_type: "VIDEO", video_url: clip.url }),
        post(media, {
          caption: "A post",
          media_type: "CAROUSEL",
          children: "a,b",
          is_ai_generated: "true",
          collaborators: '["friend"]',
        }),
      ]);
    });

    it("a carousel without a caption", async () => {
      const { adapter, requests } = setup([
        json({ id: "a" }),
        json({ id: "b" }),
        json({ id: "p" }),
      ]);

      await adapter.publish!(
        context,
        credentials,
        input({ caption: " ", media: [photo("one"), photo("two")] }),
      );

      expect(requests[2]).toEqual(post(media, { media_type: "CAROUSEL", children: "a,b" }));
    });

    it("Instagram down on the second child", async () => {
      const { adapter, requests } = setup([json({ id: "a" }), down()]);

      expect(
        await failureOf(
          adapter.publish!(context, credentials, input({ media: [photo("one"), photo("two")] })),
        ),
      ).toEqual(unavailable);
      expect(requests).toEqual([
        post(media, { is_carousel_item: "true", image_url: "https://assets.example/one.jpg" }),
        post(media, { is_carousel_item: "true", image_url: "https://assets.example/two.jpg" }),
      ]);
    });

    it("an answer without a container ID", async () => {
      const { adapter } = setup([json({})]);

      expect(await failureOf(adapter.publish!(context, credentials, input()))).toEqual(
        malformedAnswer,
      );
    });

    it.each([
      [
        "no professional account",
        { accessToken: "a" },
        input(),
        "instagram_professional_account_required",
      ],
      ["no media", credentials, input({ media: [] }), "instagram_media_required"],
    ])("%s sends nothing", async (_example, who, value, code) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.publish!(context, who, value))).toEqual(refused(code));
      expect(requests).toEqual([]);
    });
  });

  describe("refreshAccessToken", () => {
    it("a long-lived token", async () => {
      const { adapter, requests } = setup([token()]);

      const result = await adapter.refreshAccessToken!(context, "refresh");

      expect(result).toEqual({
        accessToken: "long",
        expiresAt: EXPIRES,
        refreshToken: "long",
        scopes: allScopes,
      });
      expect(requests).toEqual([
        {
          method: "GET",
          url: "https://graph.instagram.com/refresh_access_token",
          query: { grant_type: "ig_refresh_token", access_token: "refresh" },
        },
      ]);
    });

    it("a blank token", async () => {
      const { adapter } = setup();

      expect(await failureOf(adapter.refreshAccessToken!(context, " "))).toEqual(
        new TypeError("refreshToken is invalid"),
      );
    });
  });
});
