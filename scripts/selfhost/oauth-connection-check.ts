// Run against the disposable seeded full-gate database with the state Worker built. Real API,
// SQLite Durable Object state, encryption and PostgreSQL persistence; only actor
// authentication and external provider HTTP responses are controlled here.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { z } from "zod";
import { Effect } from "effect";
import { PLATFORM_IDS, type Platform } from "../../packages/domain/src/index";
import {
  createProviderRegistryFromEnvironment,
  ProviderAdapterError,
  type PublishInput,
} from "../../packages/providers/src/index";
import { createApiApp } from "../../workers/api/src/app";
import { authenticatedPoolFor, systemPoolFor } from "../../workers/api/src/database";
import type { ApiWorkerEnv } from "../../workers/api/src/env";
import { processProviderSyncMessage } from "../../workers/automation/src/provider-sync";
import { createQueuePublisherLive } from "../../workers/automation/src/effect/services";
import { systemPoolFor as automationPoolFor } from "../../workers/automation/src/database";
import { tokenCipherFor } from "../../workers/api/src/token-credentials";

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
const refreshRequests = { tiktok: 0, youtube: 0 };
const requested = new Set<string>();
let providerCallCount = 0;

/** Serves first-party documented wire contracts, rejecting unknown requests instead of falling back to live services. */
const providerFetch: typeof fetch = async (input, init = {}) => {
  providerCallCount++;
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
          permissions: instagramScopes,
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
            id: `profile-scoped-${nonce}`,
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
    if (url.pathname === "/v2/oauth/token/") {
      const refreshing = form.get("grant_type") === "refresh_token";
      assert.equal(init.method, "POST");
      assert.equal(form.get("client_key"), "tiktok-client");
      if (refreshing) {
        assert.equal(form.get("refresh_token"), "tiktok-smoke-refresh");
        refreshRequests.tiktok++;
      } else {
        assert.equal(form.get("redirect_uri"), `${origin}/api/v1/platforms/tiktok/callback`);
        assert.equal(form.has("code_verifier"), false);
      }
      return Response.json({
        access_token: refreshing ? `tiktok-refreshed-${tokenGeneration}` : token("tiktok"),
        refresh_token: refreshing ? "tiktok-rotated-refresh" : "tiktok-smoke-refresh",
        open_id: expectedIds.tiktok,
        token_type: "Bearer",
        scope: "user.info.basic,video.publish",
        expires_in: 86_400,
        refresh_expires_in: 31_536_000,
      });
    }
    if (url.pathname === "/v2/user/info/")
      return Response.json({
        data: { user: { open_id: expectedIds.tiktok, display_name: "TikTok Creator" } },
        error: { code: "ok", message: "" },
      });
  }
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    const refreshing = form.get("grant_type") === "refresh_token";
    if (refreshing) {
      assert.equal(form.get("refresh_token"), "youtube-smoke-refresh");
      assert.equal(form.has("code_verifier"), false);
      refreshRequests.youtube++;
    } else {
      assert.equal(
        createHash("sha256")
          .update(z.string().min(43).parse(form.get("code_verifier")))
          .digest("base64url"),
        youtubeChallenge,
      );
      assert.equal(form.get("redirect_uri"), `${origin}/api/v1/platforms/youtube/callback`);
    }
    return Response.json({
      access_token: refreshing ? `youtube-refreshed-${tokenGeneration}` : token("youtube"),
      ...(!refreshing ? { refresh_token: "youtube-smoke-refresh" } : {}),
      token_type: "Bearer",
      scope: [...youtubeScopes, "openid", "email", "profile"].join(" "),
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
  APP_URL: origin,
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
    displayName: "Alpha Creator",
    email: "alpha@meltiply.local",
    isInstallationOwner: true,
    role: "admin",
    userId,
    workspace: { id: organizationId, name: "Alpha", slug: "alpha" },
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
        Origin: origin,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

/** Starts real authorization with account choice and validates provider-specific redirect/PKCE settings. */
async function startAuthorization(platform: Platform) {
  const start = await request(`/api/v1/platforms/${platform}/connect`);
  assert.equal(start.status, 200);
  const authorization = new URL(
    z.object({ authorization_url: z.url() }).parse(await start.json()).authorization_url,
  );
  if (platform === "threads") assert.equal(authorization.origin, "https://threads.com");
  if (platform === "instagram")
    assert.equal(authorization.searchParams.get("force_reauth"), "true");
  if (platform === "tiktok") assert.equal(authorization.searchParams.get("disable_auto_auth"), "1");
  if (platform === "youtube") {
    assert.equal(authorization.searchParams.get("prompt"), "consent select_account");
    youtubeChallenge = z.string().parse(authorization.searchParams.get("code_challenge"));
  }
  return authorization;
}

/** Completes the actual OAuth state round trip; authorization cannot persist a Channel before explicit assignment. */
async function authorize(platform: Platform) {
  const authorization = await startAuthorization(platform);
  const callback = `/api/v1/platforms/${platform}/callback?${new URLSearchParams({ state: z.string().parse(authorization.searchParams.get("state")), code: "controlled-code" })}`;
  const result = await request(callback);
  assert.equal(result.status, 302);
  const location = new URL(z.string().parse(result.headers.get("Location")));
  assert.equal(location.origin, origin);
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

/**
 * Exercises the real automation refresh consumer against encrypted persisted
 * credentials, including TikTok rotation, Google's omitted replacement, and
 * stale queue replay. Only external HTTP is controlled; no token-persistence
 * implementation or encryption boundary is mocked.
 */
async function refreshConnectedAccount(platform: "tiktok" | "youtube", id: string) {
  const pool = systemPoolFor(env);
  const eventId = randomUUID();
  await pool.query(
    `UPDATE platform_accounts SET token_expires_at = now() - interval '1 minute',
       token_refresh_event_id = $2::uuid WHERE id = $1 AND org_id = $3`,
    [id, eventId, organizationId],
  );
  const message = {
    event_id: eventId,
    request_id: randomUUID(),
    target_id: id,
    type: "provider.sync" as const,
    version: 1 as const,
    workload: "token_refresh" as const,
  };
  const process = () =>
    Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(env, message, { providerRegistry: registry }),
        createQueuePublisherLive(),
      ),
    );
  assert.equal(await process(), "processed");
  const row = z
    .object({
      access_token: z.string(),
      refresh_token: z.string(),
      connection_status: z.literal("connected"),
      expires_in_future: z.literal(true),
    })
    .parse(
      (
        await pool.query(
          `SELECT access_token, refresh_token, connection_status,
             token_expires_at > now() AS expires_in_future
           FROM platform_accounts WHERE id = $1 AND org_id = $2`,
          [id, organizationId],
        )
      ).rows[0],
    );
  const cipher = tokenCipherFor(env);
  assert.equal(await cipher.decrypt(row.access_token), `${platform}-refreshed-${tokenGeneration}`);
  assert.equal(
    await cipher.decrypt(row.refresh_token),
    platform === "tiktok" ? "tiktok-rotated-refresh" : "youtube-smoke-refresh",
  );
  assert.equal(refreshRequests[platform], 1);
  assert.equal(await process(), "skipped");
  assert.equal(refreshRequests[platform], 1);
  console.log(`${platform}: encrypted refresh persistence and stale queue replay passed`);
}

/** Checks consent denial and forged-state callbacks never exchange tokens or stage accounts. */
async function rejectInvalidAuthorization(platform: "tiktok" | "youtube") {
  const authorization = await startAuthorization(platform);
  const state = z.string().parse(authorization.searchParams.get("state"));
  const callsBefore = providerCallCount;
  const forged = await request(
    `/api/v1/platforms/${platform}/callback?${new URLSearchParams({ state: `${state}forged`, code: "controlled-code" })}`,
  );
  assert.equal(
    new URL(z.string().parse(forged.headers.get("Location"))).searchParams.get("oauth"),
    "state_invalid",
  );
  const denied = await request(
    `/api/v1/platforms/${platform}/callback?${new URLSearchParams({ state, error: "access_denied" })}`,
  );
  assert.equal(
    new URL(z.string().parse(denied.headers.get("Location"))).searchParams.get("oauth"),
    "consent_denied",
  );
  assert.equal(providerCallCount, callsBefore);
}

/**
 * Exercises default/blank and explicit TikTok media prefixes through real Direct Post
 * validation. Only TikTok HTTP is controlled: the accepted media URL must reach init,
 * while the other origin must fail before any additional provider request.
 */
async function verifyTikTokMediaConfiguration() {
  const defaultUrl = "https://api.oauth-smoke.example.test/api/v1/provider-media/smoke/video.mp4";
  const overrideUrl = "https://media.oauth-smoke.example.test/verified/video.mp4";
  for (const [prefix, mediaUrl, rejectedUrl] of [
    ["  ", defaultUrl, overrideUrl],
    [" https://media.oauth-smoke.example.test/verified/ ", overrideUrl, defaultUrl],
  ]) {
    let calls = 0;
    const provider = createProviderRegistryFromEnvironment(
      { ...env, TIKTOK_MEDIA_URL_PREFIX: prefix },
      {
        fetch: async (input, init = {}) => {
          calls++;
          const url = new URL(input.toString());
          assert.equal(url.origin, "https://open.tiktokapis.com");
          if (url.pathname === "/v2/post/publish/creator_info/query/") {
            return Response.json({
              data: {
                comment_disabled: false,
                creator_avatar_url: "https://cdn.example.test/avatar.jpg",
                creator_nickname: "Smoke Creator",
                creator_username: "smoke.creator",
                duet_disabled: false,
                max_video_post_duration_sec: 300,
                privacy_level_options: ["SELF_ONLY"],
                stitch_disabled: false,
              },
              error: { code: "ok" },
            });
          }
          assert.equal(url.pathname, "/v2/post/publish/video/init/");
          assert.equal(
            z
              .object({ source_info: z.object({ video_url: z.string() }) })
              .parse(JSON.parse(String(init.body))).source_info.video_url,
            mediaUrl,
          );
          return Response.json({
            data: { publish_id: "v_pub_url~media-smoke" },
            error: { code: "ok" },
          });
        },
      },
    ).get("tiktok")!;
    const media = {
      contentType: "video/mp4",
      fileSize: 1_024,
      metadata: { durationSeconds: 120, height: 1_920, width: 1_080 },
      mode: "remote_ingest" as const,
      url: z.string().parse(mediaUrl),
    };
    const input: PublishInput = {
      caption: "Media configuration smoke",
      hashtags: [],
      idempotencyKey: randomUUID(),
      media: [media],
      providerOptions: {
        tiktok: {
          allowComment: false,
          allowDuet: false,
          allowStitch: false,
          brandContent: false,
          brandOrganic: false,
          isAiGenerated: false,
          musicUsageConfirmed: true,
          privacyLevel: "SELF_ONLY",
        },
      },
    };
    const context = { operationId: randomUUID(), requestId: randomUUID() };
    const credentials = { accessToken: "media-smoke-access", accountId: expectedIds.tiktok };
    assert.equal(
      (await provider.publish!(context, credentials, input)).outcome,
      "confirmed_success",
    );
    await assert.rejects(
      () =>
        provider.publish!(context, credentials, {
          ...input,
          media: [{ ...media, url: z.string().parse(rejectedUrl) }],
        }),
      (error: unknown) =>
        error instanceof ProviderAdapterError &&
        error.failure.code === "tiktok_media_prefix_invalid",
    );
    assert.equal(calls, 2);
  }
  console.log("TikTok: derived media prefix, explicit override and cross-prefix rejection passed");
}

try {
  await verifyTikTokMediaConfiguration();
  const profileResponse = await request("/api/v1/brand-profiles", "POST", {
    name: `OAuth smoke ${nonce}`,
    color: "#1d4ed8",
  });
  assert.equal(profileResponse.status, 201);
  const profileId = z.object({ id: z.uuid() }).parse(await profileResponse.json()).id;
  profiles.push(profileId);
  const otherProfileResponse = await request("/api/v1/brand-profiles", "POST", {
    name: `OAuth replay ${nonce}`,
    color: "#b91c1c",
  });
  assert.equal(otherProfileResponse.status, 201);
  const otherProfileId = z.object({ id: z.uuid() }).parse(await otherProfileResponse.json()).id;
  profiles.push(otherProfileId);
  const persistedIds: string[] = [];
  const accountListSchema = z.object({
    accounts: z.array(
      z.object({
        id: z.uuid(),
        brand_profile_id: z.string(),
        platform: z.string(),
        platform_user_id: z.string(),
        connection_status: z.string(),
      }),
    ),
  });
  for (const platform of PLATFORM_IDS) {
    if (platform === "tiktok" || platform === "youtube") {
      await rejectInvalidAuthorization(platform);
    }
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
    const changedProfileReplay = await request(
      `/api/v1/oauth-selections/${selectionId}/confirm`,
      "POST",
      { ...body, brand_profile_id: otherProfileId },
      key,
    );
    assert.equal(changedProfileReplay.status, 409);
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
    if (platform === "tiktok" || platform === "youtube") {
      await refreshConnectedAccount(platform, z.string().parse(connected[0]?.id));
    }
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
    await automationPoolFor(env).end();
    await runtime.dispose();
  }
}
