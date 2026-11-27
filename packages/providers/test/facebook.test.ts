import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createFacebookAdapter, type FacebookAdapterOptions } from "../src/facebook/adapter";
import { discoveryRequestLimit } from "../src/facebook/oauth";
import { failureDiagnostic, ProviderAdapterError } from "../src/failures";
import type { PublishInput } from "../src/types";
import {
  failureOf,
  malformedAnswer,
  providerFailure,
  refused,
  thrownBy,
  unavailable,
} from "./support";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "page-access-secret", accountId: "page-1" };
const redirectUri = "https://api.example.com/api/v1/platforms/facebook/callback";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const GRAPH = "https://graph.facebook.com/v25.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v25.0";

type Answer = Response | Error;

interface RecordedRequest {
  body?: string;
  headers: Record<string, string>;
  method: string | undefined;
  query: Record<string, string>;
  redirect: RequestRedirect | undefined;
  url: string;
}

function setup(answers: Answer[] = [], options: Partial<FacebookAdapterOptions> = {}) {
  const requests: RecordedRequest[] = [];
  const adapter = createFacebookAdapter({
    clientId: "facebook-client",
    clientSecret: "facebook-client-secret",
    now: () => NOW,
    redirectUri,
    timeoutMilliseconds: 100,
    fetch: (target, init) => {
      const url = new URL(String(target));
      requests.push({
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        method: init?.method,
        query: Object.fromEntries(url.searchParams),
        redirect: init?.redirect,
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
const down = () => json({}, 503);

const defaultPermissions = () =>
  json({
    data: [
      { permission: "pages_show_list", status: "granted" },
      { permission: "pages_read_engagement", status: "granted" },
      { permission: "pages_manage_posts", status: "granted" },
      { permission: "pages_manage_engagement", status: "granted" },
      { permission: "read_insights", status: "granted" },
    ],
  });

const publishInput = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: "A Page Reel #launch",
  hashtags: ["launch"],
  idempotencyKey: "publish-1",
  media: [
    {
      contentType: "video/mp4",
      fileSize: 20 * 1024 * 1024,
      mode: "remote_ingest",
      url: "https://assets.example/reel.mp4?signature=secret",
    },
  ],
  ...patch,
});

const photo = (name: string) => ({
  contentType: "image/jpeg",
  fileSize: 100,
  mode: "remote_ingest" as const,
  url: `https://assets.example/${name}.jpg`,
});

const reelStatus = (
  id: string,
  patch: Partial<{
    processing: string;
    publishing: string;
    uploading: string;
    video: string;
  }> = {},
) => ({
  id,
  status: {
    processing_phase: { status: patch.processing ?? "in_progress" },
    publishing_phase: { status: patch.publishing ?? "not_started" },
    uploading_phase: { status: patch.uploading ?? "complete" },
    video_status: patch.video ?? "processing",
  },
});

const pageItem = (id: string, token = `page-token-${id}`) => ({
  access_token: token,
  id,
  name: `Page ${id}`,
  tasks: ["CREATE_CONTENT"],
});

beforeAll(async () => {
  await setup([json({ id: "page-1_warm" })]).adapter.publish!(
    context,
    credentials,
    publishInput({ caption: "Warm", hashtags: [], media: [] }),
  );
});

describe("createFacebookAdapter", () => {
  describe("capability", () => {
    it("declares Facebook Page publishing and analytics capabilities", () => {
      const { adapter } = setup();
      expect({
        capability: adapter.capability,
        retryPolicy: adapter.retryPolicy,
        transferModes: adapter.transferModes,
      }).toEqual({
        capability: {
          accepted_mime_types: [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/bmp",
            "image/tiff",
            "video/mp4",
            "video/quicktime",
          ],
          analytics: true,
          asset_types: ["image", "video"],
          comments: false,
          connect_available: true,
          max_caption_length: null,
          max_file_size: 500 * 1024 * 1024,
          max_hashtags: null,
          max_media_count: null,
          max_video_duration_sec: null,
          min_media_count: 0,
          multi_asset_types: ["image"],
          notes: adapter.capability.notes,
          platform: "facebook",
          publish: true,
          reply: false,
        },
        retryPolicy: { baseDelaySeconds: 30, maxAttempts: 8, maxDelaySeconds: 900 },
        transferModes: ["remote_ingest"],
      });
    });
  });

  describe("authorizationUrl", () => {
    it("a state-bound Facebook dialog URL", () => {
      const { adapter } = setup();
      const url = new URL(
        adapter.authorizationUrl!({ codeChallenge: "unused", redirectUri, state: "oauth-state" }),
      );
      expect({
        origin: url.origin,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
      }).toEqual({
        origin: "https://www.facebook.com",
        pathname: "/v25.0/dialog/oauth",
        query: {
          client_id: "facebook-client",
          redirect_uri: redirectUri,
          response_type: "code",
          scope:
            "pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,read_insights,pages_read_user_content,business_management",
          state: "oauth-state",
        },
      });
    });

    it("a foreign redirect URI", () => {
      const { adapter } = setup();
      expect(
        thrownBy(() =>
          adapter.authorizationUrl!({
            codeChallenge: "unused",
            redirectUri: "https://attacker.example/callback",
            state: "oauth-state",
          }),
        ),
      ).toEqual(new TypeError("OAuth redirect URI does not match configuration"));
    });
  });

  describe("exchangeAuthorizationCode", () => {
    const exchangeInput = { code: "authorization-code", codeVerifier: "unused", redirectUri };

    it("a single publishable Page with explicit expiry", async () => {
      const { adapter, requests } = setup([
        json({ access_token: "short-user-secret" }),
        json({ access_token: "long-user-secret", expires_in: 5_184_000, token_type: "bearer" }),
        defaultPermissions(),
        json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_ANALYZE"],
            },
          ],
        }),
      ]);

      expect(await adapter.exchangeAuthorizationCode!(context, exchangeInput)).toEqual({
        accounts: [
          {
            accessToken: "page-access-secret",
            account: { displayName: "Meltiply Page", id: "page-1" },
            expiresAt: "2026-09-17T00:00:00.000Z",
            refreshToken: '{"pageId":"page-1","userAccessToken":"long-user-secret"}',
            scopes: [
              "pages_show_list",
              "pages_read_engagement",
              "pages_manage_posts",
              "pages_manage_engagement",
              "read_insights",
            ],
          },
        ],
      });
      expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "POST", url: `${GRAPH}/oauth/access_token` },
        { method: "POST", url: `${GRAPH}/oauth/access_token` },
        { method: "GET", url: `${GRAPH}/me/permissions` },
        { method: "GET", url: `${GRAPH}/me/accounts` },
      ]);
    });

    it("an exchange omitting expires_in inspects debug_token", async () => {
      const { adapter } = setup(
        [
          json({ access_token: "short-user-secret" }),
          json({ access_token: "long-user-secret", token_type: "bearer" }),
          json({ data: { app_id: "facebook-client", expires_at: 1_788_566_400, is_valid: true } }),
          defaultPermissions(),
          json({ data: [pageItem("page-1", "page-access-secret")] }),
        ],
        { now: () => new Date("2026-07-19T00:00:00.123Z") },
      );

      expect(await adapter.exchangeAuthorizationCode!(context, exchangeInput)).toEqual({
        accounts: [
          {
            accessToken: "page-access-secret",
            account: { displayName: "Page page-1", id: "page-1" },
            expiresAt: "2026-09-05T00:00:00.000Z",
            refreshToken: '{"pageId":"page-1","userAccessToken":"long-user-secret"}',
            scopes: [
              "pages_show_list",
              "pages_read_engagement",
              "pages_manage_posts",
              "pages_manage_engagement",
              "read_insights",
            ],
          },
        ],
      });
    });

    it("an exchange with inspected zero expiry omits expiresAt", async () => {
      const { adapter } = setup([
        json({ access_token: "short-user-secret" }),
        json({ access_token: "long-user-secret", token_type: "bearer" }),
        json({ data: { app_id: "facebook-client", expires_at: 0, is_valid: true } }),
        defaultPermissions(),
        json({ data: [pageItem("page-1", "page-access-secret")] }),
      ]);

      expect(await adapter.exchangeAuthorizationCode!(context, exchangeInput)).toEqual({
        accounts: [
          {
            accessToken: "page-access-secret",
            account: { displayName: "Page page-1", id: "page-1" },
            refreshToken: '{"pageId":"page-1","userAccessToken":"long-user-secret"}',
            scopes: [
              "pages_show_list",
              "pages_read_engagement",
              "pages_manage_posts",
              "pages_manage_engagement",
              "read_insights",
            ],
          },
        ],
      });
    });

    it("a declined publishing permission stops before reading Pages", async () => {
      const { adapter, requests } = setup([
        json({ access_token: "short" }),
        json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
        json({
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "declined" },
          ],
        }),
      ]);

      expect(await adapter.exchangeAuthorizationCode!(context, exchangeInput)).toEqual({
        accounts: [],
      });
      expect(requests).toHaveLength(3);
    });

    it("paginates and deduplicates direct and business-assigned Pages", async () => {
      const adapter = createFacebookAdapter({
        clientId: "facebook-client",
        clientSecret: "facebook-client-secret",
        now: () => NOW,
        redirectUri,
        fetch: async (target, init) => {
          const url = new URL(String(target));
          if (url.pathname.endsWith("/oauth/access_token")) {
            const form = new URLSearchParams(String(init?.body));
            return json({
              access_token: form.get("grant_type") === "fb_exchange_token" ? "long" : "short",
              expires_in: 3_600,
              token_type: "bearer",
            });
          }
          if (url.pathname.endsWith("/me/permissions")) {
            return json({
              data: [
                { permission: "pages_show_list", status: "granted" },
                { permission: "pages_read_engagement", status: "granted" },
                { permission: "pages_manage_posts", status: "granted" },
                { permission: "business_management", status: "granted" },
              ],
            });
          }
          if (url.pathname.endsWith("/me/accounts")) {
            return url.searchParams.has("after")
              ? json({ data: [pageItem("direct", "dup-token"), pageItem("direct-2")] })
              : json({
                  data: [pageItem("direct")],
                  paging: {
                    cursors: { after: "c1" },
                    next: `${GRAPH}/me/accounts?after=c1`,
                  },
                });
          }
          if (url.pathname.endsWith("/me/business_users")) {
            return json({ data: [{ id: "bu-1" }, { id: "bu-2" }] });
          }
          if (url.pathname.endsWith("/bu-1/assigned_pages")) {
            return json({ data: [pageItem("direct", "via-bu1"), pageItem("biz-1")] });
          }
          if (url.pathname.endsWith("/bu-2/assigned_pages")) {
            return json({ data: [pageItem("biz-1", "via-bu2"), pageItem("biz-2")] });
          }
          throw new Error(`unexpected ${url.pathname}`);
        },
      });

      const result = await adapter.exchangeAuthorizationCode!(context, exchangeInput);

      expect(
        "accounts" in result ? result.accounts.map((c) => [c.account.id, c.accessToken]) : [],
      ).toEqual([
        ["direct", "page-token-direct"],
        ["direct-2", "page-token-direct-2"],
        ["biz-1", "page-token-biz-1"],
        ["biz-2", "page-token-biz-2"],
      ]);
    });

    it("caps concurrent business Page discovery at four edges", async () => {
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const overlapping = new Promise<void>((resolve) => {
        started = resolve;
      });
      let active = 0;
      let peak = 0;
      const users = Array.from({ length: 6 }, (_, index) => ({ id: `bu-${index}` }));
      const adapter = createFacebookAdapter({
        clientId: "facebook-client",
        clientSecret: "facebook-client-secret",
        now: () => NOW,
        redirectUri,
        fetch: async (target, init) => {
          const url = new URL(String(target));
          if (url.pathname.endsWith("/oauth/access_token")) {
            return json({
              access_token: new URLSearchParams(String(init?.body)).has("fb_exchange_token")
                ? "long"
                : "short",
              expires_in: 3_600,
              token_type: "bearer",
            });
          }
          if (url.pathname.endsWith("/me/permissions")) {
            return json({
              data: [
                { permission: "pages_show_list", status: "granted" },
                { permission: "pages_read_engagement", status: "granted" },
                { permission: "pages_manage_posts", status: "granted" },
                { permission: "business_management", status: "granted" },
              ],
            });
          }
          if (url.pathname.endsWith("/me/accounts")) return json({ data: [] });
          if (url.pathname.endsWith("/me/business_users")) return json({ data: users });
          const id = url.pathname.split("/")[2]!;
          active += 1;
          peak = Math.max(peak, active);
          if (active >= 2) started();
          try {
            await held;
            return json({ data: [pageItem(`page-${id}`)] });
          } finally {
            active -= 1;
          }
        },
      });

      const exchange = adapter.exchangeAuthorizationCode!(context, exchangeInput);
      try {
        await Promise.race([overlapping, exchange]);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(4);
      } finally {
        release();
      }
      const result = await exchange;
      expect("accounts" in result ? result.accounts.map((c) => c.account.id) : []).toEqual(
        users.map((user) => `page-${user.id}`),
      );
      expect(peak).toBeLessThanOrEqual(4);
    });

    const discoveryPage = (index: number, hasNext: boolean) =>
      json({
        data: [],
        ...(hasNext
          ? {
              paging: {
                cursors: { after: `c-${index}` },
                next: `${GRAPH}/me/accounts?after=c-${index}`,
              },
            }
          : {}),
      });

    it("pages ending on the last allowed discovery request", async () => {
      const { adapter } = setup(
        [
          json({ access_token: "short" }),
          json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
          defaultPermissions(),
          discoveryPage(0, true),
          discoveryPage(1, true),
          discoveryPage(2, false),
        ],
        { maxDiscoveryRequests: 3 },
      );

      expect(await adapter.exchangeAuthorizationCode!(context, exchangeInput)).toEqual({
        accounts: [],
      });
    });

    it("pages continuing past maxDiscoveryRequests", async () => {
      const { adapter } = setup(
        [
          json({ access_token: "short" }),
          json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
          defaultPermissions(),
          discoveryPage(0, true),
          discoveryPage(1, true),
          discoveryPage(2, true),
          discoveryPage(3, false),
        ],
        { maxDiscoveryRequests: 3 },
      );

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchangeInput))).toEqual(
        providerFailure("transient", "facebook_oauth_page_pagination_invalid"),
      );
      expect(discoveryRequestLimit(undefined)).toEqual(1_000);
    });

    it("discovered Pages exactly at maxDiscoveredPages", async () => {
      const { adapter } = setup(
        [
          json({ access_token: "short" }),
          json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
          defaultPermissions(),
          json({ data: [pageItem("1"), pageItem("2")] }),
        ],
        { maxDiscoveredPages: 2 },
      );

      const ok = await adapter.exchangeAuthorizationCode!(context, exchangeInput);

      expect("accounts" in ok ? ok.accounts.map((c) => c.account.id) : []).toEqual(["1", "2"]);
    });

    it("discovered Pages past maxDiscoveredPages", async () => {
      const { adapter } = setup(
        [
          json({ access_token: "short" }),
          json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
          defaultPermissions(),
          json({ data: [pageItem("1"), pageItem("2"), pageItem("3")] }),
        ],
        { maxDiscoveredPages: 2 },
      );

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchangeInput))).toEqual(
        providerFailure("transient", "facebook_oauth_page_list_invalid"),
      );
    });

    it("reports malformed OAuth responses without leaking credentials", async () => {
      const { adapter } = setup([
        json({ access_token: "short-secret" }),
        json({ access_token: "long-secret", expires_in: 0, token_type: "bearer" }),
      ]);

      const error = await adapter.exchangeAuthorizationCode!(context, exchangeInput).catch(
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(ProviderAdapterError);
      const diagnostic = failureDiagnostic(error as ProviderAdapterError);
      expect(diagnostic).toEqual({
        classification: "transient",
        code: "facebook_oauth_token_expiry_invalid",
        retryable: true,
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/secret|authorization-code/);
    });

    it("a foreign redirect URI sends nothing", async () => {
      const { adapter, requests } = setup();

      await expect(
        adapter.exchangeAuthorizationCode!(context, {
          ...exchangeInput,
          redirectUri: "https://evil.example/callback",
        }),
      ).rejects.toEqual(new TypeError("OAuth redirect URI does not match configuration"));
      expect(requests).toEqual([]);
    });

    it("Facebook down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.exchangeAuthorizationCode!(context, exchangeInput))).toEqual(
        unavailable,
      );
    });
  });

  describe("refreshAccessToken", () => {
    const refreshSecret = '{"pageId":"page-1","userAccessToken":"current-user-secret"}';

    it("exchanges the user token and derives a fresh Page token", async () => {
      const { adapter, requests } = setup([
        json({ access_token: "new-user-secret", expires_in: 5_184_000, token_type: "bearer" }),
        json({ access_token: "new-page-secret", id: "page-1", name: "Meltiply Page" }),
        defaultPermissions(),
      ]);

      expect(await adapter.refreshAccessToken!(context, refreshSecret)).toEqual({
        accessToken: "new-page-secret",
        expiresAt: "2026-09-17T00:00:00.000Z",
        refreshToken: '{"pageId":"page-1","userAccessToken":"new-user-secret"}',
        scopes: [
          "pages_show_list",
          "pages_read_engagement",
          "pages_manage_posts",
          "pages_manage_engagement",
          "read_insights",
        ],
      });
      expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "POST", url: `${GRAPH}/oauth/access_token` },
        { method: "GET", url: `${GRAPH}/page-1` },
        { method: "GET", url: `${GRAPH}/me/permissions` },
      ]);
    });

    it("a mismatched Page response is malformed", async () => {
      const { adapter } = setup([
        json({ access_token: "new-user-secret", expires_in: 3_600, token_type: "bearer" }),
        json({ access_token: "new-page-secret", id: "other-page" }),
      ]);

      expect(await failureOf(adapter.refreshAccessToken!(context, refreshSecret))).toEqual(
        malformedAnswer,
      );
    });

    it("an invalid refresh secret sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.refreshAccessToken!(context, "not-json"))).toEqual(
        refused("facebook_refresh_secret_invalid"),
      );
      expect(requests).toEqual([]);
    });

    it("Facebook down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.refreshAccessToken!(context, refreshSecret))).toEqual(
        unavailable,
      );
    });
  });

  describe("getAccountAnalytics", () => {
    it("reads followers_count without using fan_count", async () => {
      const { adapter, requests } = setup([json({ fan_count: 350, followers_count: 420 })]);

      expect(await adapter.getAccountAnalytics!(context, credentials)).toEqual({
        followers: 420,
        recordedAt: NOW.toISOString(),
      });
      expect(requests).toEqual([
        {
          headers: { accept: "application/json", authorization: "Bearer page-access-secret" },
          method: "GET",
          query: { fields: "followers_count" },
          redirect: "manual",
          url: `${GRAPH}/page-1`,
        },
      ]);
    });

    it("Facebook down", async () => {
      const { adapter } = setup([down()]);

      expect(await failureOf(adapter.getAccountAnalytics!(context, credentials))).toEqual(
        unavailable,
      );
    });
  });

  describe("listAnalytics", () => {
    it("reads Reel insights and video edge counts", async () => {
      const { adapter, requests } = setup([
        json({
          data: [
            { name: "blue_reels_play_count", period: "lifetime", values: [{ value: 1200 }] },
            { name: "post_video_social_actions", period: "lifetime", values: [{ value: 21 }] },
          ],
        }),
        json({
          comments: { summary: { total_count: 9 } },
          likes: { summary: { total_count: 84 } },
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
      expect(requests.map(({ query, url }) => ({ query, url }))).toEqual([
        {
          query: {
            metric: "blue_reels_play_count,post_video_social_actions",
            period: "lifetime",
          },
          url: `${GRAPH}/video-1/video_insights`,
        },
        {
          query: { fields: "likes.summary(true).limit(0),comments.summary(true).limit(0)" },
          url: `${GRAPH}/video-1`,
        },
      ]);
    });

    it("a non-Reel operation sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.listAnalytics!(
            context,
            credentials,
            { providerOperationId: "post:page-1_1", providerPostId: "page-1_1" },
            { limit: 100 },
          ),
        ),
      ).toEqual(refused("facebook_format_analytics_unavailable"));
      expect(requests).toEqual([]);
    });

    it("Facebook down", async () => {
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
    it("a caption-only feed post", async () => {
      const { adapter, requests } = setup([json({ id: "page-1_post-1" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({ caption: "A regular Page update", hashtags: [], media: [] }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "post:page-1_post-1",
        providerPostId: "page-1_post-1",
        providerUrl: "https://www.facebook.com/page-1_post-1",
      });
      expect(requests).toEqual([
        {
          body: JSON.stringify({ message: "A regular Page update", published: true }),
          headers: {
            accept: "application/json",
            authorization: "Bearer page-access-secret",
            "content-type": "application/json",
          },
          method: "POST",
          query: {},
          redirect: "manual",
          url: `${GRAPH}/page-1/feed`,
        },
      ]);
    });

    it("ordered photos staged before creating one feed post", async () => {
      const { adapter, requests } = setup([
        json({ id: "photo-1" }),
        json({ id: "photo-2" }),
        json({ id: "page-1_photos" }),
      ]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "Two moments",
            hashtags: [],
            media: [photo("first"), photo("second")],
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "post:page-1_photos",
        providerPostId: "page-1_photos",
        providerUrl: "https://www.facebook.com/page-1_photos",
      });
      expect(requests.map(({ body, url }) => ({ body: JSON.parse(body!), url }))).toEqual([
        {
          body: { published: false, url: "https://assets.example/first.jpg" },
          url: `${GRAPH}/page-1/photos`,
        },
        {
          body: { published: false, url: "https://assets.example/second.jpg" },
          url: `${GRAPH}/page-1/photos`,
        },
        {
          body: {
            attached_media: [{ media_fbid: "photo-1" }, { media_fbid: "photo-2" }],
            message: "Two moments",
            published: true,
          },
          url: `${GRAPH}/page-1/feed`,
        },
      ]);
    });

    it("a native feed draft", async () => {
      const { adapter, requests } = setup([json({ id: "page-1_draft-1" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "Review this in Meta",
            hashtags: [],
            media: [],
            providerOptions: { facebook: { deliveryMode: "draft", postType: "feed" } },
          }),
        ),
      ).toEqual({
        delivery: "draft",
        outcome: "confirmed_success",
        providerOperationId: "post_draft:page-1_draft-1",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        message: "Review this in Meta",
        published: false,
      });
    });

    it("a Page video", async () => {
      const { adapter, requests } = setup([json({ id: "long-video" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "A longer Page video",
            hashtags: [],
            providerOptions: { facebook: { postType: "video" } },
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:long-video",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        description: "A longer Page video",
        file_url: "https://assets.example/reel.mp4?signature=secret",
        published: true,
      });
    });

    it("a slideshow from ordered photos", async () => {
      const { adapter, requests } = setup([json({ id: "slideshow-1" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            media: [photo("one"), photo("two"), photo("three")],
            providerOptions: { facebook: { postType: "slideshow" } },
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:slideshow-1",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        description: "A Page Reel #launch",
        published: true,
        slideshow_spec: {
          images_urls: [
            "https://assets.example/one.jpg",
            "https://assets.example/two.jpg",
            "https://assets.example/three.jpg",
          ],
        },
      });
    });

    it("a slideshow with a GIF sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.publish!(
            context,
            credentials,
            publishInput({
              media: [{ ...photo("one"), contentType: "image/gif" }, photo("two"), photo("three")],
              providerOptions: { facebook: { postType: "slideshow" } },
            }),
          ),
        ),
      ).toEqual(refused("facebook_slideshow_invalid"));
      expect(requests).toEqual([]);
    });

    it("a crossposted video", async () => {
      const { adapter, requests } = setup([json({ id: "crossposted-copy" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "",
            hashtags: [],
            media: [],
            providerOptions: {
              facebook: { crosspostedVideoId: "source-video", postType: "crosspost" },
            },
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "video:crossposted-copy",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        crossposted_video_id: "source-video",
        description: "",
        published: true,
      });
    });

    it("a photo Story", async () => {
      const { adapter, requests } = setup([
        json({ id: "story-photo" }),
        json({ post_id: 1234, success: true }),
      ]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "",
            hashtags: [],
            media: [photo("story")],
            providerOptions: { facebook: { postType: "story" } },
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "story:story-photo",
        providerPostId: "1234",
      });
      expect(requests.map(({ url }) => url)).toEqual([
        `${GRAPH}/page-1/photos`,
        `${GRAPH}/page-1/photo_stories`,
      ]);
    });

    it("a photo Story whose commit fails retains the story operation", async () => {
      const { adapter } = setup([json({ id: "story-photo" }), down()]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "",
            hashtags: [],
            media: [photo("story")],
            providerOptions: { facebook: { postType: "story" } },
          }),
        ),
      ).toEqual({
        failure: providerFailure("ambiguous", "provider_http_503"),
        outcome: "unknown",
        providerOperationId: "story:story-photo",
      });
    });

    it("a video Story", async () => {
      const { adapter, requests } = setup([
        json({ upload_url: `${RUPLOAD}/story-video`, video_id: "story-video" }),
        json({ success: true }),
        json({ post_id: "video-story-post", success: true }),
      ]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "",
            hashtags: [],
            providerOptions: { facebook: { postType: "story" } },
          }),
        ),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "story:story-video",
        providerPostId: "video-story-post",
      });
      expect(requests.map(({ query, url }) => ({ query, url }))).toEqual([
        { query: { upload_phase: "start" }, url: `${GRAPH}/page-1/video_stories` },
        { query: {}, url: `${RUPLOAD}/story-video` },
        {
          query: { upload_phase: "finish", video_id: "story-video" },
          url: `${GRAPH}/page-1/video_stories`,
        },
      ]);
    });

    it("a Story with a caption sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.publish!(
            context,
            credentials,
            publishInput({
              caption: "Not allowed",
              hashtags: [],
              providerOptions: { facebook: { postType: "story" } },
            }),
          ),
        ),
      ).toEqual(refused("facebook_story_caption_unsupported"));
      expect(requests).toEqual([]);
    });

    it("a hosted Page Reel", async () => {
      const { adapter, requests } = setup([
        json({ upload_url: `${RUPLOAD}/video-1`, video_id: "video-1" }),
        json({ success: true }),
        json({ success: true }),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "finishing:video-1",
      });
      expect(requests).toEqual([
        {
          headers: { accept: "application/json", authorization: "Bearer page-access-secret" },
          method: "POST",
          query: { upload_phase: "start" },
          redirect: "manual",
          url: `${GRAPH}/page-1/video_reels`,
        },
        {
          headers: {
            accept: "application/json",
            authorization: "OAuth page-access-secret",
            file_url: "https://assets.example/reel.mp4?signature=secret",
          },
          method: "POST",
          query: {},
          redirect: "manual",
          url: `${RUPLOAD}/video-1`,
        },
        {
          headers: { accept: "application/json", authorization: "Bearer page-access-secret" },
          method: "POST",
          query: {
            description: "A Page Reel #launch",
            upload_phase: "finish",
            video_id: "video-1",
            video_state: "PUBLISHED",
          },
          redirect: "manual",
          url: `${GRAPH}/page-1/video_reels`,
        },
      ]);
    });

    it("a Reel whose upload loses the connection retains upload_submitted", async () => {
      const { adapter } = setup([
        json({ upload_url: `${RUPLOAD}/video-upload`, video_id: "video-upload" }),
        new TypeError("connection lost"),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("ambiguous", "provider_http_request_failed"),
        outcome: "unknown",
        providerOperationId: "upload_submitted:video-upload",
      });
    });

    it("a Reel whose finish loses the connection retains finish_submitted", async () => {
      const { adapter } = setup([
        json({ upload_url: `${RUPLOAD}/video-finish`, video_id: "video-finish" }),
        json({ success: true }),
        new TypeError("connection lost"),
      ]);

      expect(await adapter.publish!(context, credentials, publishInput())).toEqual({
        failure: providerFailure("ambiguous", "provider_http_request_failed"),
        outcome: "unknown",
        providerOperationId: "finish_submitted:video-finish",
      });
    });

    it("an A/B experiment", async () => {
      const { adapter, requests } = setup([json({ id: "experiment-1" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "Compare both openings",
            hashtags: [],
            media: [],
            providerOptions: {
              facebook: {
                abTest: {
                  controlVideoId: "draft-one",
                  durationSeconds: 1800,
                  experimentVideoIds: ["draft-one", "draft-two"],
                  name: "Launch comparison",
                  optimizationGoal: "REELS_PLAYS",
                },
                postType: "ab_test",
              },
            },
          }),
        ),
      ).toEqual({
        delivery: "experiment",
        outcome: "confirmed_success",
        providerOperationId: "ab_test:experiment-1",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        control_video_id: "draft-one",
        description: "Compare both openings",
        duration: 1800,
        experiment_video_ids: ["draft-one", "draft-two"],
        name: "Launch comparison",
        optimization_goal: "REELS_PLAYS",
      });
    });

    it("a live broadcast", async () => {
      const { adapter, requests } = setup([json({ id: "live-1" })]);

      expect(
        await adapter.publish!(
          context,
          credentials,
          publishInput({
            caption: "Live launch",
            hashtags: [],
            media: [],
            providerOptions: { facebook: { postType: "live" } },
          }),
        ),
      ).toEqual({
        delivery: "broadcast",
        outcome: "confirmed_success",
        providerOperationId: "live:live-1",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        description: "Live launch",
        status: "LIVE_NOW",
        title: "Live launch",
      });
    });

    it("an empty feed post sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.publish!(
            context,
            credentials,
            publishInput({ caption: "", hashtags: [], media: [] }),
          ),
        ),
      ).toEqual(refused("facebook_feed_invalid"));
      expect(requests).toEqual([]);
    });

    it("no Page account sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(adapter.publish!(context, { accessToken: "token" }, publishInput())),
      ).toEqual(refused("facebook_page_account_required"));
      expect(requests).toEqual([]);
    });
  });

  describe("getBroadcastInfo", () => {
    it("reads the RTMPS ingest URL for a live broadcast", async () => {
      const { adapter } = setup([
        json({
          id: "live-1",
          secure_stream_url: "rtmps://live-api.facebook.com:443/rtmp/secret-key",
          status: "LIVE",
        }),
      ]);

      expect(
        await adapter.getBroadcastInfo!(context, credentials, {
          providerOperationId: "live:live-1",
        }),
      ).toEqual({
        ingestUrl: "rtmps://live-api.facebook.com:443/rtmp/secret-key",
        providerPostId: "live-1",
        providerUrl: "https://www.facebook.com/live-1",
        state: "live",
      });
    });

    it("Facebook down", async () => {
      const { adapter } = setup([down()]);

      expect(
        await failureOf(
          adapter.getBroadcastInfo!(context, credentials, { providerOperationId: "live:live-1" }),
        ),
      ).toEqual(unavailable);
    });
  });

  describe("endBroadcast", () => {
    it("a live broadcast that becomes VOD returns its permalink", async () => {
      const { adapter, requests } = setup([
        json({ id: "live-1" }),
        json({ id: "live-1", status: "VOD" }),
      ]);

      expect(
        await adapter.endBroadcast!(context, credentials, { providerOperationId: "live:live-1" }),
      ).toEqual({
        outcome: "confirmed_success",
        providerOperationId: "ended_live:live-1",
        providerPostId: "live-1",
        providerUrl: "https://www.facebook.com/live-1",
      });
      expect(requests.map(({ method, query, url }) => ({ method, query, url }))).toEqual([
        { method: "POST", query: { end_live_video: "true" }, url: `${GRAPH}/live-1` },
        { method: "GET", query: { fields: "id,status" }, url: `${GRAPH}/live-1` },
      ]);
    });

    it("a live broadcast not yet VOD returns broadcast delivery", async () => {
      const { adapter } = setup([
        json({ id: "live-1" }),
        json({ id: "live-1", status: "PROCESSING" }),
      ]);

      expect(
        await adapter.endBroadcast!(context, credentials, { providerOperationId: "live:live-1" }),
      ).toEqual({
        delivery: "broadcast",
        outcome: "confirmed_success",
        providerOperationId: "ended_live:live-1",
      });
    });
  });

  describe("lookupPublication", () => {
    it("an ended_live operation resolves without contacting Facebook", async () => {
      const { adapter, requests } = setup();

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "ended_live:live-1",
        }),
      ).toEqual({
        result: {
          delivery: "broadcast",
          outcome: "confirmed_success",
          providerOperationId: "ended_live:live-1",
        },
        state: "delivered",
      });
      expect(requests).toEqual([]);
    });

    it("an ab_test operation confirms the experiment node", async () => {
      const { adapter } = setup([json({ id: "exp-1" })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "ab_test:exp-1",
        }),
      ).toEqual({
        result: {
          delivery: "experiment",
          outcome: "confirmed_success",
          providerOperationId: "ab_test:exp-1",
        },
        state: "delivered",
      });
    });

    it("a story operation reads the Page stories edge", async () => {
      const { adapter } = setup([
        json({ data: [{ media_id: "m1", post_id: "p1", status: "PUBLISHED" }] }),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, { providerOperationId: "story:m1" }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "story:m1",
          providerPostId: "p1",
        },
        state: "published",
      });
    });

    it("a ready video resolves as published", async () => {
      const { adapter } = setup([json({ id: "v1", status: { video_status: "ready" } })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "video:v1",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "video:v1",
          providerPostId: "v1",
          providerUrl: "https://www.facebook.com/v1",
        },
        state: "published",
      });
    });

    it("a missing video (404) returns not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "video:v1",
        }),
      ).toEqual({ state: "not_found" });
    });

    it("a published Page post resolves as published", async () => {
      const { adapter } = setup([json({ id: "page-1_p1", is_published: true })]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "post:page-1_p1",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "post:page-1_p1",
          providerPostId: "page-1_p1",
          providerUrl: "https://www.facebook.com/page-1_p1",
        },
        state: "published",
      });
    });

    it("a missing Page post (404) returns not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "post:page-1_p1",
        }),
      ).toEqual({ state: "not_found" });
    });

    it("a post ID for another Page sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(
        await failureOf(
          adapter.lookupPublication!(context, credentials, {
            providerOperationId: "post:other_p1",
          }),
        ),
      ).toEqual(malformedAnswer);
      expect(requests).toEqual([]);
    });

    it("a finishing Reel still processing", async () => {
      const { adapter } = setup([json(reelStatus("v1"))]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "finishing:v1",
        }),
      ).toEqual({ providerOperationId: "finishing:v1", state: "processing" });
    });

    it("a finish_submitted Reel that completed resolves as published", async () => {
      const { adapter } = setup([
        json(reelStatus("v1", { processing: "complete", publishing: "complete", video: "ready" })),
      ]);

      expect(
        await adapter.lookupPublication!(context, credentials, {
          providerOperationId: "finish_submitted:v1",
        }),
      ).toEqual({
        result: {
          outcome: "confirmed_success",
          providerOperationId: "finish_submitted:v1",
          providerPostId: "v1",
        },
        state: "published",
      });
    });

    it("a failed Reel hides provider error details", async () => {
      const { adapter } = setup([
        json({
          id: "v1",
          status: {
            processing_phase: { error: { message: "private detail secret=1" }, status: "error" },
            publishing_phase: { status: "not_started" },
            uploading_phase: { status: "complete" },
            video_status: "error",
          },
        }),
      ]);

      const failedResult = await adapter.lookupPublication!(context, credentials, {
        providerOperationId: "finishing:v1",
      });

      expect(failedResult).toEqual({
        result: {
          failure: refused("facebook_reel_processing_failed"),
          outcome: "confirmed_failure",
          providerOperationId: "finishing:v1",
        },
        state: "failed",
      });
      expect(JSON.stringify(failedResult)).not.toContain("private detail");
    });

    it("a missing Reel (404) returns not_found", async () => {
      const { adapter } = setup([json({}, 404)]);

      expect(
        await adapter.lookupPublication!(context, credentials, { providerPostId: "v1" }),
      ).toEqual({ state: "not_found" });
    });

    it("no operation or post ID sends nothing", async () => {
      const { adapter, requests } = setup();

      expect(await failureOf(adapter.lookupPublication!(context, credentials, {}))).toEqual(
        malformedAnswer,
      );
      expect(requests).toEqual([]);
    });
  });
});
