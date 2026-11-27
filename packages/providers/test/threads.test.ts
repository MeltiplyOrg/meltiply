import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createThreadsAdapter, type ThreadsAdapterOptions } from "../src/threads/adapter";
import type { PublishInput } from "../src/types";
import {
  failureOf,
  malformedAnswer,
  providerFailure,
  refused,
  unavailable,
  unconfirmed,
} from "./support";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "access", accountId: "account-1" };
const redirectUri = "https://api.example.com/api/v1/platforms/threads/callback";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const EXPIRES = "2026-09-17T00:00:00.000Z";
const publishing = [
  "threads_basic",
  "threads_content_publish",
  "threads_delete",
  "threads_location_tagging",
  "threads_share_to_instagram",
  "threads_keyword_search",
  "threads_manage_mentions",
];
const engagement = ["threads_manage_insights", "threads_manage_replies", "threads_read_replies"];
const ORIGIN = "https://graph.threads.com";

type Answer = Response | Error;

function setup(answers: Answer[] = [], options: Partial<ThreadsAdapterOptions> = {}) {
  const requests: object[] = [];
  const adapter = createThreadsAdapter({
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
const request = (method: string, path: string, query: object = {}) => ({
  method,
  url: `${ORIGIN}/${path}`,
  query,
});
const container = (query: object) => request("POST", "me/threads", query);
const photo = {
  contentType: "image/jpeg",
  fileSize: 100,
  mode: "remote_ingest" as const,
  url: "https://assets.example/one.jpg",
};
const clip = {
  contentType: "video/mp4",
  fileSize: 100,
  mode: "remote_ingest" as const,
  url: "https://assets.example/two.mp4",
};
const input = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: "A post",
  hashtags: [],
  idempotencyKey: "publish-1",
  media: [],
  ...patch,
});
const created = (id: string) => ({
  outcome: "confirmed_success",
  providerOperationId: `created:${id}`,
});
const token = () => json({ access_token: "long", expires_in: 5_184_000, token_type: "bearer" });
const debug = () => json({ data: { is_valid: true, user_id: "1", scopes: ["threads_basic"] } });
const debugRequest = request("GET", "v1.0/debug_token", { input_token: "long" });
const exchange = { code: "code", codeVerifier: "unused", redirectUri };

beforeAll(async () => {
  await setup([json({ id: "1" })]).adapter.publish!(context, credentials, input());
});

describe("createThreadsAdapter", () => {
  describe("authorizationUrl", () => {
    it.each([
      ["with engagement", true, [...publishing, ...engagement].join("%2C")],
      ["without engagement", false, publishing.join("%2C")],
    ])("%s", (_example, engagementEnabled, scope) => {
      const { adapter } = setup([], { engagementEnabled });

      expect(adapter.authorizationUrl!({ codeChallenge: "c", redirectUri, state: "s" })).toEqual(
        `https://threads.com/oauth/authorize?client_id=client&scope=${scope}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=s`,
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
        accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
        analytics: engagementEnabled,
        asset_types: ["image", "video"],
        comments: engagementEnabled,
        connect_available: true,
        max_caption_length: 500,
        max_file_size: 524_288_000,
        max_hashtags: null,
        max_media_count: 20,
        max_video_duration_sec: 300,
        min_media_count: 0,
        multi_asset_types: ["image", "video"],
        notes: [
          "Text, image, video, and carousel posts use the Threads container flow.",
          "Up to 20 images and videos combine as one carousel post.",
          "Text-only containers support polls, GIPHY GIFs, long-text attachments, and 24-hour ghost Posts; quotes, replies, and reposts preserve the source identity.",
          "Location and Instagram Story cross-sharing need optional grants; country restrictions need an eligible account.",
          "Images are limited to 8 MiB; videos use Meltiply's 500 MiB upload ceiling.",
          "Only the first in-text hashtag becomes a native topic tag; other hashtags remain ordinary caption text.",
          "Media is transferred through a short-lived HTTPS remote-ingest URL.",
          "Live-account acceptance remains required before runtime enablement.",
        ],
        platform: "threads",
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
    it("a code for a long-lived token and profile", async () => {
      const { adapter, requests } = setup([
        json({ access_token: "short", user_id: 1 }),
        token(),
        json({ id: "1", username: "creator" }),
        debug(),
      ]);

      const result = await adapter.exchangeAuthorizationCode!(context, exchange);

      expect(result).toEqual({
        accessToken: "long",
        account: { displayName: "creator", id: "1", username: "creator" },
        expiresAt: EXPIRES,
        refreshToken: "long",
        scopes: ["threads_basic"],
      });
      expect(requests).toEqual([
        request("POST", "oauth/access_token"),
        request("GET", "access_token", {
          grant_type: "th_exchange_token",
          client_secret: "secret",
          access_token: "short",
        }),
        request("GET", "me", { fields: "id,username,name,threads_profile_picture_url" }),
        debugRequest,
      ]);
    });

    it.each([
      ["no short token", json({ user_id: 1 }), malformedAnswer],
      ["no user ID", json({ access_token: "short" }), malformedAnswer],
      ["Threads down", down(), unavailable],
    ])("%s", async (_example, answer, failure) => {
      const { adapter } = setup([answer]);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchange))).toEqual(
        failure,
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
  });

  describe("refreshAccessToken", () => {
    it("a long-lived token with its current grants", async () => {
      const { adapter, requests } = setup([token(), debug()]);

      const result = await adapter.refreshAccessToken!(context, "refresh");

      expect(result).toEqual({
        accessToken: "long",
        expiresAt: EXPIRES,
        refreshToken: "long",
        scopes: ["threads_basic"],
      });
      expect(requests).toEqual([
        request("GET", "refresh_access_token", {
          grant_type: "th_refresh_token",
          access_token: "refresh",
        }),
        debugRequest,
      ]);
    });

    it("a blank token", async () => {
      const { adapter } = setup();

      expect(await failureOf(adapter.refreshAccessToken!(context, " "))).toEqual(
        new TypeError("refreshToken is invalid"),
      );
    });
  });

  describe("getAccountAnalytics", () => {
    it("a follower count", async () => {
      const { adapter, requests } = setup([
        json({ data: [{ name: "followers_count", total_value: { value: 9 } }] }),
      ]);

      const result = await adapter.getAccountAnalytics!(context, credentials);

      expect(result).toEqual({ followers: 9, recordedAt: "2026-07-19T00:00:00.000Z" });
      expect(requests).toEqual([
        request("GET", "account-1/threads_insights", {
          metric: "followers_count",
          period: "lifetime",
        }),
      ]);
    });

    it.each([
      ["no account ID", { accessToken: "a" }, down(), refused("threads_account_id_required")],
      ["Threads down", credentials, down(), unavailable],
    ])("%s", async (_example, who, answer, failure) => {
      const { adapter } = setup([answer]);

      expect(await failureOf(adapter.getAccountAnalytics!(context, who))).toEqual(failure);
    });
  });

  describe("listAnalytics", () => {
    it("post insights", async () => {
      const { adapter, requests } = setup([
        json({ data: [{ name: "reposts", values: [{ value: 4 }] }] }),
      ]);

      const result = await adapter.listAnalytics!(
        context,
        credentials,
        { providerPostId: "p1" },
        { limit: 1 },
      );

      expect(result).toEqual({
        items: [
          {
            comments: 0,
            impressions: 0,
            likes: 0,
            providerPostId: "p1",
            reach: 0,
            recordedAt: "2026-07-19T00:00:00.000Z",
            shares: 4,
            views: 0,
            watchTimeSeconds: 0,
          },
        ],
      });
      expect(requests).toEqual([
        request("GET", "p1/insights", { metric: "views,likes,replies,reposts,quotes,shares" }),
      ]);
    });

    it("a cursor sends nothing", async () => {
      const { adapter, requests } = setup();
      const page = { cursor: "c", limit: 1 };

      expect(
        await failureOf(
          adapter.listAnalytics!(context, credentials, { providerPostId: "p1" }, page),
        ),
      ).toEqual(refused("threads_analytics_not_paginated"));
      expect(requests).toEqual([]);
    });
  });

  describe("listComments", () => {
    it("a conversation page after a cursor", async () => {
      const reply = {
        id: "r1",
        profile_picture_url: "https://cdn.test/a",
        text: "First",
        timestamp: "2024-09-17T20:54:47+0000",
        username: "reader",
      };
      const { adapter, requests } = setup([
        json({ data: [reply], paging: { cursors: { after: "next+/==" } } }),
      ]);

      const result = await adapter.listComments!(
        context,
        credentials,
        { providerPostId: "p1" },
        { cursor: "prev+/==", limit: 2 },
      );

      expect(result).toEqual({
        items: [
          {
            authorAvatarUrl: "https://cdn.test/a",
            authorDisplayName: "reader",
            body: "First",
            commentedAt: "2024-09-17T20:54:47.000Z",
            providerCommentId: "r1",
            providerPostId: "p1",
          },
        ],
        nextCursor: "next+/==",
      });
      expect(requests).toEqual([
        request("GET", "p1/conversation", {
          fields: "id,text,timestamp,username,profile_picture_url",
          limit: "2",
          reverse: "false",
          after: "prev+/==",
        }),
      ]);
    });

    it("a limit of zero sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.listComments!(context, credentials, { providerPostId: "p1" }, { limit: 0 }),
        ),
      ).toEqual(refused("threads_page_invalid"));
      expect(requests).toEqual([]);
    });
  });

  describe("reply", () => {
    const reply = {
      idempotencyKey: "r",
      providerCommentId: "c1",
      providerPostId: "p",
      text: "Thanks",
    };

    it("a reply container", async () => {
      const { adapter, requests } = setup([json({ id: "rc" })]);

      const result = await adapter.reply!(context, credentials, reply);

      expect(result).toEqual(created("rc"));
      expect(requests).toEqual([
        container({ media_type: "TEXT", reply_to_id: "c1", text: "Thanks" }),
      ]);
    });

    it("a blank reply sends nothing", async () => {
      const { adapter, requests } = setup();

      const result = await adapter.reply!(context, credentials, { ...reply, text: " " });

      expect(result).toEqual({
        failure: refused("threads_reply_invalid"),
        outcome: "confirmed_failure",
      });
      expect(requests).toEqual([]);
    });
  });

  describe("publish", () => {
    it.each([
      ["a text post", input(), { text: "A post", media_type: "TEXT" }],
      [
        "an image",
        input({ media: [photo] }),
        { text: "A post", media_type: "IMAGE", image_url: photo.url },
      ],
      [
        "a video without a caption",
        input({ caption: " ", media: [clip] }),
        { media_type: "VIDEO", video_url: clip.url },
      ],
      [
        "a GIF without a caption",
        input({
          caption: "",
          providerOptions: { threads: { gif_attachment: { gif_id: "g", provider: "GIPHY" } } },
        }),
        { media_type: "TEXT", gif_attachment: '{"gif_id":"g","provider":"GIPHY"}' },
      ],
      [
        "long text without a caption",
        input({
          caption: "",
          providerOptions: { threads: { text_attachment: { plaintext: "Long" } } },
        }),
        { media_type: "TEXT", text_attachment: '{"plaintext":"Long"}' },
      ],
      [
        "a poll",
        input({
          providerOptions: { threads: { poll_attachment: { option_a: "A", option_b: "B" } } },
        }),
        { text: "A post", media_type: "TEXT", poll_attachment: '{"option_a":"A","option_b":"B"}' },
      ],
      [
        "a ghost post",
        input({ providerOptions: { threads: { is_ghost_post: true } } }),
        { text: "A post", media_type: "TEXT", is_ghost_post: "true" },
      ],
      [
        "a quote",
        input({ providerOptions: { threads: { quote_post_id: "q1" } } }),
        { text: "A post", media_type: "TEXT", quote_post_id: "q1" },
      ],
      [
        "a threaded reply",
        input({ providerOptions: { threads: { reply_to_id: "p0" } } }),
        { text: "A post", media_type: "TEXT", reply_to_id: "p0" },
      ],
    ])("%s", async (_example, value, query) => {
      const { adapter, requests } = setup([json({ id: "c1" })]);

      const result = await adapter.publish!(context, credentials, value);

      expect(result).toEqual(created("c1"));
      expect(requests).toEqual([container(query)]);
    });

    it("a carousel in creator order with options on the parent only", async () => {
      const { adapter, requests } = setup([
        json({ id: "a" }),
        json({ id: "b" }),
        json({ id: "p" }),
      ]);
      const value = input({
        media: [photo, clip],
        providerOptions: { threads: { topic_tag: "news" } },
      });

      const result = await adapter.publish!(context, credentials, value);

      expect(result).toEqual(created("p"));
      expect(requests).toEqual([
        container({ is_carousel_item: "true", media_type: "IMAGE", image_url: photo.url }),
        container({ is_carousel_item: "true", media_type: "VIDEO", video_url: clip.url }),
        container({ text: "A post", media_type: "CAROUSEL", children: "a,b", topic_tag: "news" }),
      ]);
    });

    it("a repost", async () => {
      const { adapter, requests } = setup([json({ id: "repost-1" })]);
      const value = input({ caption: "", providerOptions: { threads: { repost_id: "s1" } } });

      const result = await adapter.publish!(context, credentials, value);

      expect(result).toEqual({ outcome: "confirmed_success", providerPostId: "repost-1" });
      expect(requests).toEqual([request("POST", "s1/repost")]);
    });

    it("a repost answered without a post ID", async () => {
      const { adapter } = setup([json({})]);
      const value = input({ caption: "", providerOptions: { threads: { repost_id: "s1" } } });

      expect(await failureOf(adapter.publish!(context, credentials, value))).toEqual(unconfirmed);
    });

    it("a rejected first carousel item stops the rest", async () => {
      const { adapter, requests } = setup([json({}, 400)]);
      const value = input({ media: [photo, clip] });

      expect(await failureOf(adapter.publish!(context, credentials, value))).toEqual(
        refused("provider_http_400"),
      );
      expect(requests).toEqual([
        container({ is_carousel_item: "true", media_type: "IMAGE", image_url: photo.url }),
      ]);
    });

    it.each([
      ["nothing to say", input({ caption: " " }), refused("threads_text_invalid")],
      [
        "a caption too long",
        input({ caption: "x".repeat(501) }),
        refused("threads_content_invalid"),
      ],
      [
        "a blank idempotency key",
        input({ idempotencyKey: " " }),
        new TypeError("idempotencyKey is invalid"),
      ],
    ])("%s sends nothing", async (_example, value, failure) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.publish!(context, credentials, value))).toEqual(failure);
      expect(requests).toEqual([]);
    });
  });

  describe("lookupPublication", () => {
    const operation = { providerOperationId: "created:c1" };
    const status = (value: string, extra: object = {}) =>
      json({ id: "c1", status: value, ...extra });
    const read = request("GET", "c1", { fields: "id,status,error_message" });

    it.each([
      [
        "a post with a permalink",
        { id: "p1", permalink: "https://www.threads.net/@a/post/x" },
        { providerUrl: "https://www.threads.net/@a/post/x" },
      ],
      ["a post whose permalink is withheld", { id: "p1" }, {}],
    ])("%s", async (_example, body, extra) => {
      const { adapter, requests } = setup([json(body)]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerPostId: "p1",
      });

      expect(result).toEqual({
        result: { outcome: "confirmed_success", providerPostId: "p1", ...extra },
        state: "published",
      });
      expect(requests).toEqual([request("GET", "p1", { fields: "id,permalink" })]);
    });

    it("a missing post", async () => {
      const { adapter } = setup([json({}, 404)]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerPostId: "p1",
      });

      expect(result).toEqual({ state: "not_found" });
    });

    it("a container still processing", async () => {
      const { adapter, requests } = setup([status("IN_PROGRESS")]);

      const result = await adapter.lookupPublication!(context, credentials, operation);

      expect(result).toEqual({ providerOperationId: "created:c1", state: "processing" });
      expect(requests).toEqual([read]);
    });

    it("a finished container is published with its cross-share warning", async () => {
      const { adapter, requests } = setup([
        status("FINISHED"),
        json({ id: "p1", crossreshare_to_ig_status: "FAILED" }),
      ]);

      const result = await adapter.lookupPublication!(context, credentials, operation);

      expect(result).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "created:c1",
          providerPostId: "p1",
          warnings: ["instagram_crossshare_failed"],
        },
        state: "published",
      });
      expect(requests).toEqual([
        read,
        request("POST", "me/threads_publish", { creation_id: "c1" }),
      ]);
    });

    it("a lost publish is recorded as submitted", async () => {
      const { adapter } = setup([status("FINISHED"), new Error("connection lost")]);

      const result = await adapter.lookupPublication!(context, credentials, operation);

      expect(result).toEqual({
        result: {
          failure: providerFailure("ambiguous", "provider_http_request_failed"),
          outcome: "unknown",
          providerOperationId: "submitted:c1",
        },
        state: "unknown",
      });
    });

    it.each([
      [
        "a submitted container still finished",
        "FINISHED",
        {
          result: {
            failure: providerFailure("ambiguous", "threads_publish_evidence_missing"),
            outcome: "unknown",
            providerOperationId: "submitted:c1",
          },
          state: "unknown",
        },
      ],
      [
        "a submitted container reported published",
        "PUBLISHED",
        {
          result: { outcome: "confirmed_success", providerOperationId: "submitted:c1" },
          state: "published",
        },
      ],
      [
        "a failed container",
        "ERROR",
        {
          result: {
            failure: refused("threads_container_error"),
            outcome: "confirmed_failure",
            providerOperationId: "submitted:c1",
          },
          state: "failed",
        },
      ],
    ])("%s is never republished", async (_example, value, expected) => {
      const { adapter, requests } = setup([status(value, { error_message: "private detail" })]);

      const result = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "submitted:c1",
      });

      expect(result).toEqual(expected);
      expect(requests).toEqual([read]);
    });

    it.each([
      ["an unusable post ID", { providerPostId: "a b" }],
      ["no operation or post", {}],
    ])("%s sends nothing", async (_example, lookup) => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.lookupPublication!(context, credentials, lookup))).toEqual(
        malformedAnswer,
      );
      expect(requests).toEqual([]);
    });
  });

  describe("cancelPublication", () => {
    const deleted = {
      outcome: "confirmed_success",
      providerOperationId: "created:c1",
      providerPostId: "p1",
    };
    const published = { providerOperationId: "created:c1", providerPostId: "p1" };

    it.each([
      ["a published post", json({ deleted_id: "p1", success: true })],
      ["a post already gone", json({}, 404)],
    ])("%s", async (_example, answer) => {
      const { adapter, requests } = setup([answer]);

      const result = await adapter.cancelPublication!(context, credentials, published);

      expect(result).toEqual(deleted);
      expect(requests).toEqual([request("DELETE", "p1")]);
    });

    it.each([
      ["an unconfirmed deletion", json({ success: false }), unconfirmed],
      ["Threads down", down(), providerFailure("transient", "provider_http_503")],
    ])("%s", async (_example, answer, failure) => {
      const { adapter } = setup([answer]);

      expect(await failureOf(adapter.cancelPublication!(context, credentials, published))).toEqual(
        failure,
      );
    });

    it.each([
      ["a container already gone", json({}, 404)],
      ["a failed container", json({ id: "c1", status: "ERROR" })],
      ["an expired container", json({ id: "c1", status: "EXPIRED" })],
    ])("%s needs no deletion", async (_example, answer) => {
      const { adapter } = setup([answer]);

      const result = await adapter.cancelPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({ outcome: "confirmed_success", providerOperationId: "created:c1" });
    });

    it("a live container is not guessed at", async () => {
      const { adapter, requests } = setup([json({ id: "c1", status: "PUBLISHED" })]);

      const result = await adapter.cancelPublication!(context, credentials, {
        providerOperationId: "created:c1",
      });

      expect(result).toEqual({
        failure: providerFailure("ambiguous", "threads_cancel_requires_post_id"),
        outcome: "unknown",
        providerOperationId: "created:c1",
      });
      expect(requests).toEqual([request("GET", "c1", { fields: "id,status,error_message" })]);
    });

    it("no usable evidence sends nothing", async () => {
      const { adapter, requests } = setup();

      const result = await adapter.cancelPublication!(context, credentials, {});

      expect(result).toEqual({
        failure: refused("threads_cancel_evidence_invalid"),
        outcome: "confirmed_failure",
      });
      expect(requests).toEqual([]);
    });
  });
});
