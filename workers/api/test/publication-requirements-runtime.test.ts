import type { EffectTransactionClient } from "@meltiply/database";
import {
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderPublicationRequirements,
} from "@meltiply/providers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { cipher, database } = vi.hoisted(() => {
  const decryptions: Promise<string>[] = [];
  const waiters: { count: number; resolve: (value: void | PromiseLike<void>) => void }[] = [];
  return {
    cipher: {
      decryptions,
      decrypt(value: string) {
        const decrypted = Promise.resolve(value.replace("encrypted:", ""));
        decryptions.push(decrypted);
        for (const waiter of [...waiters]) {
          if (decryptions.length < waiter.count) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(undefined);
        }
        return decrypted;
      },
      encrypt(value: string) {
        return Promise.resolve(`encrypted:${value}`);
      },
      reset() {
        decryptions.length = 0;
        waiters.length = 0;
      },
      waitForCount(count: number) {
        if (decryptions.length >= count) return Promise.resolve();
        const promise = new Promise<void>((resolve) => {
          waiters.push({ count, resolve });
        });
        return promise;
      },
    },
    database: {
      withTenantTransactionEffect: vi.fn(),
    },
  };
});

vi.mock("../src/database", () => ({
  activeOrganizationIdEffect: vi.fn(),
  authenticatedPoolFor: vi.fn(),
  systemPoolFor: vi.fn(),
  withSystemTransactionEffect: vi.fn(),
  withTenantTransactionEffect: database.withTenantTransactionEffect,
}));

// The cipher replacement stays deterministic inside workerd: it removes the
// only variable-latency step between the persisted account read and the shared
// Provider seam, so scenarios await real progress instead of wall-clock timers.
vi.mock("../src/token-credentials", () => ({
  tokenCipherFor: () => ({ decrypt: cipher.decrypt, encrypt: cipher.encrypt }),
}));

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: "https://api.meltiply.test",
  TOKEN_ENCRYPTION_KEY: "0".repeat(32),
  VERSION: "runtime-test",
} as unknown as ApiWorkerEnv;

const actor: ResolvedActor = {
  authUserId: "user-runtime-alpha",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "user-runtime-alpha",
    userId: "10000000-0000-4000-8000-000000000001",
  },
  displayName: "Runtime Alpha",
  email: "alpha@meltiply.test",
  isInstallationOwner: true,
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Runtime Alpha",
    slug: "runtime-alpha",
  },
};

const accountId = "94000000-0000-4000-8000-000000000291";

const defaultRequirements: ProviderPublicationRequirements = {
  commentAllowed: true,
  creatorAvatarUrl: "https://example.com/avatar.png",
  creatorDisplayName: "Runtime Creator",
  creatorUsername: "runtime.creator",
  duetAllowed: false,
  maxVideoDurationSeconds: 180,
  platform: "tiktok",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  stitchAllowed: true,
};

interface RuntimeAccountRow {
  access_token: string;
  connection_status: string;
  platform: "tiktok";
  platform_user_id: string;
  revoked_at: string | null;
  token_expires_at: string | null;
  updated_at: string;
}

/** Builds one RLS-visible account row; scenarios replace fields between requests. */
function accountRow(overrides: Partial<RuntimeAccountRow> = {}): RuntimeAccountRow {
  return {
    access_token: "encrypted:runtime-access-token",
    connection_status: "connected",
    platform: "tiktok",
    platform_user_id: "runtime-tiktok-creator",
    revoked_at: null,
    token_expires_at: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Serves the current mutable account row through the tenant transaction seam.
 *
 * The route's RLS query is the only database work this smoke needs; returning
 * the row from the mock transaction keeps the production route, middleware,
 * Effect runtime, and Provider seam intact.
 *
 * @param row - Row the next authenticated requirements request observes.
 */
function mockAccountRead(row: RuntimeAccountRow) {
  database.withTenantTransactionEffect.mockImplementation(
    (
      _env: ApiWorkerEnv,
      _session: unknown,
      operation: (client: EffectTransactionClient) => Effect.Effect<unknown, unknown>,
    ) =>
      operation({
        query: vi.fn(() => Effect.succeed({ rowCount: 1, rows: [row] })),
      } as unknown as EffectTransactionClient),
  );
}

type RequirementRead = NonNullable<ProviderAdapter["getPublicationRequirements"]>;

/** Builds one publish-capable TikTok adapter whose requirement read is controlled by the scenario. */
function requirementAdapter(read: RequirementRead): ProviderAdapter {
  return {
    capability: {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: [],
      notes: [],
      platform: "tiktok",
      publish: false,
      reply: false,
    },
    getPublicationRequirements: read,
    transferModes: [],
  };
}

/** Creates the production app with one injected registry and authenticated actor. */
function runtimeApp(read: RequirementRead) {
  const registry = new ProviderRegistry();
  registry.register("tiktok", requirementAdapter(read));
  return createApiApp({
    providerRegistry: registry,
    resolveActor: async () => actor,
    verifyJwtToken: async () => ({
      email: actor.email,
      name: actor.displayName,
      subject: actor.claims.subject,
    }),
  });
}

/** Builds an authenticated requirements GET preserving the optional client abort signal. */
function requirementsRequest(requestId: string, signal?: AbortSignal) {
  return new Request(
    `https://api.meltiply.test/api/v1/platforms/${accountId}/publishing-requirements`,
    {
      headers: {
        Authorization: "Bearer runtime-test",
        "X-Request-ID": requestId,
      },
      signal,
    },
  );
}

/**
 * Waits until the given caller has passed credential decryption.
 *
 * The mocked decrypt Effects resume synchronously into the next coalescing
 * step, so this is the observable signal that a request joined pending work or
 * reached the Provider seam.
 */
async function waitForDecryption(count: number) {
  await cipher.waitForCount(count);
  const decryption = cipher.decryptions[count - 1];
  if (decryption === undefined) throw new Error("requirements decryption was not observed");
  await decryption;
}

/** Test-controlled Provider read settlement used to hold coalescing pending. */
interface RequirementGate {
  readonly promise: Promise<ProviderPublicationRequirements>;
  reject(cause: unknown): void;
  resolve(value: ProviderPublicationRequirements): void;
}

/** Creates a settlement gate; ES2023 has no `Promise.withResolvers`. */
function pendingGate(): RequirementGate {
  let resolve!: RequirementGate["resolve"];
  let reject!: RequirementGate["reject"];
  const promise = new Promise<ProviderPublicationRequirements>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  cipher.reset();
  database.withTenantTransactionEffect.mockReset();
});

describe("publishing-requirement coalescing in the workerd runtime", () => {
  it("shares one pending Provider read across concurrent requests with independent response IDs", async () => {
    mockAccountRead(accountRow());
    const gate = pendingGate();
    const read = vi.fn(() => gate.promise);
    const app = runtimeApp(read);

    const first = app.request(requirementsRequest("req-runtime-first"), undefined, env);
    await waitForDecryption(1);
    expect(read).toHaveBeenCalledOnce();
    const second = app.request(requirementsRequest("req-runtime-second"), undefined, env);
    await waitForDecryption(2);
    gate.resolve(defaultRequirements);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstResponse.headers.get("X-Request-ID")).toBe("req-runtime-first");
    expect(secondResponse.headers.get("X-Request-ID")).toBe("req-runtime-second");
    await expect(firstResponse.json()).resolves.toMatchObject({
      creator: { username: "runtime.creator" },
      platform: "tiktok",
    });
    await expect(secondResponse.json()).resolves.toMatchObject({
      creator: { username: "runtime.creator" },
      platform: "tiktok",
    });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toMatchObject({ requestId: "req-runtime-first" });
  });

  it("keeps shared work alive when the initiating request is interrupted", async () => {
    mockAccountRead(accountRow());
    const gate = pendingGate();
    const read = vi.fn(() => gate.promise);
    const app = runtimeApp(read);
    const controller = new AbortController();

    const leader = app.request(
      requirementsRequest("req-runtime-leader", controller.signal),
      undefined,
      env,
    );
    await waitForDecryption(1);
    const follower = app.request(requirementsRequest("req-runtime-follower"), undefined, env);
    await waitForDecryption(2);
    controller.abort();
    gate.resolve(defaultRequirements);

    const [leaderResponse, followerResponse] = await Promise.all([leader, follower]);
    expect(followerResponse.status).toBe(200);
    expect(leaderResponse.status).toBe(499);
    expect(read).toHaveBeenCalledOnce();
  });

  it("settles a canceled joiner without disturbing the shared read", async () => {
    mockAccountRead(accountRow());
    const gate = pendingGate();
    const read = vi.fn(() => gate.promise);
    const app = runtimeApp(read);
    const controller = new AbortController();

    const leader = app.request(requirementsRequest("req-runtime-leader"), undefined, env);
    await waitForDecryption(1);
    const follower = app.request(
      requirementsRequest("req-runtime-follower", controller.signal),
      undefined,
      env,
    );
    await waitForDecryption(2);
    controller.abort();
    gate.resolve(defaultRequirements);

    const [leaderResponse, followerResponse] = await Promise.all([leader, follower]);
    expect(leaderResponse.status).toBe(200);
    expect(followerResponse.status).toBe(499);
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects a revoked account even while an equivalent read is pending", async () => {
    let row = accountRow();
    database.withTenantTransactionEffect.mockImplementation(
      (
        _env: ApiWorkerEnv,
        _session: unknown,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown, unknown>,
      ) =>
        operation({
          query: vi.fn(() => Effect.succeed({ rowCount: 1, rows: [row] })),
        } as unknown as EffectTransactionClient),
    );
    const gate = pendingGate();
    const read = vi.fn(() => gate.promise);
    const app = runtimeApp(read);

    const leader = app.request(requirementsRequest("req-runtime-valid"), undefined, env);
    await waitForDecryption(1);
    row = accountRow({
      connection_status: "revoked",
      revoked_at: "2026-07-02T00:00:00.000Z",
    });
    const revoked = app.request(requirementsRequest("req-runtime-revoked"), undefined, env);
    const revokedResponse = await revoked;
    expect(revokedResponse.status).toBe(409);
    expect(read).toHaveBeenCalledOnce();
    gate.resolve(defaultRequirements);
    expect((await leader).status).toBe(200);
  });

  it("starts a separate read for a rotated credential generation", async () => {
    let row = accountRow();
    database.withTenantTransactionEffect.mockImplementation(
      (
        _env: ApiWorkerEnv,
        _session: unknown,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown, unknown>,
      ) =>
        operation({
          query: vi.fn(() => Effect.succeed({ rowCount: 1, rows: [row] })),
        } as unknown as EffectTransactionClient),
    );
    const gates: RequirementGate[] = [];
    const read = vi.fn(() => {
      const gate = pendingGate();
      gates.push(gate);
      return gate.promise;
    });
    const app = runtimeApp(read);

    const before = app.request(requirementsRequest("req-runtime-before"), undefined, env);
    await waitForDecryption(1);
    row = accountRow({
      access_token: "encrypted:rotated-runtime-access-token",
      updated_at: "2026-07-02T00:00:00.000Z",
    });
    const after = app.request(requirementsRequest("req-runtime-after"), undefined, env);
    await waitForDecryption(2);
    expect(read).toHaveBeenCalledTimes(2);
    gates[0]?.resolve({ ...defaultRequirements, creatorDisplayName: "Before rotation" });
    gates[1]?.resolve({ ...defaultRequirements, creatorDisplayName: "After rotation" });

    const [beforeResponse, afterResponse] = await Promise.all([before, after]);
    expect(beforeResponse.status).toBe(200);
    expect(afterResponse.status).toBe(200);
    expect(await beforeResponse.json()).toMatchObject({
      creator: { display_name: "Before rotation" },
    });
    expect(await afterResponse.json()).toMatchObject({
      creator: { display_name: "After rotation" },
    });
  });
});
