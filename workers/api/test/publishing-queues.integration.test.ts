import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createThreadsAdapter, ProviderRegistry } from "@meltiply/providers";
import { createApiApp } from "../src/app";
import { authenticatedPoolFor, systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

type Schemas = components["schemas"];
const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) throw new Error("MELTIPLY_DATABASE_TEST_URL is required");
const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;
let profileId: string;
const identities: Record<string, JwtIdentity> = {
  owner: { subject: "auth_user_local_alpha", email: "alpha@meltiply.local", emailVerified: true },
  editor: { subject: "auth_user_local_gamma", email: "gamma@meltiply.local", emailVerified: true },
  viewer: { subject: "auth_user_local_delta", email: "delta@meltiply.local", emailVerified: true },
};
const registry = new ProviderRegistry();
registry.register(
  "threads",
  createThreadsAdapter({
    clientId: "queue-http-fixture",
    clientSecret: "queue-http-fixture-secret",
    redirectUri: "https://queue.invalid/callback",
  }),
);
const app = createApiApp({
  verifyJwtToken: async (_env, token) => identities[token]!,
  providerRegistry: registry,
});

let channelId: string;
/** Sends an authenticated HTTP request; every mutation receives a fresh key unless replay is under test. */
function request(path: string, method = "GET", body?: unknown, key = randomUUID(), role = "owner") {
  return app.request(
    `/api/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${role}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

beforeAll(async () => {
  const response = await request("/brand-profiles", "POST", {
    name: `Queue regression ${randomUUID()}`,
    color: "#1d4ed8",
  });
  expect(response.status).toBe(201);
  const profile: Schemas["BrandProfile"] = await response.json();
  profileId = profile.id;
  const channel = await systemPoolFor(env).query<{ id: string }>(
    `INSERT INTO platform_accounts (org_id, brand_profile_id, platform, platform_user_id, display_name, access_token, scopes, connection_status)
     SELECT org_id, id, 'threads', $2, 'Queue HTTP Channel', 'queue-fixture-no-provider-call', ARRAY['publish'], 'connected'
     FROM brand_profiles WHERE id = $1 RETURNING id`,
    [profileId, randomUUID()],
  );
  channelId = channel.rows[0]!.id;
});
afterAll(async () => {
  if (profileId)
    await systemPoolFor(env).query("DELETE FROM brand_profiles WHERE id = $1", [profileId]);
  await authenticatedPoolFor(env).end();
  await systemPoolFor(env).end();
});
afterEach(() => vi.useRealTimers());

/** Creates a distinct durable plan through the HTTP seam, with independently chosen timezone examples. */
async function createPlan(
  slots: Schemas["QueueSlot"][],
  timezone = "UTC",
): Promise<Schemas["PublishingQueue"]> {
  const response = await request("/queues", "POST", {
    brand_profile_id: profileId,
    name: `Queue ${randomUUID()}`,
    timezone,
    slots,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** Saves a real text Post and a Channel-specific caption; no scheduling implementation is replaced. */
async function createPost(): Promise<Schemas["Post"]> {
  const response = await request("/posts", "POST", {
    brand_profile_id: profileId,
    default_text: "Retain the shared composition",
    targets: [
      {
        platform_account_id: channelId,
        description_override: "Retain the Channel override",
        hashtags: ["launch"],
      },
    ],
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** Enqueues one existing Post with its saved targets, retaining a supplied key for replay scenarios. */
async function enqueue(
  postId: string,
  queueId: string,
  key = randomUUID(),
): Promise<Schemas["Post"]> {
  const response = await request(
    `/posts/${postId}/schedule`,
    "POST",
    { brand_profile_id: profileId, queue_id: queueId },
    key,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

describe("durable publishing Queues through authenticated HTTP", () => {
  it("creates a reusable scoped weekly plan and reads it after another request", async () => {
    const response = await request("/queues", "POST", {
      brand_profile_id: profileId,
      name: "Weekly launches",
      timezone: "America/New_York",
      slots: [{ weekday: 1, time: "09:30" }],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const queue = await response.json();
    const read = await request(`/queues/${queue.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: queue.id,
      brand_profile_id: profileId,
      name: "Weekly launches",
      timezone: "America/New_York",
      slots: [{ weekday: 1, time: "09:30" }],
    });
  });
  it("allocates successive future slots, preserves composition, and replays without another intent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
    const plan = await createPlan([
      { weekday: 1, time: "09:00" },
      { weekday: 1, time: "09:01" },
      { weekday: 1, time: "09:02" },
    ]);
    const first = await createPost();
    const second = await createPost();
    const key = randomUUID();
    const queued = await enqueue(first.id, plan.id, key);
    expect(queued.queue_membership).toMatchObject({
      queue_id: plan.id,
      assigned_at: "2026-10-26T09:01:00.000Z",
    });
    expect(queued.default_text).toBe(first.default_text);
    expect(queued.targets).toEqual(first.targets);
    expect(queued.distributions).toMatchObject([
      {
        status: "scheduled",
        scheduled_at: "2026-10-26T09:01:00.000Z",
        description_override: "Retain the Channel override",
        hashtags: ["launch"],
      },
    ]);
    expect(await enqueue(first.id, plan.id, key)).toEqual(queued);
    const repeated = await enqueue(first.id, plan.id);
    expect(repeated.queue_membership).toEqual(queued.queue_membership);
    expect(repeated.distributions.map((row) => row.id)).toEqual(
      queued.distributions.map((row) => row.id),
    );
    expect((await enqueue(second.id, plan.id)).queue_membership?.assigned_at).toBe(
      "2026-10-26T09:02:00.000Z",
    );
    const reloaded: Schemas["Post"] = await (await request(`/posts/${first.id}`)).json();
    expect(reloaded.queue_membership).toEqual(queued.queue_membership);
    expect(reloaded.targets).toEqual(first.targets);
  });

  it("serializes concurrent allocations and concurrent duplicate requests without reserving twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
    const plan = await createPlan([
      { weekday: 1, time: "09:01" },
      { weekday: 1, time: "09:02" },
      { weekday: 1, time: "09:03" },
    ]);
    const posts = await Promise.all([createPost(), createPost(), createPost()]);
    const assigned = await Promise.all(posts.map((post) => enqueue(post.id, plan.id)));
    expect(assigned.map((post) => post.queue_membership!.assigned_at).sort()).toEqual([
      "2026-10-26T09:01:00.000Z",
      "2026-10-26T09:02:00.000Z",
      "2026-10-26T09:03:00.000Z",
    ]);
    const duplicatePost = await createPost();
    const key = randomUUID();
    const duplicate = await Promise.all([
      enqueue(duplicatePost.id, plan.id, key),
      enqueue(duplicatePost.id, plan.id, key),
    ]);
    expect(duplicate[0]).toEqual(duplicate[1]);
    expect(duplicate[0]!.queue_membership?.assigned_at).toBe("2026-11-02T09:01:00.000Z");
  });

  it.each([
    [
      "2026-03-08T06:00:00Z",
      "America/New_York",
      [{ weekday: 0, time: "02:30" }],
      "2026-03-15T06:30:00.000Z",
    ],
    [
      "2026-11-01T04:00:00Z",
      "America/New_York",
      [{ weekday: 0, time: "01:30" }],
      "2026-11-01T06:30:00.000Z",
    ],
    [
      "2026-10-26T08:30:00Z",
      "Asia/Kathmandu",
      [{ weekday: 1, time: "14:15" }],
      "2026-11-02T08:30:00.000Z",
    ],
    ["2026-10-25T23:59:59Z", "UTC", [{ weekday: 1, time: "00:00" }], "2026-10-26T00:00:00.000Z"],
  ] as const)(
    "resolves calendar boundary %s in %s deterministically",
    async (now, timezone, slots, expected) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      const plan = await createPlan([...slots], timezone);
      expect((await enqueue((await createPost()).id, plan.id)).queue_membership?.assigned_at).toBe(
        expected,
      );
    },
  );

  it("freezes existing reservations across plan edits, and releases only the removed slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
    const plan = await createPlan([
      { weekday: 1, time: "09:01" },
      { weekday: 1, time: "09:02" },
    ]);
    const first = await enqueue((await createPost()).id, plan.id);
    const second = await enqueue((await createPost()).id, plan.id);
    expect(
      (await request(`/queues/${plan.id}`, "DELETE", { brand_profile_id: profileId })).status,
    ).toBe(409);
    const removed = await request(`/queues/${plan.id}/posts/${first.id}`, "DELETE", {
      brand_profile_id: profileId,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const released: Schemas["Post"] = await removed.json();
    expect(released.queue_membership).toBeNull();
    expect(released.distributions).toMatchObject([{ status: "cancelled" }]);
    expect(released.default_text).toBe(first.default_text);
    expect((await enqueue((await createPost()).id, plan.id)).queue_membership?.assigned_at).toBe(
      "2026-10-26T09:01:00.000Z",
    );
    const edited = await request(`/queues/${plan.id}`, "PATCH", {
      brand_profile_id: profileId,
      timezone: "America/New_York",
      slots: [{ weekday: 2, time: "12:00" }],
    });
    expect(edited.status).toBe(200);
    const readSecond: Schemas["Post"] = await (await request(`/posts/${second.id}`)).json();
    expect(readSecond.queue_membership).toEqual(second.queue_membership);
    expect((await enqueue((await createPost()).id, plan.id)).queue_membership?.assigned_at).toBe(
      "2026-10-27T16:00:00.000Z",
    );
    expect(
      (
        await request(`/posts/${second.id}/schedule`, "POST", {
          brand_profile_id: profileId,
          scheduled_at: null,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/distributions/${second.distributions[0]!.id}`, "PATCH", {
          scheduled_at: "2026-10-28T16:00:00Z",
        })
      ).status,
    ).toBe(409);
  });

  it("enforces configuration roles, membership roles, exact scheduling mode and Brand Profile scope", async () => {
    const plan = await createPlan([{ weekday: 1, time: "09:00" }]);
    expect(
      (
        await request(
          "/queues",
          "POST",
          {
            brand_profile_id: profileId,
            name: "Editor plan",
            timezone: "UTC",
            slots: [{ weekday: 1, time: "09:00" }],
          },
          randomUUID(),
          "editor",
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(`/queues/${plan.id}`, "GET", undefined, randomUUID(), "viewer")).status,
    ).toBe(200);
    const post = await createPost();
    expect(
      (
        await request(
          `/posts/${post.id}/schedule`,
          "POST",
          { brand_profile_id: profileId, queue_id: plan.id },
          randomUUID(),
          "viewer",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/posts/${post.id}/schedule`, "POST", {
          brand_profile_id: profileId,
          queue_id: plan.id,
          scheduled_at: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/posts/${post.id}/schedule`, "POST", { brand_profile_id: profileId })).status,
    ).toBe(400);
    expect(
      (
        await request(`/queues/${plan.id}`, "PATCH", {
          brand_profile_id: randomUUID(),
          name: "wrong scope",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/queues", "POST", {
          brand_profile_id: randomUUID(),
          name: "foreign",
          timezone: "UTC",
          slots: [{ weekday: 1, time: "09:00" }],
        })
      ).status,
    ).toBe(404);
  });

  it.each([
    { timezone: "Not/A_Zone" },
    { slots: [] },
    { slots: [{ weekday: 7, time: "12:00" }] },
    { slots: [{ weekday: 1, time: "24:00" }] },
    {
      slots: [
        { weekday: 1, time: "09:00" },
        { weekday: 1, time: "09:00" },
      ],
    },
    { name: "   " },
  ])("rejects invalid recurring configuration %j", async (patch) => {
    const response = await request("/queues", "POST", {
      brand_profile_id: profileId,
      name: "Invalid plan",
      timezone: "UTC",
      slots: [{ weekday: 1, time: "09:00" }],
      ...patch,
    });
    expect(response.status).toBe(422);
  });
});
