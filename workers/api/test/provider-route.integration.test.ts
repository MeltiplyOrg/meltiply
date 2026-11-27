import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JwtIdentity } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { authenticatedPoolFor, systemPoolFor, withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const alpha = {
  organizationId: "20000000-0000-4000-8000-000000000001",
  organizationRole: "admin",
  subject: "auth_user_local_alpha",
  userId: "10000000-0000-4000-8000-000000000001",
};

const beta = {
  organizationId: "20000000-0000-4000-8000-000000000002",
  organizationRole: "admin",
  subject: "auth_user_local_beta",
  userId: "10000000-0000-4000-8000-000000000002",
};

const brandProfileId = "a0000000-0000-4000-8000-0000000000f4";
const accountId = "94000000-0000-4000-8000-0000000002f4";
const platformUserId = "blackbox-route-tiktok-creator";

function actorFor(claims: typeof alpha): ResolvedActor {
  return {
    authUserId: claims.subject,
    claims,
    displayName: "Route Actor",
    email: `${claims.subject}@meltiply.local`,
    isInstallationOwner: false,
    role: "admin",
    userId: claims.userId,
    workspace: {
      id: claims.organizationId,
      name: "Route Workspace",
      slug: "route-workspace",
    },
  };
}

let server: Server;
let fakeOrigin = "";
let nextStatus = 200;
let nextBody: unknown = {};
const receivedRequests: Array<{ authorization: string | undefined; method: string; url: string }> =
  [];

function makeEnv(): ApiWorkerEnv {
  return {
    ALLOWED_ORIGINS: "http://localhost:3000",
    APP_URL: "https://api.meltiply.local",
    DB_AUTHENTICATED: { connectionString } as Hyperdrive,
    DB_SYSTEM: {
      connectionString: integrationDatabaseUrl(connectionString, "system"),
    } as Hyperdrive,
    ENVIRONMENT: "test",
    PROVIDER_ORIGIN_TIKTOK_API: fakeOrigin,
    TIKTOK_CLIENT_KEY: "tiktok-route-client",
    TIKTOK_CLIENT_SECRET: "tiktok-route-secret",
    TIKTOK_LIVE_ACCEPTED: "true",
    TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    VERSION: "1.0.0-target.0",
  } satisfies ApiWorkerEnv;
}

function systemTransaction<A, E>(
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(withSystemTransactionEffect(makeEnv(), operation));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    receivedRequests.push({
      authorization: req.headers.authorization,
      method: req.method ?? "",
      url: req.url ?? "",
    });
    res.writeHead(nextStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(nextBody));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  fakeOrigin = `http://127.0.0.1:${address.port}`;

  const encrypted = await tokenCipherFor(makeEnv()).encrypt("blackbox-tiktok-access-token");
  await systemTransaction((client) =>
    Effect.gen(function* () {
      yield* client.query("DELETE FROM platform_accounts WHERE id = $1", [accountId]);
      yield* client.query("DELETE FROM brand_profiles WHERE id = $1", [brandProfileId]);
      yield* client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Blackbox Route Brand', '#1d4ed8')`,
        [brandProfileId, alpha.organizationId],
      );
      yield* client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, username,
            display_name, access_token, token_expires_at, scopes, connection_status)
         VALUES ($1, $2, $3, 'tiktok', $4, 'route.creator', 'Route Creator',
                 $5, now() + INTERVAL '1 hour', ARRAY['video.publish'], 'connected')`,
        [accountId, alpha.organizationId, brandProfileId, platformUserId, encrypted],
      );
    }),
  );
});

beforeEach(() => {
  receivedRequests.length = 0;
  nextStatus = 200;
  nextBody = {
    data: {
      comment_disabled: false,
      creator_avatar_url: "https://cdn.example.com/avatar.png",
      creator_nickname: "Blackbox Creator",
      creator_username: "blackbox.creator",
      duet_disabled: true,
      max_video_post_duration_sec: 180,
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      stitch_disabled: false,
    },
    error: { code: "ok", log_id: "log-1", message: "" },
  };
});

afterAll(async () => {
  await systemTransaction((client) =>
    Effect.gen(function* () {
      yield* client.query("DELETE FROM platform_accounts WHERE id = $1", [accountId]);
      yield* client.query("DELETE FROM brand_profiles WHERE id = $1", [brandProfileId]);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await authenticatedPoolFor(makeEnv()).end();
  await systemPoolFor(makeEnv()).end();
});

function appFor(claims: typeof alpha) {
  return createApiApp({
    resolveActor: async () => actorFor(claims),
    verifyJwtToken: async (): Promise<JwtIdentity> => ({
      email: `${claims.subject}@meltiply.local`,
      name: "Route Actor",
      subject: claims.subject,
    }),
  });
}

describe("publishing requirements HTTP route with local provider server", () => {
  it("decrypts the stored token, queries the configured TikTok origin, and returns normalized requirements", async () => {
    const response = await appFor(alpha).request(
      `/api/v1/platforms/${accountId}/publishing-requirements`,
      {
        headers: {
          Authorization: "Bearer test-token",
          "X-Request-ID": "req-blackbox-ok",
        },
      },
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      comment_allowed: true,
      creator: {
        avatar_url: "https://cdn.example.com/avatar.png",
        display_name: "Blackbox Creator",
        username: "blackbox.creator",
      },
      duet_allowed: false,
      max_video_duration_sec: 180,
      platform: "tiktok",
      privacy_levels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      stitch_allowed: true,
    });
    expect(receivedRequests).toEqual([
      {
        authorization: "Bearer blackbox-tiktok-access-token",
        method: "POST",
        url: "/v2/post/publish/creator_info/query/",
      },
    ]);
  });

  it("maps an upstream provider outage without leaking credentials or origin URLs", async () => {
    nextStatus = 503;
    nextBody = { error: { code: "internal_error", message: "provider down" } };

    const response = await appFor(alpha).request(
      `/api/v1/platforms/${accountId}/publishing-requirements`,
      {
        headers: {
          Authorization: "Bearer test-token",
          "X-Request-ID": "req-blackbox-outage",
        },
      },
      makeEnv(),
    );

    expect(response.status).toBe(502);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("blackbox-tiktok-access-token");
    expect(bodyText).not.toContain(fakeOrigin);
    expect(receivedRequests).toHaveLength(1);
  });

  it("returns 404 for another tenant without touching the upstream provider", async () => {
    const response = await appFor(beta).request(
      `/api/v1/platforms/${accountId}/publishing-requirements`,
      {
        headers: {
          Authorization: "Bearer test-token",
          "X-Request-ID": "req-blackbox-cross-tenant",
        },
      },
      makeEnv(),
    );

    expect(response.status).toBe(404);
    expect(receivedRequests).toEqual([]);
  });
});
