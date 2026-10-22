import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createApiApp } from "../src/app";
import { authenticatedPoolFor, systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

type Schemas = components["schemas"];
const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) throw new Error("MELTIPLY_DATABASE_TEST_URL is required");
const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: { connectionString: "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable" } as Hyperdrive,
  ENVIRONMENT: "test", FRONTEND_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef", VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;
const identity: JwtIdentity = { subject: "auth_user_local_alpha", email: "alpha@meltiply.local", emailVerified: true };
const app = createApiApp({ verifyJwtToken: async () => identity });
let profileId: string;

/** Sends an authenticated HTTP request; every mutation receives a fresh key unless replay is under test. */
function request(path: string, method = "GET", body?: unknown, key = randomUUID()) {
  return app.request(`/api/v1${path}`, { method, headers: { Authorization: "Bearer queue-owner", "Content-Type": "application/json", "Idempotency-Key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}

beforeAll(async () => {
  const response = await request("/brand-profiles", "POST", { name: `Queue regression ${randomUUID()}`, color: "#1d4ed8" });
  expect(response.status).toBe(201);
  const profile: Schemas["BrandProfile"] = await response.json();
  profileId = profile.id;
});
afterAll(async () => {
  if (profileId) await systemPoolFor(env).query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
  await authenticatedPoolFor(env).end();
  await systemPoolFor(env).end();
});

describe("durable publishing Queues through authenticated HTTP", () => {
  it("creates a reusable scoped weekly plan and reads it after another request", async () => {
    const response = await request("/queues", "POST", { brand_profile_id: profileId, name: "Weekly launches", timezone: "America/New_York", slots: [{ weekday: 1, time: "09:30" }] });
    expect(response.status, await response.clone().text()).toBe(201);
    const queue = await response.json();
    const read = await request(`/queues/${queue.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: queue.id, brand_profile_id: profileId, name: "Weekly launches", timezone: "America/New_York", slots: [{ weekday: 1, time: "09:30" }] });
  });
});
