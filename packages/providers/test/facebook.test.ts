import { describe, expect, it, vi } from "vite-plus/test";

import {
  createFacebookAdapter,
  failureDiagnostic,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderRequestContext,
  type PublishInput,
} from "../src";

const context: ProviderRequestContext = {
  operationId: "operation-1",
  requestId: "request-1",
};
const credentials = {
  accessToken: "page-access-secret",
  accountId: "page-1",
};
const redirectUri = "https://api.example.com/api/v1/platforms/facebook/callback";

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
const defaultGrantedPermissions: Responder = () =>
  json({
    data: [
      { permission: "pages_show_list", status: "granted" },
      { permission: "pages_read_engagement", status: "granted" },
      { permission: "pages_manage_posts", status: "granted" },

      { permission: "pages_manage_engagement", status: "granted" },

      { permission: "read_insights", status: "granted" },
    ],
  });

function adapter(fetcher: typeof fetch, now = new Date("2026-07-19T00:00:00Z")) {
  return createFacebookAdapter({
    clientId: "facebook-client",
    clientSecret: "facebook-client-secret",
    fetch: fetcher,
    now: () => now,
    redirectUri,
    timeoutMilliseconds: 100,
  });
}

function publishInput(patch: Partial<PublishInput> = {}): PublishInput {
  return {
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
  };
}

function reelStatus(
  id: string,
  patch: Partial<{
    processing: string;
    publishing: string;
    uploading: string;
    video: string;
  }> = {},
) {
  const status = {
    processing: "in_progress",
    publishing: "not_started",
    uploading: "complete",
    video: "processing",
    ...patch,
  };
  return {
    id,
    status: {
      processing_phase: { status: status.processing },
      publishing_phase: { status: status.publishing },
      uploading_phase: { status: status.uploading },
      video_status: status.video,
    },
  };
}

describe("createFacebookAdapter", () => {
  it("measures followers without misreporting Page likes as following", async () => {
    const providerCalls = sequence((url) => {
      expect(url.searchParams.get("fields")).toBe("followers_count");
      return json({ followers_count: 420, fan_count: 350 });
    });
    await expect(
      adapter(providerCalls.fetcher).getAccountAnalytics!(context, credentials),
    ).resolves.toEqual({
      followers: 420,
      recordedAt: "2026-07-19T00:00:00.000Z",
    });
  });

  it("advertises every implemented Page publishing family", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    expect(provider.capability).toMatchObject({
      accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
      analytics: true,
      asset_types: ["image", "video"],
      comments: false,
      connect_available: true,
      max_caption_length: 2_200,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 30,
      max_video_duration_sec: 60,
      max_media_count: 10,
      // Text and link posts need no attachment, so the Platform cannot demand one.
      min_media_count: 0,
      multi_asset_types: ["image"],
      platform: "facebook",
      publish: true,
      reply: false,
    });
    expect(provider.transferModes).toEqual(["remote_ingest"]);
    expect(provider.listAnalytics).toBeTypeOf("function");
    expect(provider.listComments).toBeUndefined();
    expect(provider.reply).toBeUndefined();
    expect(provider.cancelPublication).toBeUndefined();
    const registry = new ProviderRegistry();
    expect(() => registry.register("facebook", provider)).not.toThrow();
  });

  it("builds a state-bound Facebook dialog URL and pins the callback", () => {
    const provider = adapter(vi.fn<typeof fetch>());
    const url = new URL(
      provider.authorizationUrl!({
        codeChallenge: "unused-by-facebook",
        redirectUri,
        state: "oauth-state",
      }),
    );
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "facebook-client",
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,read_insights,business_management",
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

  it("exchanges a code for one explicit publishable Page", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/oauth/access_token");
        expect(String(init.body)).toContain("code=authorization-code");
        return json({ access_token: "short-user-secret" });
      },
      (_url, init) => {
        expect(String(init.body)).toContain("fb_exchange_token=short-user-secret");
        return json({
          access_token: "long-user-secret",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/me/permissions");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer long-user-secret");
        return defaultGrantedPermissions(url, init);
      },
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/me/accounts");
        expect(url.searchParams.get("limit")).toBe("100");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer long-user-secret");
        return json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_ANALYZE"],
            },
          ],
        });
      },
    );

    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "unused-by-facebook",
        redirectUri,
      }),
    ).resolves.toEqual({
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
  });

  // A successful exchange can omit expires_in; inspect the actual token rather
  // than rejecting a connectable Page or inventing a fresh token lifetime.
  it("connects a Page using inspected expiry when the exchange omits expires_in", async () => {
    const calls = sequence(
      () => json({ access_token: "short-user-secret" }),
      () => json({ access_token: "long-user-secret", token_type: "bearer" }),
      () =>
        json({
          data: {
            app_id: "facebook-client",
            is_valid: true,
            expires_at: 1_788_566_400,
          },
        }),
      defaultGrantedPermissions,
      () =>
        json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    );
    await expect(
      adapter(calls.fetcher, new Date("2026-07-19T00:00:00.123Z")).exchangeAuthorizationCode!(
        context,
        {
          code: "authorization-code",
          codeVerifier: "unused",
          redirectUri,
        },
      ),
    ).resolves.toMatchObject({
      accounts: [
        {
          accessToken: "page-access-secret",
          account: { id: "page-1" },
          expiresAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    });
  });

  // Meta's inspected zero timestamp is an absent time-based expiry, not 1970.
  // Both connecting a Page and rotating its credentials must preserve that fact.
  it("connects and refreshes a Page with inspected zero expiry", async () => {
    const inspect = () =>
      json({
        data: { app_id: "facebook-client", is_valid: true, expires_at: 0 },
      });
    const calls = sequence(
      () => json({ access_token: "short-user-secret" }),
      () => json({ access_token: "long-user-secret", token_type: "bearer" }),
      inspect,
      defaultGrantedPermissions,
      () =>
        json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
      () => json({ access_token: "rotated-user-secret", token_type: "bearer" }),
      inspect,
      () => json({ id: "page-1", access_token: "rotated-page-secret" }),
    );
    const provider = adapter(calls.fetcher);
    const result = await provider.exchangeAuthorizationCode!(context, {
      code: "authorization-code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect("accounts" in result).toBe(true);
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts).toHaveLength(1);
    const connection = result.accounts[0]!;
    expect(connection.accessToken).toBe("page-access-secret");
    expect(connection.account.id).toBe("page-1");
    expect(connection.expiresAt).toBeUndefined();
    const refreshed = await provider.refreshAccessToken!(context, connection.refreshToken!);
    expect(refreshed.accessToken).toBe("rotated-page-secret");
    expect(refreshed.expiresAt).toBeUndefined();
    expect(refreshed.refreshToken).toBe(
      '{"pageId":"page-1","userAccessToken":"rotated-user-secret"}',
    );
  });

  // Inspection must not accept another app's, invalid, expired, unbounded,
  // or malformed token merely because the exchange omitted its expiry.
  it.each([
    { app_id: "another-app", is_valid: true, expires_at: 0 },
    { app_id: "facebook-client", is_valid: false, expires_at: 0 },
    { app_id: "facebook-client", is_valid: true, expires_at: -1 },
    { app_id: "facebook-client", is_valid: true, expires_at: 1_700_000_000 },
    { app_id: "facebook-client", is_valid: true, expires_at: 2_000_000_000 },
    { app_id: "facebook-client", is_valid: true, expires_at: "1788566400" },
    { app_id: "facebook-client", is_valid: true },
  ])("rejects unsafe inspected token metadata: %j", async (data) => {
    const calls = sequence(
      () => json({ access_token: "short-user-secret" }),
      () => json({ access_token: "long-user-secret", token_type: "bearer" }),
      () => json({ data }),
    );
    await expect(
      adapter(calls.fetcher).exchangeAuthorizationCode!(context, {
        code: "authorization-code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: { code: "facebook_oauth_token_expiry_invalid" },
    });
  });

  // Malformed successful responses must identify the failing OAuth field for
  // operators without leaking the authorization code, user tokens, or Page data.
  it.each([
    {
      code: "facebook_oauth_authorization_token_invalid",
      responses: [{ access_token: 123 }],
    },
    {
      code: "facebook_oauth_token_type_invalid",
      responses: [
        { access_token: "short-user-secret" },
        { access_token: "long-user-secret", expires_in: 3600 },
      ],
    },
    {
      code: "facebook_oauth_token_expiry_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 0,
        },
      ],
    },
    {
      code: "facebook_oauth_permissions_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 3600,
        },
        { data: null },
      ],
    },
    {
      code: "facebook_oauth_page_list_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 3600,
        },
        {
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },

            { permission: "pages_manage_engagement", status: "granted" },

            { permission: "read_insights", status: "granted" },
          ],
        },
        { data: null },
      ],
    },
    {
      code: "facebook_oauth_page_access_token_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 3600,
        },
        {
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },

            { permission: "pages_manage_engagement", status: "granted" },

            { permission: "read_insights", status: "granted" },
          ],
        },
        {
          data: [
            {
              id: "page-1",
              name: "private-page-name",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        },
      ],
    },
    {
      code: "facebook_oauth_page_tasks_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 3600,
        },
        {
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },

            { permission: "pages_manage_engagement", status: "granted" },

            { permission: "read_insights", status: "granted" },
          ],
        },
        {
          data: [
            {
              id: "page-1",
              name: "private-page-name",
              access_token: "page-secret",
              tasks: "CREATE_CONTENT",
            },
          ],
        },
      ],
    },
    {
      code: "facebook_oauth_page_pagination_invalid",
      responses: [
        { access_token: "short-user-secret" },
        {
          access_token: "long-user-secret",
          token_type: "bearer",
          expires_in: 3600,
        },
        {
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },

            { permission: "pages_manage_engagement", status: "granted" },

            { permission: "read_insights", status: "granted" },
          ],
        },
        {
          data: [],
          paging: { next: "https://evil.example/me/accounts?after=bad" },
        },
      ],
    },
  ])("reports $code without credentials", async ({ code, responses }) => {
    const calls = sequence(...responses.map((body) => () => json(body)));
    const error: unknown = await adapter(calls.fetcher).exchangeAuthorizationCode!(context, {
      code: "authorization-code",
      codeVerifier: "unused",
      redirectUri,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    if (!(error instanceof ProviderAdapterError)) throw new Error("Expected provider failure");
    const diagnostic = failureDiagnostic(error);
    expect(diagnostic).toEqual({
      classification: "transient",
      code,
      retryable: true,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|authorization-code|private-page-name/);
  });

  it("returns selection candidates for multiple eligible Pages without auto-connecting or rejecting", async () => {
    const multiplePages = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      () =>
        json({
          data: [
            {
              access_token: "page-one-token",
              id: "page-1",
              link: "https://www.facebook.com/meltiply.page",
              name: "Page One",
              picture: {
                data: { url: "https://cdn.example/page-1.jpg" },
              },
              tasks: ["CREATE_CONTENT"],
            },
            {
              access_token: "page-two-token",
              id: "page-2",
              link: "https://www.facebook.com/profile.php?id=page-2",
              name: "Page Two",
              tasks: ["PROFILE_PLUS_CREATE_CONTENT"],
            },
            {
              access_token: "page-three-token",
              id: "page-3",
              name: "Page Three Ineligible",
              tasks: ["ANALYZE", "MODERATE"],
            },
          ],
        }),
    );
    const result = await adapter(multiplePages.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect("accounts" in result).toBe(true);
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({
      accessToken: "page-one-token",
      account: {
        avatarUrl: "https://cdn.example/page-1.jpg",
        displayName: "Page One",
        id: "page-1",
        username: "meltiply.page",
      },
      expiresAt: "2026-07-19T01:00:00.000Z",
      refreshToken: '{"pageId":"page-1","userAccessToken":"long"}',
    });
    expect(result.accounts[1]).toMatchObject({
      accessToken: "page-two-token",
      account: {
        displayName: "Page Two",
        id: "page-2",
      },
      expiresAt: "2026-07-19T01:00:00.000Z",
      refreshToken: '{"pageId":"page-2","userAccessToken":"long"}',
    });
    expect(result.accounts[1]!.account.username).toBeUndefined();
  });

  // Shared Pages are returned by several edges with edge-specific tokens, so the
  // retained token proves which discovery record survived deduplication.
  it("includes business-assigned Pages across pagination and deduplicates shared Pages", async () => {
    const page = (id: string, accessToken = `page-token-${id}`) => ({
      id,
      name: `Page ${id}`,
      access_token: accessToken,
      tasks: ["CREATE_CONTENT"],
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/oauth/access_token")) {
        const form = new URLSearchParams(String(init.body));
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
      if (url.pathname.endsWith("/me/accounts")) return json({ data: [page("direct")] });
      if (url.pathname.endsWith("/me/business_users")) {
        return url.searchParams.has("after")
          ? json({ data: [{ id: "business-user-2" }] })
          : json({
              data: [{ id: "business-user-1" }],
              paging: {
                cursors: { after: "next" },
                next: "https://graph.facebook.com/v25.0/me/business_users?after=next",
              },
            });
      }
      if (url.pathname.endsWith("/business-user-1/assigned_pages")) {
        return url.searchParams.has("after")
          ? json({ data: [page("business-2")] })
          : json({
              // `direct` is also reachable through /me/accounts; its edge token
              // must not replace the record discovered first.
              data: [page("direct", "page-token-direct-via-business"), page("business-1")],
              paging: {
                cursors: { after: "next" },
                next: "https://graph.facebook.com/v25.0/business-user-1/assigned_pages?after=next",
              },
            });
      }
      if (url.pathname.endsWith("/business-user-2/assigned_pages")) {
        return json({
          data: [page("business-2", "page-token-business-2-via-user-2"), page("business-3")],
        });
      }
      throw new Error(`Unexpected discovery endpoint: ${url.pathname}`);
    });
    const result = await adapter(fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts.map((connection) => connection.account.id)).toEqual([
      "direct",
      "business-1",
      "business-2",
      "business-3",
    ]);
    expect(result.accounts.map((connection) => connection.accessToken)).toEqual([
      "page-token-direct",
      "page-token-business-1",
      "page-token-business-2",
      "page-token-business-3",
    ]);
  });

  /** Independent business edges overlap, stay bounded, and retain discovery order despite response order. */
  it("discovers independent business Page edges concurrently without unbounded fan-out", async () => {
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
    const users = Array.from({ length: 8 }, (_, index) => ({ id: `business-${index}` }));
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/oauth/access_token")) {
        return json({
          access_token: new URLSearchParams(String(init.body)).has("fb_exchange_token")
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
      const id = url.pathname.split("/")[2];
      if (!users.some((user) => user.id === id) || !url.pathname.endsWith("/assigned_pages")) {
        throw new Error(`Unexpected discovery endpoint: ${url.pathname}`);
      }
      active++;
      peak = Math.max(peak, active);
      if (active >= 2) started();
      try {
        await held;
        return json({
          data: [
            {
              id: `page-${id}`,
              name: `Page ${id}`,
              access_token: `token-${id}`,
              tasks: ["CREATE_CONTENT"],
            },
          ],
        });
      } finally {
        active--;
      }
    });
    const exchange = adapter(fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    try {
      await Promise.race([overlapping, exchange]);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      release();
    }
    const result = await exchange;
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts.map((connection) => connection.account.id)).toEqual(
      users.map((user) => `page-${user.id}`),
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("traverses Graph API pagination safely using validated cursors and Graph origin", async () => {
    const paginated = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      (url) => {
        expect(url.pathname).toBe("/v25.0/me/accounts");
        expect(url.searchParams.get("after")).toBeNull();
        return json({
          data: [
            {
              access_token: "page-one-token",
              id: "page-1",
              name: "Page One",
              tasks: ["CREATE_CONTENT"],
            },
          ],
          paging: {
            cursors: { after: "cursor-page-2" },
            next: "https://graph.facebook.com/v25.0/me/accounts?after=cursor-page-2",
          },
        });
      },
      (url) => {
        expect(url.pathname).toBe("/v25.0/me/accounts");
        expect(url.searchParams.get("after")).toBe("cursor-page-2");
        return json({
          data: [
            {
              access_token: "page-two-token",
              id: "page-2",
              name: "Page Two",
              tasks: ["CREATE_CONTENT"],
            },
          ],
          paging: {
            cursors: { after: "cursor-page-2-end" },
          },
        });
      },
    );
    const result = await adapter(paginated.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect("accounts" in result).toBe(true);
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((item) => item.account.id)).toEqual(["page-1", "page-2"]);
  });

  it("deduplicates repeated page IDs across pagination without failing", async () => {
    const deduplicating = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      () =>
        json({
          data: [
            {
              access_token: "page-one-token",
              id: "page-1",
              name: "Page One",
              tasks: ["CREATE_CONTENT"],
            },
          ],
          paging: {
            cursors: { after: "cursor-next" },
            next: "https://graph.facebook.com/v25.0/me/accounts?after=cursor-next",
          },
        }),
      () =>
        json({
          data: [
            {
              access_token: "page-one-token-dup",
              id: "page-1",
              name: "Page One Duplicate",
              tasks: ["CREATE_CONTENT"],
            },
            {
              access_token: "page-two-token",
              id: "page-2",
              name: "Page Two",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    );
    const result = await adapter(deduplicating.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect("accounts" in result).toBe(true);
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((item) => item.account.id)).toEqual(["page-1", "page-2"]);
    // The first record for `page-1` wins; a later duplicate must not replace the
    // retained token or display name.
    expect(result.accounts.map((item) => item.accessToken)).toEqual([
      "page-one-token",
      "page-two-token",
    ]);
    expect(result.accounts[0]!.account.displayName).toBe("Page One");
  });

  it("returns empty accounts list when no Pages are eligible for content creation", async () => {
    const emptyPages = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      () => json({ data: [] }),
    );
    const result = await adapter(emptyPages.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect(result).toEqual({ accounts: [] });
  });

  it("rejects pagination targeting untrusted origins or malformed cursors", async () => {
    const untrustedOrigin = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      () =>
        json({
          data: [
            {
              access_token: "page-token",
              id: "page-1",
              name: "Page 1",
              tasks: ["CREATE_CONTENT"],
            },
          ],
          paging: {
            next: "https://evil.example.com/v25.0/me/accounts?after=cursor",
          },
        }),
    );
    await expect(
      adapter(untrustedOrigin.fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "facebook_oauth_page_pagination_invalid",
      },
    });

    const malformedCursor = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
      () =>
        json({
          data: [],
          paging: {
            cursors: { after: "\u0000bad-cursor" },
            next: "https://graph.facebook.com/v25.0/me/accounts?after=valid",
          },
        }),
    );
    await expect(
      adapter(malformedCursor.fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "facebook_oauth_page_pagination_invalid",
      },
    });
  });

  /**
   * Empty Graph pages still advance cursors, so the item count alone cannot bound discovery.
   * An excessive empty chain must fail before a later Page can disguise the unbounded traversal.
   */
  it("bounds pagination without discovered Pages", async () => {
    // Exactly 1,000 empty pages is still inside the request ceiling: the chain
    // ends with a terminal page that omits paging, so traversal stops normally.
    // Without this control a stricter bound (e.g. 999) would pass the test below.
    const atLimitPages = Array.from(
      { length: 1_000 },
      (_, index) => () =>
        json({
          data: [],
          ...(index === 999
            ? {}
            : {
                paging: {
                  cursors: { after: `at-limit-${index}` },
                  next: `https://graph.facebook.com/v25.0/me/accounts?after=at-limit-${index}`,
                },
              }),
        }),
    );
    const atLimit = sequence(
      () => json({ access_token: "short" }),
      () => json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
      defaultGrantedPermissions,
      ...atLimitPages,
    );
    await expect(
      adapter(atLimit.fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).resolves.toEqual({ accounts: [] });

    const responders: Responder[] = [
      () => json({ access_token: "short" }),
      () => json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
      defaultGrantedPermissions,
      ...Array.from(
        { length: 1_001 },
        (_, index) => () =>
          json({
            data: [],
            paging: {
              cursors: { after: `empty-${index}` },
              next: `https://graph.facebook.com/v25.0/me/accounts?after=empty-${index}`,
            },
          }),
      ),
      () =>
        json({
          data: [
            {
              id: "eventual-page",
              name: "Too late",
              access_token: "page-token",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    ];
    await expect(
      adapter(sequence(...responders).fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: { code: "facebook_oauth_page_pagination_invalid" },
    });
  });

  it("fails closed when discovered pages exceed 1,000 bounds", async () => {
    const generatePages = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, idx) => ({
        access_token: `token-${prefix}-${idx}`,
        id: `page-${prefix}-${idx}`,
        name: `Page ${prefix} ${idx}`,
        tasks: ["CREATE_CONTENT"],
      }));

    // Exactly 1,000 discovered Pages is still inside the documented ceiling and
    // must be accepted; only the 1,001st record fails closed below.
    const atLimitResponders = [
      () => json({ access_token: "short" }),
      () => json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
      defaultGrantedPermissions,
    ];
    for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
      atLimitResponders.push(() =>
        json({
          data: generatePages(100, `at-limit-${pageIdx}`),
          ...(pageIdx === 9
            ? {}
            : {
                paging: {
                  cursors: { after: `at-limit-cursor-${pageIdx}` },
                  next: `https://graph.facebook.com/v25.0/me/accounts?after=at-limit-cursor-${pageIdx}`,
                },
              }),
        }),
      );
    }
    const atLimitProvider = adapter(sequence(...atLimitResponders).fetcher);
    const atLimit = await atLimitProvider.exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    if (!("accounts" in atLimit)) throw new Error("Expected account selection");
    expect(atLimit.accounts).toHaveLength(1_000);

    const responders = [
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      defaultGrantedPermissions,
    ];
    // 10 pages of 100 items = 1,000 items, then 11th page has 1 item (1,001 items)
    for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
      responders.push(() =>
        json({
          data: generatePages(100, `p${pageIdx}`),
          paging: {
            cursors: { after: `cursor-${pageIdx}` },
            next: `https://graph.facebook.com/v25.0/me/accounts?after=cursor-${pageIdx}`,
          },
        }),
      );
    }
    responders.push(() =>
      json({
        data: generatePages(1, "overflow"),
      }),
    );

    const calls = sequence(...responders);
    await expect(
      adapter(calls.fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "facebook_oauth_page_list_invalid",
      },
    });
  });

  it("declined publishing permission returns empty accounts and cannot appear as authorized publishing candidate", async () => {
    const declinedPermission = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      (url) => {
        expect(url.pathname).toBe("/v25.0/me/permissions");
        return json({
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "declined" },
          ],
        });
      },
      () =>
        json({
          data: [
            {
              access_token: "page-token",
              id: "page-1",
              name: "Page One",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    );

    const result = await adapter(declinedPermission.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    expect(result).toEqual({ accounts: [] });
  });

  it("attaches actual granted scopes list to candidate connections", async () => {
    const customPermissions = sequence(
      () => json({ access_token: "short" }),
      () =>
        json({
          access_token: "long",
          expires_in: 3_600,
          token_type: "bearer",
        }),
      () =>
        json({
          data: [
            { permission: "public_profile", status: "granted" },
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },

            { permission: "pages_manage_engagement", status: "granted" },

            { permission: "read_insights", status: "granted" },
            { permission: "email", status: "declined" },
          ],
        }),
      () =>
        json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    );

    const result = await adapter(customPermissions.fetcher).exchangeAuthorizationCode!(context, {
      code: "code",
      codeVerifier: "unused",
      redirectUri,
    });
    if (!("accounts" in result)) throw new Error("Expected account selection");
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.scopes).toEqual([
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "read_insights",
    ]);
  });

  it("creates, uploads, and submits one hosted Page Reel", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/page-1/video_reels");
        expect(url.searchParams.get("upload_phase")).toBe("start");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer page-access-secret");
        return json({
          upload_url: "https://rupload.facebook.com/video-upload/v25.0/video-1",
          video_id: "video-1",
        });
      },
      (url, init) => {
        expect(url.origin).toBe("https://rupload.facebook.com");
        const headers = new Headers(init.headers);
        expect(headers.get("Authorization")).toBe("OAuth page-access-secret");
        expect(headers.get("file_url")).toBe("https://assets.example/reel.mp4?signature=secret");
        expect(init.body).toBeUndefined();
        return json({ success: true });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/page-1/video_reels");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          description: "A Page Reel #launch",
          upload_phase: "finish",
          video_id: "video-1",
          video_state: "PUBLISHED",
        });
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer page-access-secret");
        return json({ success: true });
      },
    );

    await expect(
      adapter(providerCalls.fetcher).publish!(context, credentials, publishInput()),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "finishing:video-1",
    });
    expect(providerCalls.calls.every(({ init }) => init.redirect === "manual")).toBe(true);
  });

  it("rejects unsupported and unsafe media before contacting Facebook", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = adapter(fetcher);
    const invalidInputs: PublishInput[] = [
      publishInput({ caption: "", media: [] }),
      publishInput({ caption: "x".repeat(2_201) }),
      publishInput({
        media: [
          {
            body: new ReadableStream<Uint8Array>(),
            contentType: "video/mp4",
            fileSize: 1_024,
            mode: "byte_upload",
          },
        ],
      }),
      publishInput({
        media: [
          {
            contentType: "video/webm",
            fileSize: 1_024,
            mode: "remote_ingest",
            url: "https://assets.example/reel.webm",
          },
        ],
      }),
      // Facebook publishes one video as one Reel, so a post carrying several
      // attachments is rejected instead of publishing only the first.
      publishInput({
        media: [
          {
            contentType: "video/mp4",
            fileSize: 1_024,
            mode: "remote_ingest",
            url: "https://assets.example/one.mp4",
          },
          {
            contentType: "video/mp4",
            fileSize: 1_024,
            mode: "remote_ingest",
            url: "https://assets.example/two.mp4",
          },
        ],
      }),
    ];
    for (const input of invalidInputs) {
      await expect(provider.publish!(context, credentials, input)).rejects.toBeInstanceOf(
        ProviderAdapterError,
      );
    }
    await expect(
      provider.publish!(context, { accessToken: "token" }, publishInput()),
    ).rejects.toMatchObject({
      failure: { code: "facebook_page_account_required" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["complete", "completed"])(
    "recognizes Meta publishing phase %s as published",
    async (publishing) => {
      const providerCalls = sequence(() =>
        json(reelStatus("video-1", { processing: "completed", publishing, video: "ready" })),
      );
      await expect(
        adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
          providerOperationId: "finish_submitted:video-1",
        }),
      ).resolves.toMatchObject({
        state: "published",
        result: { outcome: "confirmed_success", providerPostId: "video-1" },
      });
    },
  );

  it.each(["expired", "upload_failed"])(
    "terminates a Reel whose video status is %s",
    async (video) => {
      const providerCalls = sequence(() => json(reelStatus("video-1", { video })));
      await expect(
        adapter(providerCalls.fetcher).lookupPublication!(context, credentials, {
          providerOperationId: "finishing:video-1",
        }),
      ).resolves.toMatchObject({
        state: "failed",
        result: { outcome: "confirmed_failure", failure: { retryable: false } },
      });
    },
  );

  it("polls a confirmed finish until Facebook proves publication", async () => {
    const providerCalls = sequence(
      () => json(reelStatus("video-1")),
      () =>
        json(
          reelStatus("video-1", {
            processing: "complete",
            publishing: "complete",
            video: "ready",
          }),
        ),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "finishing:video-1",
      }),
    ).resolves.toEqual({
      providerOperationId: "finishing:video-1",
      state: "processing",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "finishing:video-1",
      }),
    ).resolves.toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "finishing:video-1",
        providerPostId: "video-1",
      },
      state: "published",
    });
    expect(providerCalls.calls[0]!.url.searchParams.get("fields")).toBe("id,status");
  });

  it("never re-submits an ambiguous finish and accepts later provider proof", async () => {
    const providerCalls = sequence(
      () =>
        json({
          upload_url: "https://rupload.facebook.com/video-upload/v25.0/video-ambiguous",
          video_id: "video-ambiguous",
        }),
      () => json({ success: true }),
      () => Promise.reject(new Error("connection lost after finish")),
      () =>
        json(
          reelStatus("video-ambiguous", {
            processing: "complete",
            publishing: "complete",
            video: "ready",
          }),
        ),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.publish!(context, credentials, publishInput())).resolves.toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
      outcome: "unknown",
      providerOperationId: "finish_submitted:video-ambiguous",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "finish_submitted:video-ambiguous",
      }),
    ).resolves.toMatchObject({
      result: { providerPostId: "video-ambiguous" },
      state: "published",
    });
    expect(providerCalls.calls).toHaveLength(4);
    expect(
      providerCalls.calls.filter(({ url }) => url.pathname.endsWith("/video_reels")),
    ).toHaveLength(2);
  });

  it("does not finish after an ambiguous upload without retained caption evidence", async () => {
    const providerCalls = sequence(
      () =>
        json({
          upload_url: "https://rupload.facebook.com/video-upload/v25.0/video-upload",
          video_id: "video-upload",
        }),
      () => Promise.reject(new Error("upload response lost")),
      () => json(reelStatus("video-upload")),
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(provider.publish!(context, credentials, publishInput())).resolves.toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "unknown",
      providerOperationId: "upload_submitted:video-upload",
    });
    await expect(
      provider.lookupPublication!(context, credentials, {
        providerOperationId: "upload_submitted:video-upload",
      }),
    ).resolves.toMatchObject({
      result: {
        failure: { code: "facebook_upload_evidence_pending" },
        providerOperationId: "upload_submitted:video-upload",
      },
      state: "unknown",
    });
    expect(providerCalls.calls).toHaveLength(3);
  });

  it("maps processing failures and HTTP 404 without provider detail leakage", async () => {
    // The provider payload carries detail the adapter must never echo: the
    // published result is a canonical failure code, so any raw passthrough of
    // the response body surfaces here.
    const providerDetail = "private provider detail code=abc123";
    // Meta reports Reel processing detail under `status.processing_phase.error.message`,
    // so the fixture uses that documented envelope rather than an invented field.
    const failedCalls = sequence(() =>
      json({
        id: "video-failed",
        status: {
          processing_phase: {
            error: { message: providerDetail },
            status: "error",
          },
          publishing_phase: { status: "not_started" },
          uploading_phase: { status: "complete" },
          video_status: "error",
        },
      }),
    );
    const failed = await adapter(failedCalls.fetcher).lookupPublication!(context, credentials, {
      providerOperationId: "finishing:video-failed",
    });
    expect(failed).toMatchObject({
      result: {
        failure: {
          classification: "deterministic",
          code: "facebook_reel_processing_failed",
        },
      },
      state: "failed",
    });

    const missingCalls = sequence(() =>
      json({ error: { message: "private provider detail" } }, { status: 404 }),
    );
    await expect(
      adapter(missingCalls.fetcher).lookupPublication!(context, credentials, {
        providerPostId: "video-missing",
      }),
    ).resolves.toEqual({ state: "not_found" });
    expect(JSON.stringify(failed)).not.toContain(providerDetail);
  });

  it("refreshes the user token and derives a replacement Page token", async () => {
    const providerCalls = sequence(
      (_url, init) => {
        expect(String(init.body)).toContain("fb_exchange_token=current-user-secret");
        return json({
          access_token: "new-user-secret",
          expires_in: 5_184_000,
          token_type: "bearer",
        });
      },
      (url, init) => {
        expect(url.pathname).toBe("/v25.0/page-1");
        expect(url.searchParams.get("fields")).toBe("id,name,access_token");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer new-user-secret");
        return json({
          access_token: "new-page-secret",
          id: "page-1",
          name: "Meltiply Page",
        });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).refreshAccessToken!(
        context,
        '{"pageId":"page-1","userAccessToken":"current-user-secret"}',
      ),
    ).resolves.toEqual({
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

    await expect(
      adapter(vi.fn<typeof fetch>()).refreshAccessToken!(context, "not-json"),
    ).rejects.toMatchObject({
      failure: { code: "facebook_refresh_secret_invalid" },
    });
  });

  it("keeps a publishing-only grant connectable while analytics scopes stay ungranted", async () => {
    const providerCalls = sequence(
      () => json({ access_token: "short" }),
      () => json({ access_token: "long", expires_in: 3_600, token_type: "bearer" }),
      () =>
        json({
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "pages_manage_engagement", status: "granted" },
            { permission: "read_insights", status: "declined" },
          ],
        }),
      () =>
        json({
          data: [
            {
              access_token: "page-access-secret",
              id: "page-1",
              name: "Meltiply Page",
              tasks: ["CREATE_CONTENT"],
            },
          ],
        }),
    );
    await expect(
      adapter(providerCalls.fetcher).exchangeAuthorizationCode!(context, {
        code: "code",
        codeVerifier: "unused",
        redirectUri,
      }),
    ).resolves.toMatchObject({
      accounts: [
        {
          account: { displayName: "Meltiply Page", id: "page-1" },
          scopes: [
            "pages_show_list",
            "pages_read_engagement",
            "pages_manage_posts",
            "pages_manage_engagement",
          ],
        },
      ],
    });
  });

  it("reads Reel plays, likes, comments, and derived shares from the video identity", async () => {
    const providerCalls = sequence(
      (url, init) => {
        expect(url.origin).toBe("https://graph.facebook.com");
        expect(url.pathname).toBe("/v25.0/video-1/video_insights");
        expect(url.searchParams.get("metric")).toBe(
          "blue_reels_play_count,post_video_social_actions",
        );
        expect(url.searchParams.get("period")).toBe("lifetime");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer page-access-secret");
        return json({
          data: [
            {
              name: "blue_reels_play_count",
              period: "lifetime",
              values: [{ value: 1200 }],
            },
            {
              name: "post_video_social_actions",
              period: "lifetime",
              values: [{ value: 21 }],
            },
          ],
        });
      },
      (url) => {
        expect(url.pathname).toBe("/v25.0/video-1");
        expect(url.searchParams.get("fields")).toBe(
          "likes.summary(true).limit(0),comments.summary(true).limit(0)",
        );
        return json({
          likes: { summary: { total_count: 84 } },
          comments: { summary: { total_count: 9 } },
        });
      },
    );
    await expect(
      adapter(providerCalls.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).resolves.toEqual({
      items: [
        {
          comments: 9,
          impressions: 0,
          likes: 84,
          providerPostId: "video-1",
          recordedAt: "2026-07-19T00:00:00.000Z",
          reach: 0,
          shares: 12,
          views: 1200,
          watchTimeSeconds: 0,
        },
      ],
    });
  });

  it("rejects social actions below comments and missing Reel metrics", async () => {
    const inconsistent = sequence(
      () =>
        json({
          data: [
            { name: "blue_reels_play_count", values: [{ value: 1200 }] },
            { name: "post_video_social_actions", values: [{ value: 4 }] },
          ],
        }),
      () =>
        json({
          likes: { summary: { total_count: 84 } },
          comments: { summary: { total_count: 9 } },
        }),
    );
    await expect(
      adapter(inconsistent.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).rejects.toBeInstanceOf(ProviderAdapterError);

    const missingPlays = sequence(
      () => json({ data: [{ name: "post_video_social_actions", values: [{ value: 0 }] }] }),
      () =>
        json({
          likes: { summary: { total_count: 0 } },
          comments: { summary: { total_count: 0 } },
        }),
    );
    await expect(
      adapter(missingPlays.fetcher).listAnalytics!(
        context,
        credentials,
        { providerPostId: "video-1" },
        { limit: 100 },
      ),
    ).rejects.toBeInstanceOf(ProviderAdapterError);
  });
});

describe("createFacebookAdapter Page publishing families", () => {
  const image = {
    contentType: "image/jpeg",
    fileSize: 512 * 1024,
    mode: "remote_ingest",
    url: "https://assets.example/photo.jpg",
  } as const;

  it("publishes a text post through the feed edge", async () => {
    const providerCalls = sequence((url) => {
      expect(url.pathname).toBe("/v25.0/page-1/feed");
      return json({ id: "page-1_101" });
    });
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({ media: [], providerOptions: undefined }),
      ),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "posted:page-1_101",
      providerPostId: "page-1_101",
    });
    const body = new URLSearchParams(providerCalls.calls[0]!.init.body as string);
    expect(body.get("message")).toContain("A Page Reel");
  });

  it("publishes a link post without any attachment", async () => {
    const providerCalls = sequence((url) => {
      expect(url.pathname).toBe("/v25.0/page-1/feed");
      return json({ id: "page-1_102" });
    });
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({
          media: [],
          providerOptions: { facebook: { postType: "post", link: "https://example.com/launch" } },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "confirmed_success", providerPostId: "page-1_102" });
    const body = new URLSearchParams(providerCalls.calls[0]!.init.body as string);
    expect(body.get("link")).toBe("https://example.com/launch");
  });

  it("publishes a single photo and keeps the returned post id", async () => {
    const providerCalls = sequence((url) => {
      expect(url.pathname).toBe("/v25.0/page-1/photos");
      return json({ id: "photo-1", post_id: "page-1_103" });
    });
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(context, credentials, publishInput({ media: [image] })),
    ).resolves.toEqual({
      outcome: "confirmed_success",
      providerOperationId: "posted:page-1_103",
      providerPostId: "page-1_103",
      providerUrl: "https://www.facebook.com/page-1_103",
    });
    const body = new URLSearchParams(providerCalls.calls[0]!.init.body as string);
    expect(body.get("url")).toBe("https://assets.example/photo.jpg");
    expect(body.get("published")).toBe("true");
  });

  it("uploads each photo unpublished then attaches them to one feed post", async () => {
    const providerCalls = sequence(
      (url) => {
        expect(url.pathname).toBe("/v25.0/page-1/photos");
        return json({ id: "photo-a" });
      },
      (url) => {
        expect(url.pathname).toBe("/v25.0/page-1/photos");
        return json({ id: "photo-b" });
      },
      (url) => {
        expect(url.pathname).toBe("/v25.0/page-1/feed");
        return json({ id: "page-1_104" });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    const second = { ...image, url: "https://assets.example/photo-2.jpg" };
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({
          media: [image, second],
          providerOptions: { facebook: { postType: "photo" } },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "confirmed_success", providerPostId: "page-1_104" });
    const firstUpload = new URLSearchParams(providerCalls.calls[0]!.init.body as string);
    expect(firstUpload.get("published")).toBe("false");
    const feed = new URLSearchParams(providerCalls.calls[2]!.init.body as string);
    expect(feed.get("attached_media[0]")).toBe('{"media_fbid":"photo-a"}');
    expect(feed.get("attached_media[1]")).toBe('{"media_fbid":"photo-b"}');
  });

  it("reports an ambiguous feed write as unknown instead of failed", async () => {
    const providerCalls = sequence(() => {
      throw new TypeError("connection reset");
    });
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(context, credentials, publishInput({ media: [] })),
    ).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("publishes a photo Story by referencing the unpublished photo", async () => {
    const providerCalls = sequence(
      () => json({ id: "photo-story-1" }),
      (url) => {
        expect(url.pathname).toBe("/v25.0/page-1/photo_stories");
        expect(url.searchParams.get("photo_id")).toBe("photo-story-1");
        return json({ post_id: "page-1_105", success: true });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({ media: [image], providerOptions: { facebook: { postType: "story" } } }),
      ),
    ).resolves.toMatchObject({ outcome: "confirmed_success", providerPostId: "page-1_105" });
  });

  it("discloses AI generation on a Reel finish", async () => {
    const providerCalls = sequence(
      () =>
        json({
          upload_url: "https://rupload.facebook.com/video-upload/v25.0/video-9",
          video_id: "video-9",
        }),
      () => json({ success: true }),
      (url) => {
        expect(url.searchParams.get("is_ai_generated")).toBe("true");
        return json({ success: true });
      },
    );
    const provider = adapter(providerCalls.fetcher);
    await expect(
      provider.publish!(
        context,
        credentials,
        publishInput({ providerOptions: { facebook: { isAiGenerated: true } } }),
      ),
    ).resolves.toMatchObject({ outcome: "confirmed_success" });
  });
});
