// Run against the disposable seeded full-gate database with the state Worker built. Real API,
// SQLite Durable Object state, encryption and PostgreSQL persistence; only actor
// authentication and external provider HTTP responses are controlled here.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { z } from "zod";
import { PLATFORM_IDS, type Platform } from "../../packages/domain/src/index";
import { createProviderRegistryFromEnvironment } from "../../packages/providers/src/index";
import { createApiApp } from "../../workers/api/src/app";
import { authenticatedPoolFor, systemPoolFor } from "../../workers/api/src/database";
import type { ApiWorkerEnv } from "../../workers/api/src/env";

const nonce = randomUUID().replaceAll("-", "");
const organizationId = "20000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const subject = "auth_user_local_alpha";
const origin = "https://api.oauth-smoke.example.test";
const expectedIds: Record<Platform, string> = {
  facebook: `page-${nonce}-2`,
  instagram: `ig-${nonce}`,
  threads: `threads-${nonce}`,
  tiktok: `tiktok-${nonce}`,
  youtube: `channel-${nonce}`,
};
const facebookScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const instagramScopes = ["instagram_business_basic", "instagram_business_content_publish"];
const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
let youtubeChallenge = "";
let tokenGeneration = 0;
const requested = new Set<string>();

/** Serves first-party documented wire contracts, rejecting unknown requests instead of falling back to live services. */
const providerFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(input.toString());
  const form = new URLSearchParams(String(init.body ?? ""));
  requested.add(`${url.origin}${url.pathname}`);
  const token = (platform: Platform) => `${platform}-smoke-access-${tokenGeneration}`;
  if (url.origin === "https://api.instagram.com" && url.pathname === "/oauth/access_token") {
    assert.equal(form.get("redirect_uri"), `${origin}/api/v1/platforms/instagram/callback`);
    return Response.json({
      data: [
        {
          access_token: "ig-short",
          user_id: `scoped-${nonce}`,
          permissions: instagramScopes.join(","),
        },
      ],
    });
  }
  if (url.origin === "https://graph.instagram.com") {
    if (url.pathname === "/access_token") {
      assert.equal(url.searchParams.get("access_token"), "ig-short");
      return Response.json({
        access_token: token("instagram"),
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    }
    if (url.pathname === "/v25.0/me") {
      assert.ok(url.searchParams.get("fields")?.split(",").includes("user_id"));
      return Response.json({
        data: [
          {
            id: `scoped-${nonce}`,
            user_id: expectedIds.instagram,
            username: "ig_creator",
            account_type: "Media_Creator",
          },
        ],
      });
    }
  }
  if (url.origin === "https://graph.threads.com") {
    if (url.pathname === "/oauth/access_token")
      return Response.json({ access_token: "threads-short", user_id: expectedIds.threads });
    if (url.pathname === "/access_token") {
      assert.equal(url.searchParams.get("access_token"), "threads-short");
      assert.equal(url.searchParams.get("grant_type"), "th_exchange_token");
      return Response.json({
        access_token: token("threads"),
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    }
    if (url.pathname === "/me")
      return Response.json({ id: expectedIds.threads, username: "threads_creator" });
  }
  if (url.origin === "https://open.tiktokapis.com") {
    if (url.pathname === "/v2/oauth/token/")
      return Response.json({
        access_token: token("tiktok"),
        refresh_token: "tiktok-smoke-refresh",
        open_id: expectedIds.tiktok,
        token_type: "Bearer",
        scope: "user.info.basic,video.publish",
        expires_in: 86_400,
        refresh_expires_in: 31_536_000,
      });
    if (url.pathname === "/v2/user/info/")
      return Response.json({
        data: { user: { open_id: expectedIds.tiktok, display_name: "TikTok Creator" } },
        error: { code: "ok", message: "" },
      });
  }
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    assert.equal(
      createHash("sha256")
        .update(z.string().min(43).parse(form.get("code_verifier")))
        .digest("base64url"),
      youtubeChallenge,
    );
    return Response.json({
      access_token: token("youtube"),
      refresh_token: "youtube-smoke-refresh",
      token_type: "Bearer",
      scope: youtubeScopes.join(" "),
      expires_in: 3_600,
    });
  }
  if (url.origin === "https://www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
    assert.equal(url.searchParams.get("mine"), "true");
    return Response.json({
      items: [
        {
          id: expectedIds.youtube,
          snippet: { title: "YouTube Creator", customUrl: "@youtube_creator" },
        },
      ],
    });
  }
  if (url.origin === "https://graph.facebook.com") {
    if (url.pathname === "/v25.0/oauth/access_token")
      return Response.json({
        access_token: init.method === "POST" ? "facebook-short" : token("facebook"),
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    if (url.pathname === "/v25.0/me/permissions")
      return Response.json({
        data: facebookScopes.map((permission) => ({ permission, status: "granted" })),
      });
    if (url.pathname === "/v25.0/me/accounts")
      return Response.json({
        data: [1, 2].map((index) => ({
          id: `page-${nonce}-${index}`,
          name: `Page ${index}`,
          access_token: `facebook-page-${index}-${tokenGeneration}`,
          tasks: ["CREATE_CONTENT"],
        })),
      });
  }
  throw new Error(`Unexpected controlled provider request: ${url.origin}${url.pathname}`);
};

const runtime = new Miniflare(
  convertV4MiniflareOptions({
    port: 0,
    cf: {},
    telemetry: { enabled: false },
    workers: [
      {
        name: "oauth-state-smoke",
        modules: true,
        compatibilityDate: "2026-07-18",
        compatibilityFlags: ["nodejs_compat"],
        scriptPath: "workers/state/dist/index.js",
        durableObjects: { OAUTH_STATE: { className: "OAuthStateCoordinator", useSQLite: true } },
        hyperdrives: {
          DB_AUTHENTICATED:
            "postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply?sslmode=disable",
          DB_SYSTEM:
            "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
        },
      },
    ],
  }),
);
await runtime.ready;
const bindings =
  await runtime.getBindings<
    Required<Pick<ApiWorkerEnv, "OAUTH_STATE" | "DB_AUTHENTICATED" | "DB_SYSTEM">>
  >();
const env = {
  ...bindings,
  ENVIRONMENT: "test",
  VERSION: "oauth-connection-smoke",
  ALLOWED_ORIGINS: "http://localhost:3000",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: origin,
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  FACEBOOK_CLIENT_ID: "facebook-client",
  FACEBOOK_CLIENT_SECRET: "facebook-smoke-secret",
  FACEBOOK_LIVE_ACCEPTED: "true",
  INSTAGRAM_CLIENT_ID: "instagram-client",
  INSTAGRAM_CLIENT_SECRET: "instagram-smoke-secret",
  INSTAGRAM_LIVE_ACCEPTED: "true",
  THREADS_CLIENT_ID: "threads-client",
  THREADS_CLIENT_SECRET: "threads-smoke-secret",
  THREADS_LIVE_ACCEPTED: "true",
  TIKTOK_CLIENT_KEY: "tiktok-client",
  TIKTOK_CLIENT_SECRET: "tiktok-smoke-secret",
  TIKTOK_LIVE_ACCEPTED: "true",
  TIKTOK_MEDIA_URL_PREFIX: `${origin}/api/v1/provider-media/`,
  YOUTUBE_SHORTS_CLIENT_ID: "youtube-client",
  YOUTUBE_SHORTS_CLIENT_SECRET: "youtube-smoke-secret",
  YOUTUBE_LIVE_ACCEPTED: "true",
} satisfies ApiWorkerEnv;
const registry = createProviderRegistryFromEnvironment(env, { fetch: providerFetch });
const app = createApiApp({
  providerRegistry: registry,
  resolveActor: async () => ({
    authUserId: subject,
    claims: { organizationId, organizationRole: "admin", subject, userId },
    role: "admin",
    userId,
    workspace: { id: organizationId, isPersonal: false, name: "Alpha", slug: "alpha" },
  }),
  verifyJwtToken: async () => ({ email: "alpha@meltiply.local", name: "Alpha Creator", subject }),
});
const profiles: string[] = [];

/** Issues real API requests; schema decoding and assertions below fail closed on unexpected responses. */
async function request(path: string, method = "GET", body?: unknown, key = randomUUID()) {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: "Bearer oauth-smoke.jwt",
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

/** Completes the actual OAuth state round trip; authorization is not allowed to persist a Channel before explicit assignment. */
async function authorize(platform: Platform) {
  const start = await request(`/api/v1/platforms/${platform}/connect`);
  assert.equal(start.status, 200);
  const authorization = new URL(
    z.object({ authorization_url: z.url() }).parse(await start.json()).authorization_url,
  );
  if (platform === "threads") assert.equal(authorization.origin, "https://threads.com");
  if (platform === "instagram")
    assert.equal(authorization.searchParams.get("force_reauth"), "true");
  if (platform === "youtube")
    youtubeChallenge = z.string().parse(authorization.searchParams.get("code_challenge"));
  const callback = `/api/v1/platforms/${platform}/callback?${new URLSearchParams({ state: z.string().parse(authorization.searchParams.get("state")), code: "controlled-code" })}`;
  const result = await request(callback);
  assert.equal(result.status, 302);
  const location = new URL(z.string().parse(result.headers.get("Location")));
  assert.equal(location.pathname, "/channels/connect");
  assert.equal(location.searchParams.get("oauth"), "select_account");
  assert.equal(location.searchParams.get("provider"), platform);
  const selectionId = z.string().parse(location.searchParams.get("selection_id"));
  const replay = await request(callback);
  assert.equal(
    new URL(z.string().parse(replay.headers.get("Location"))).searchParams.get("oauth"),
    "state_invalid",
  );
  return selectionId;
}

try {
  const profileResponse = await request("/api/v1/brand-profiles", "POST", {
    name: `OAuth smoke ${nonce}`,
    color: "#1d4ed8",
  });
  assert.equal(profileResponse.status, 201);
  const profileId = z.object({ id: z.uuid() }).parse(await profileResponse.json()).id;
  profiles.push(profileId);
  const persistedIds: string[] = [];
  const accountListSchema = z.object({
    accounts: z.array(
      z.object({
        brand_profile_id: z.string(),
        platform: z.string(),
        platform_user_id: z.string(),
        connection_status: z.string(),
      }),
    ),
  });
  for (const platform of PLATFORM_IDS) {
    const selectionId = await authorize(platform);
    const selectionResponse = await request(`/api/v1/oauth-selections/${selectionId}`);
    assert.equal(selectionResponse.status, 200);
    const metadataText = await selectionResponse.text();
    assert.ok(
      !metadataText.includes("smoke-access") &&
        !metadataText.includes("refresh") &&
        !metadataText.includes("access_token"),
    );
    const selection = z
      .object({ platform: z.string(), accounts: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(metadataText));
    assert.equal(selection.platform, platform);
    assert.deepEqual(
      selection.accounts.map(({ id }) => id),
      platform === "facebook" ? [`page-${nonce}-1`, expectedIds.facebook] : [expectedIds[platform]],
    );
    const before = await request("/api/v1/platforms");
    assert.deepEqual(
      accountListSchema
        .parse(await before.json())
        .accounts.filter((account) => account.brand_profile_id === profileId)
        .map((account) => account.platform_user_id)
        .sort(),
      [...persistedIds].sort(),
    );
    const key = randomUUID();
    const body = { account_id: expectedIds[platform], brand_profile_id: profileId };
    const confirmation = await request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      "POST",
      body,
      key,
    );
    assert.equal(confirmation.status, 204);
    const replay = await request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      "POST",
      body,
      key,
    );
    assert.equal(replay.status, 204);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    tokenGeneration++;
    const reconnectId = await authorize(platform);
    const reconnect = await request(
      `/api/v1/oauth-selections/${reconnectId}/confirm`,
      "POST",
      body,
    );
    assert.equal(reconnect.status, 204);
    const listed = await request("/api/v1/platforms");
    const accounts = accountListSchema.parse(await listed.json()).accounts;
    persistedIds.push(expectedIds[platform]);
    const connected = accounts.filter(
      (account) => account.brand_profile_id === profileId && account.platform === platform,
    );
    assert.deepEqual(
      connected.map((account) => account.platform_user_id),
      [expectedIds[platform]],
    );
    // TikTok and YouTube's fresh grants are already within the API's seven-day
    // expiry-warning window; both statuses remain usable for publishing.
    assert.ok(
      connected.every(
        (account) =>
          account.connection_status === "connected" || account.connection_status === "expiring",
      ),
    );
    const pending = await authorize(platform);
    assert.equal((await request(`/api/v1/oauth-selections/${pending}`, "DELETE")).status, 204);
    assert.equal(
      (await request(`/api/v1/oauth-selections/${pending}/confirm`, "POST", body)).status,
      404,
    );
    console.log(
      `${platform}: OAuth/PKCE, selection metadata, explicit assignment, replay, reconnect and cancellation passed`,
    );
  }
  assert.ok(requested.has("https://graph.threads.com/oauth/access_token"));
  console.log(
    "All five provider connection lifecycles passed with real SQLite state and PostgreSQL persistence; provider responses were controlled, not live OAuth.",
  );
} finally {
  const pool = systemPoolFor(env);
  try {
    for (const id of profiles)
      await pool.query("DELETE FROM brand_profiles WHERE id = $1 AND org_id = $2", [
        id,
        organizationId,
      ]);
  } finally {
    await authenticatedPoolFor(env).end();
    await pool.end();
    await runtime.dispose();
  }
}
