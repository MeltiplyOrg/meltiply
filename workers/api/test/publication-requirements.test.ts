import type { EffectTransactionClient } from "@meltiply/database";
import {
  classifyProviderFailure,
  createProviderServiceLive,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderPublicationRequirements,
  type ProviderService,
} from "@meltiply/providers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { tokenDecryptions, withTenantTransactionEffect } = vi.hoisted(() => ({
  tokenDecryptions: [] as Promise<string>[],
  withTenantTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withTenantTransactionEffect }));

// Credential cryptography is not under test here. An immediate cipher makes the
// post-lookup path a deterministic microtask sequence that scenarios can await
// without wall-clock timers.
vi.mock("../src/token-credentials", () => ({
  tokenCipherFor: () => ({
    decrypt: (value: string) => {
      const decrypted = Promise.resolve(value.replace("encrypted:", ""));
      tokenDecryptions.push(decrypted);
      return decrypted;
    },
    encrypt: (value: string) => Promise.resolve(`encrypted:${value}`),
  }),
}));

import type { ApiWorkerEnv } from "../src/env";
import { getPublicationRequirementsEffect } from "../src/publication-requirements";
import { tokenCipherFor } from "../src/token-credentials";

/**
 * Runs one publication-requirements Effect with the live provider layer for the given registry.
 *
 * Passing an abort signal lets a scenario interrupt the calling request while a
 * shared Provider read is pending, matching the route boundary's cancellation.
 */
function runRequirements(
  program: Effect.Effect<unknown, unknown, ProviderService>,
  currentRegistry: ProviderRegistry,
  options?: { signal?: AbortSignal },
) {
  return Effect.runPromise(
    Effect.provide(program, createProviderServiceLive(currentRegistry)),
    options,
  );
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

/**
 * Waits until the caller at `index` has passed credential decryption.
 *
 * The mocked decrypt Effects resume synchronously into the next coalescing
 * step, so resolving this promise is the test-visible signal that a caller has
 * either joined a pending read or reached the Provider call.
 */
async function waitForDecryption(index: number) {
  const decryption = tokenDecryptions[index];
  if (decryption === undefined) {
    throw new Error(`publication-requirements call ${index} never reached decryption`);
  }
  await decryption;
}

const defaultRequirements: ProviderPublicationRequirements = {
  commentAllowed: true,
  creatorAvatarUrl: "https://example.com/avatar.png",
  creatorDisplayName: "Test Creator",
  creatorUsername: "test.creator",
  duetAllowed: false,
  maxVideoDurationSeconds: 180,
  platform: "tiktok",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  stitchAllowed: true,
};

const env = {
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0".repeat(32),
  VERSION: "test",
} as unknown as ApiWorkerEnv;

const session = {
  organizationId: "org-1",
  organizationRole: "org:admin",
  subject: "user-1",
};

const accountId = "00000000-0000-4000-8000-000000000201";
const now = new Date("2026-07-19T12:00:00Z");

function adapter(patch: Partial<ProviderAdapter> = {}): ProviderAdapter {
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
    getPublicationRequirements: async () => defaultRequirements,
    transferModes: [],
    ...patch,
  };
}

function registry(value: ProviderAdapter): ProviderRegistry {
  const result = new ProviderRegistry();
  result.register("tiktok", value);
  return result;
}

/** Supplies encrypted account data through the Effect transaction seam without database I/O. */
async function setupMockAccount(overrides: Record<string, unknown> = {}) {
  const encrypted = await tokenCipherFor(env).encrypt("provider-token-123");
  const query = vi.fn(() =>
    Effect.succeed({
      rowCount: 1,
      rows: [
        {
          access_token: encrypted,
          connection_status: "connected",
          platform: "tiktok",
          platform_user_id: "user-tiktok-1",
          revoked_at: null,
          token_expires_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
          ...overrides,
        },
      ],
    }),
  );
  withTenantTransactionEffect.mockImplementation(
    (
      _env: ApiWorkerEnv,
      _session: typeof session,
      operation: (client: EffectTransactionClient) => Effect.Effect<unknown, unknown>,
    ) => operation({ query } as unknown as EffectTransactionClient),
  );
  return query;
}

describe("getPublicationRequirementsEffect", () => {
  beforeEach(() => {
    tokenDecryptions.length = 0;
  });

  it("returns publication requirements on success", async () => {
    await setupMockAccount();
    const currentRegistry = registry(adapter());
    const result = await runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-1", currentRegistry, now),
      currentRegistry,
    );

    expect(result).toMatchObject({
      creatorDisplayName: "Test Creator",
      creatorUsername: "test.creator",
      platform: "tiktok",
    });
  });

  it("maps unexpected raw throws to 502 provider_unavailable rather than 422", async () => {
    await setupMockAccount();
    const getRequirements = vi.fn(async () => {
      throw new Error("boom");
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));

    await expect(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-unexpected",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 502,
    });
  });

  it("preserves structured deterministic provider errors as 422 unsupported_capability", async () => {
    await setupMockAccount();
    const getRequirements = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({
          code: "media_format_unsupported",
          status: 422,
        }),
      );
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));

    await expect(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-deterministic",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 422,
    });
  });

  it("preserves structured rate-limit provider errors as 429 provider_rate_limited with Retry-After", async () => {
    await setupMockAccount();
    const getRequirements = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({
          code: "rate_limit",
          retryAfterSeconds: 60,
          status: 429,
        }),
      );
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));

    await expect(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-rate-limit",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterSeconds: 60,
      status: 429,
    });
  });

  it("preserves structured auth provider errors as 409 invalid_state", async () => {
    await setupMockAccount();
    const getRequirements = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({
          code: "token_revoked",
          status: 401,
        }),
      );
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));

    await expect(
      runRequirements(
        getPublicationRequirementsEffect(env, session, accountId, "req-auth", customRegistry, now),
        customRegistry,
      ),
    ).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
    });
  });

  it("coalesces concurrent equivalent reads into one Provider call", async () => {
    await setupMockAccount();
    const gate = pendingGate();
    const getRequirements = vi.fn(() => gate.promise);
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const first = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-first", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-second", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(1);
    gate.resolve(defaultRequirements);

    await expect(first).resolves.toEqual(defaultRequirements);
    await expect(second).resolves.toEqual(defaultRequirements);
    expect(getRequirements).toHaveBeenCalledOnce();
    expect(getRequirements.mock.calls[0]?.[0]).toMatchObject({
      operationId: "getPlatformPublishingRequirements",
      requestId: "req-first",
    });
  });

  it("performs a fresh Provider read after the shared read settles", async () => {
    await setupMockAccount();
    let attempt = 0;
    const getRequirements = vi.fn(async () => {
      attempt += 1;
      return { ...defaultRequirements, creatorDisplayName: `Creator ${attempt}` };
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));

    await expect(
      runRequirements(
        getPublicationRequirementsEffect(env, session, accountId, "req-cold", customRegistry, now),
        customRegistry,
      ),
    ).resolves.toMatchObject({ creatorDisplayName: "Creator 1" });
    await expect(
      runRequirements(
        getPublicationRequirementsEffect(env, session, accountId, "req-warm", customRegistry, now),
        customRegistry,
      ),
    ).resolves.toMatchObject({ creatorDisplayName: "Creator 2" });
    expect(getRequirements).toHaveBeenCalledTimes(2);
  });

  it("releases pending work after a shared Provider failure", async () => {
    await setupMockAccount();
    const gate = pendingGate();
    let attempts = 0;
    const getRequirements = vi.fn(() => {
      attempts += 1;
      return attempts === 1 ? gate.promise : Promise.resolve(defaultRequirements);
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const first = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-fail-first",
        customRegistry,
        now,
      ),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-fail-second",
        customRegistry,
        now,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    gate.reject(
      new ProviderAdapterError(
        classifyProviderFailure({
          code: "rate_limit",
          retryAfterSeconds: 60,
          status: 429,
        }),
      ),
    );

    await expect(first).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterSeconds: 60,
      status: 429,
    });
    await expect(second).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterSeconds: 60,
      status: 429,
    });
    await expect(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-after-failure",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    ).resolves.toEqual(defaultRequirements);
    expect(getRequirements).toHaveBeenCalledTimes(2);
  });

  it("does not share reads across authorized identities", async () => {
    await setupMockAccount();
    const gates: RequirementGate[] = [];
    const getRequirements = vi.fn(() => {
      const gate = pendingGate();
      gates.push(gate);
      return gate.promise;
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const first = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-alpha", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        { ...session, subject: "user-2" },
        accountId,
        "req-beta",
        customRegistry,
        now,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    for (const gate of gates) gate.resolve(defaultRequirements);

    await Promise.all([first, second]);
    expect(getRequirements).toHaveBeenCalledTimes(2);
  });

  it("does not share reads across credential generations", async () => {
    await setupMockAccount();
    const gates: RequirementGate[] = [];
    const getRequirements = vi.fn(() => {
      const gate = pendingGate();
      gates.push(gate);
      return gate.promise;
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const first = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-before", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(0);
    const rotated = await tokenCipherFor(env).encrypt("rotated-token");
    await setupMockAccount({ access_token: rotated });
    const second = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-after", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(1);
    gates[0]?.resolve({ ...defaultRequirements, creatorDisplayName: "Before rotation" });
    gates[1]?.resolve({ ...defaultRequirements, creatorDisplayName: "After rotation" });

    await expect(first).resolves.toMatchObject({ creatorDisplayName: "Before rotation" });
    await expect(second).resolves.toMatchObject({ creatorDisplayName: "After rotation" });
    expect(getRequirements).toHaveBeenCalledTimes(2);
  });

  it("does not share reads across Provider registries", async () => {
    await setupMockAccount();
    const firstGate = pendingGate();
    const firstRead = vi.fn(() => firstGate.promise);
    const secondRead = vi.fn(async () => defaultRequirements);
    const firstRegistry = registry(adapter({ getPublicationRequirements: firstRead }));
    const secondRegistry = registry(adapter({ getPublicationRequirements: secondRead }));
    const first = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-first", firstRegistry, now),
      firstRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-second", secondRegistry, now),
      secondRegistry,
    );
    await waitForDecryption(1);

    await expect(second).resolves.toEqual(defaultRequirements);
    expect(secondRead).toHaveBeenCalledOnce();
    expect(firstRead).toHaveBeenCalledOnce();
    firstGate.resolve(defaultRequirements);
    await expect(first).resolves.toEqual(defaultRequirements);
  });

  it("retains at most 32 pending keys and bypasses coalescing beyond capacity", async () => {
    await setupMockAccount();
    const gates: RequirementGate[] = [];
    const getRequirements = vi.fn(() => {
      const gate = pendingGate();
      gates.push(gate);
      return gate.promise;
    });
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const calls = Array.from({ length: 32 }, (_, index) =>
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          `account-${index}`,
          `req-${index}`,
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    );
    for (let index = 0; index < 32; index += 1) {
      await waitForDecryption(index);
    }
    expect(getRequirements).toHaveBeenCalledTimes(32);

    calls.push(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          "account-0",
          "req-duplicate",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    );
    await waitForDecryption(32);
    expect(getRequirements).toHaveBeenCalledTimes(32);

    calls.push(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          "account-32",
          "req-over-capacity",
          customRegistry,
          now,
        ),
        customRegistry,
      ),
    );
    await waitForDecryption(33);
    expect(getRequirements).toHaveBeenCalledTimes(33);

    for (const gate of gates) gate.resolve(defaultRequirements);
    await Promise.all(calls);
  });

  it("keeps a shared read available when its initiating caller is interrupted", async () => {
    await setupMockAccount();
    const gate = pendingGate();
    const getRequirements = vi.fn(() => gate.promise);
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const controller = new AbortController();
    const leader = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-leader", customRegistry, now),
      customRegistry,
      { signal: controller.signal },
    );
    await waitForDecryption(0);
    const follower = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-follower",
        customRegistry,
        now,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    controller.abort();
    gate.resolve(defaultRequirements);

    await expect(follower).resolves.toEqual(defaultRequirements);
    await expect(leader).rejects.toBeDefined();
    expect(getRequirements).toHaveBeenCalledOnce();
  });

  it("removes a canceled waiter without disturbing the shared read", async () => {
    await setupMockAccount();
    const gate = pendingGate();
    const getRequirements = vi.fn(() => gate.promise);
    const customRegistry = registry(adapter({ getPublicationRequirements: getRequirements }));
    const leader = runRequirements(
      getPublicationRequirementsEffect(env, session, accountId, "req-leader", customRegistry, now),
      customRegistry,
    );
    await waitForDecryption(0);
    const controller = new AbortController();
    const follower = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-follower",
        customRegistry,
        now,
      ),
      customRegistry,
      { signal: controller.signal },
    );
    await waitForDecryption(1);
    controller.abort();
    gate.resolve(defaultRequirements);

    await expect(leader).resolves.toEqual(defaultRequirements);
    await expect(follower).rejects.toBeDefined();
    expect(getRequirements).toHaveBeenCalledOnce();
  });
});
