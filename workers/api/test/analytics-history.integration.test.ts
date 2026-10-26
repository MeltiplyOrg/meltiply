import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createApiApp } from "../src/app";
import { systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

const workspaceId = "20000000-0000-4000-8000-000000000005";
const profileId = randomUUID();
const firstPost = randomUUID();
const unsyncedPost = randomUUID();
const distributionId = randomUUID();
const sessionId = randomUUID();
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwks = JSON.stringify({
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: sessionId, alg: "EdDSA", use: "sig" }],
});
const keyServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(jwks);
});
const issuer = "https://analytics-history.test";
const env: ApiWorkerEnv = {
  ENVIRONMENT: "test",
  ALLOWED_ORIGINS: issuer,
  VERSION: "analytics-history",
  APP_URL: issuer,
  DB_AUTHENTICATED: { connectionString: process.env.MELTIPLY_DATABASE_TEST_URL! } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
};
const app = createApiApp();
let token: string;

beforeAll(async () => {
  if (!env.DB_AUTHENTICATED?.connectionString)
    throw new Error("MELTIPLY_DATABASE_TEST_URL is required");
  await new Promise<void>((resolve) => keyServer.listen(0, "127.0.0.1", resolve));
  const address = keyServer.address();
  if (!address || typeof address === "string") throw new Error("JWKS HTTP server did not listen");
  env.BETTER_AUTH_JWKS_URL = `http://127.0.0.1:${address.port}/jwks`;
  const encoded = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: sessionId })).toString("base64url")}.${Buffer.from(
    JSON.stringify({
      sub: "auth_user_local_alpha",
      sid: sessionId,
      email: "alpha@meltiply.local",
      name: "Alpha Creator",
      iss: issuer,
      aud: issuer,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url")}`;
  token = `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
  const database = systemPoolFor(env);
  await database.query(
    `INSERT INTO "session" (id, "userId", token, "expiresAt") VALUES ($1, 'auth_user_local_alpha', $1, now() + interval '1 hour')`,
    [sessionId],
  );
  await database.query(
    `INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, 'Analytics history HTTP fixture', '#1d4ed8')`,
    [profileId, workspaceId],
  );
  await database.query(
    `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text)
    VALUES ($1, $3, $4, 'Measured history', 'Published'), ($2, $3, $4, 'Not yet synced', 'Pending metrics')`,
    [firstPost, unsyncedPost, workspaceId, profileId],
  );
  await database.query(
    `INSERT INTO distributions (id, org_id, brand_profile_id, post_id, platform, status, published_at, platform_post_id)
    VALUES ($1, $3, $4, $5, 'youtube', 'published', '2026-07-01T00:00:00Z', 'history-first'),
           ($2, $3, $4, $6, 'youtube', 'published', '2026-07-01T00:00:00Z', 'history-unsynced')`,
    [distributionId, randomUUID(), workspaceId, profileId, firstPost, unsyncedPost],
  );
  await database.query(
    `INSERT INTO analytics_snapshots (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
    VALUES ($1, $2, 10, 2, 0, 0, '2026-07-01T00:00:00Z'),
           ($1, $2, 100, 8, 0, 0, '2026-07-01T01:00:00Z'),
           ($1, $2, 50, 4, 0, 0, '2026-07-01T02:00:00Z'),
           ($1, $2, 777, 60, 0, 0, '2026-08-15T00:00:00Z'),
           ($1, $2, 9999, 9999, 0, 0, '2026-10-31T00:00:00Z')`,
    [distributionId, workspaceId],
  );
});
afterAll(async () => {
  await systemPoolFor(env).query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
  await systemPoolFor(env).query('DELETE FROM "session" WHERE id = $1', [sessionId]);
  await systemPoolFor(env).end();
  await new Promise<void>((resolve, reject) => {
    keyServer.close((error) => (error ? reject(error) : resolve()));
    keyServer.closeAllConnections();
  });
});

it("keeps exact as-of ranking, unsynced coverage, counter deltas and bounded historical maxima through authenticated HTTP", async () => {
  const params = new URLSearchParams({
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-10-30T23:59:59.999Z",
    brand_profile_id: profileId,
  });
  const headers = { Authorization: `Bearer ${token}`, "X-Workspace-ID": workspaceId };
  const [dashboardResponse, rankingResponse] = await Promise.all([
    app.request(`/api/v1/analytics/dashboard?${params}`, { headers }, env),
    app.request(
      `/api/v1/analytics/posts?${params}&metric=views&limit=10&offset=0`,
      { headers },
      env,
    ),
  ]);
  expect(dashboardResponse.status).toBe(200);
  expect(rankingResponse.status).toBe(200);
  const dashboard = z
    .object({
      cohort: z.object({ totals: z.object({ views: z.number(), post_count: z.number() }) }),
      series: z.array(z.object({ date: z.string(), views: z.number() })),
      accumulation: z.array(
        z.object({
          elapsed_hours: z.number(),
          avg_engagement: z.number(),
          observations: z.number(),
        }),
      ),
    })
    .parse(await dashboardResponse.json());
  expect(dashboard.cohort.totals).toMatchObject({ views: 777, post_count: 2 });
  expect(dashboard.series.find((point) => point.date === "2026-07-01")?.views).toBe(100);
  expect(dashboard.accumulation.find((point) => point.elapsed_hours === 720)).toMatchObject({
    avg_engagement: 8,
    observations: 1,
  });
  const ranking = z
    .object({
      posts: z.array(
        z.object({ post_id: z.string(), views: z.number(), synced_destination_count: z.number() }),
      ),
    })
    .parse(await rankingResponse.json());
  expect(ranking.posts).toEqual([
    { post_id: firstPost, views: 777, synced_destination_count: 1 },
    { post_id: unsyncedPost, views: 0, synced_destination_count: 0 },
  ]);
});
