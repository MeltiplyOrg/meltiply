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
import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import {
  getPublicationRequirementsEffect,
  type PublicationAccountRow,
  type PublicationRequirementsOptions,
} from "../src/publication-requirements";
import { fakeEnv } from "../test-support/fakes";

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

const env = fakeEnv({ TOKEN_ENCRYPTION_KEY: "0".repeat(32) });
const session = {
  organizationId: "org-1",
  organizationRole: "org:admin",
  subject: "user-1",
};
const accountId = "00000000-0000-4000-8000-000000000201";
const now = new Date("2026-07-19T12:00:00Z");

interface RequirementGate {
  readonly promise: Promise<ProviderPublicationRequirements>;
  reject(cause: unknown): void;
  resolve(value: ProviderPublicationRequirements): void;
}

function pendingGate(): RequirementGate {
  let resolve!: RequirementGate["resolve"];
  let reject!: RequirementGate["reject"];
  const promise = new Promise<ProviderPublicationRequirements>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

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

function accountRow(overrides: Partial<PublicationAccountRow> = {}): PublicationAccountRow {
  return {
    access_token: "encrypted:provider-token-123",
    connection_status: "connected",
    platform: "tiktok",
    platform_user_id: "user-tiktok-1",
    revoked_at: null,
    token_expires_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function fakeOptions(
  account: PublicationAccountRow | null | (() => PublicationAccountRow | null) = accountRow(),
) {
  const decryptions: Promise<string>[] = [];
  const options: PublicationRequirementsOptions = {
    decryptToken: (encrypted) => {
      const promise = Promise.resolve(encrypted.replace("encrypted:", ""));
      decryptions.push(promise);
      return promise;
    },
    loadAccount: () => Effect.sync(() => (typeof account === "function" ? account() : account)),
  };
  const waitForDecryption = async (index: number) => {
    const decryption = decryptions[index];
    if (decryption === undefined) {
      throw new Error(`publication-requirements call ${index} never reached decryption`);
    }
    await decryption;
  };
  return { options, waitForDecryption };
}

function runRequirements(
  program: Effect.Effect<ProviderPublicationRequirements, unknown, ProviderService>,
  currentRegistry: ProviderRegistry,
  options?: { signal?: AbortSignal },
) {
  return Effect.runPromise(
    Effect.provide(program, createProviderServiceLive(currentRegistry)),
    options,
  );
}

describe("getPublicationRequirementsEffect", () => {
  it("returns publication requirements on success", async () => {
    const { options } = fakeOptions();
    const currentRegistry = registry(adapter());

    const result = await runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-1",
        currentRegistry,
        now,
        options,
      ),
      currentRegistry,
    );

    expect(result).toEqual(defaultRequirements);
  });

  it("returns 404 when the platform account is missing", async () => {
    const { options } = fakeOptions(null);
    const currentRegistry = registry(adapter());

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            "req-missing",
            currentRegistry,
            now,
            options,
          ),
          createProviderServiceLive(currentRegistry),
        ),
      ),
    );

    expect(error).toEqual(
      new CoreApiError(404, "not_found", "The platform account was not found."),
    );
  });

  it.each([
    ["revoked account", { revoked_at: "2026-07-01T00:00:00Z" }],
    ["disconnected account", { connection_status: "disconnected" }],
    ["expired token", { token_expires_at: "2026-07-19T12:00:00Z" }],
  ])("returns 409 invalid_state for %s", async (_example, patch) => {
    const { options } = fakeOptions(accountRow(patch));
    const currentRegistry = registry(adapter());

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            "req-unavail",
            currentRegistry,
            now,
            options,
          ),
          createProviderServiceLive(currentRegistry),
        ),
      ),
    );

    expect(error).toEqual(
      new CoreApiError(409, "invalid_state", "The platform account must be reconnected."),
    );
  });

  it.each([
    [
      "unexpected raw throw",
      () => new Error("boom"),
      new CoreApiError(502, "provider_unavailable", "The provider is temporarily unavailable."),
    ],
    [
      "deterministic provider failure",
      () =>
        new ProviderAdapterError(
          classifyProviderFailure({ code: "media_format_unsupported", status: 422 }),
        ),
      new CoreApiError(
        422,
        "unsupported_capability",
        "Publishing is not currently available for this creator.",
      ),
    ],
    [
      "rate-limit provider failure",
      () =>
        new ProviderAdapterError(
          classifyProviderFailure({ code: "rate_limit", retryAfterSeconds: 60, status: 429 }),
        ),
      new CoreApiError(
        429,
        "provider_rate_limited",
        "The provider rate limit has been reached.",
        60,
      ),
    ],
    [
      "auth provider failure",
      () =>
        new ProviderAdapterError(classifyProviderFailure({ code: "token_revoked", status: 401 })),
      new CoreApiError(409, "invalid_state", "The platform account must be reconnected."),
    ],
  ])("maps %s to its typed CoreApiError", async (_example, makeCause, expected) => {
    const { options } = fakeOptions();
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: async () => {
          throw makeCause();
        },
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            "req-err",
            customRegistry,
            now,
            options,
          ),
          createProviderServiceLive(customRegistry),
        ),
      ),
    );

    expect(error).toEqual(expected);
  });

  it("coalesces concurrent equivalent reads into one Provider call", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gate = pendingGate();
    const calls: unknown[] = [];
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: (ctx) => {
          calls.push(ctx);
          return gate.promise;
        },
      }),
    );

    const first = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-first",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-second",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    gate.resolve(defaultRequirements);

    expect(await first).toEqual(defaultRequirements);
    expect(await second).toEqual(defaultRequirements);
    expect(calls).toEqual([
      {
        operationId: "getPlatformPublishingRequirements",
        requestId: "req-first",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it("performs a fresh Provider read after a settled read", async () => {
    const { options } = fakeOptions();
    let attempt = 0;
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: async () => {
          attempt += 1;
          return { ...defaultRequirements, creatorDisplayName: `Creator ${attempt}` };
        },
      }),
    );

    expect(
      (
        await runRequirements(
          getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            "req-1",
            customRegistry,
            now,
            options,
          ),
          customRegistry,
        )
      ).creatorDisplayName,
    ).toEqual("Creator 1");
    expect(
      (
        await runRequirements(
          getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            "req-2",
            customRegistry,
            now,
            options,
          ),
          customRegistry,
        )
      ).creatorDisplayName,
    ).toEqual("Creator 2");
  });

  it("releases pending work after a shared Provider failure", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gate = pendingGate();
    let attempts = 0;
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          attempts += 1;
          return attempts === 1 ? gate.promise : Promise.resolve(defaultRequirements);
        },
      }),
    );

    const first = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-f1",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-f2",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    gate.reject(
      new ProviderAdapterError(
        classifyProviderFailure({ code: "rate_limit", retryAfterSeconds: 60, status: 429 }),
      ),
    );

    await expect(first).rejects.toMatchObject({ code: "provider_rate_limited", status: 429 });
    await expect(second).rejects.toMatchObject({ code: "provider_rate_limited", status: 429 });
    expect(
      await runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-after",
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      ),
    ).toEqual(defaultRequirements);
    expect(attempts).toEqual(2);
  });

  it("does not share reads across authorized identities", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gates: RequirementGate[] = [];
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          const gate = pendingGate();
          gates.push(gate);
          return gate.promise;
        },
      }),
    );

    const first = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-a",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        { ...session, subject: "user-2" },
        accountId,
        "req-b",
        customRegistry,
        now,
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    for (const gate of gates) gate.resolve(defaultRequirements);

    await Promise.all([first, second]);
    expect(gates).toHaveLength(2);
  });

  it.each(["credential", "connection"])(
    "does not share reads across %s generations",
    async (generation) => {
      let currentRow = accountRow({
        access_token: "encrypted:original-token",
        updated_at: "2026-07-01T00:00:00.000001Z",
      });
      const { options, waitForDecryption } = fakeOptions(() => currentRow);
      const gates: RequirementGate[] = [];
      const customRegistry = registry(
        adapter({
          getPublicationRequirements: () => {
            const gate = pendingGate();
            gates.push(gate);
            return gate.promise;
          },
        }),
      );

      const first = runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-before",
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      );
      await waitForDecryption(0);
      currentRow = accountRow({
        access_token:
          generation === "credential" ? "encrypted:rotated-token" : "encrypted:original-token",
        updated_at:
          generation === "connection"
            ? "2026-07-01T00:00:00.000002Z"
            : "2026-07-01T00:00:00.000001Z",
      });
      const second = runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          accountId,
          "req-after",
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      );
      await waitForDecryption(1);
      gates[0]?.resolve({ ...defaultRequirements, creatorDisplayName: "Before" });
      gates[1]?.resolve({ ...defaultRequirements, creatorDisplayName: "After" });

      expect((await first).creatorDisplayName).toEqual("Before");
      expect((await second).creatorDisplayName).toEqual("After");
      expect(gates).toHaveLength(2);
    },
  );

  it("does not share reads across Provider registries", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const firstGate = pendingGate();
    let firstCount = 0;
    let secondCount = 0;
    const firstRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          firstCount += 1;
          return firstGate.promise;
        },
      }),
    );
    const secondRegistry = registry(
      adapter({
        getPublicationRequirements: async () => {
          secondCount += 1;
          return defaultRequirements;
        },
      }),
    );

    const first = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-1",
        firstRegistry,
        now,
        options,
      ),
      firstRegistry,
    );
    await waitForDecryption(0);
    const second = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-2",
        secondRegistry,
        now,
        options,
      ),
      secondRegistry,
    );
    await waitForDecryption(1);

    expect(await second).toEqual(defaultRequirements);
    expect([firstCount, secondCount]).toEqual([1, 1]);
    firstGate.resolve(defaultRequirements);
    expect(await first).toEqual(defaultRequirements);
  });

  it("retains at most 32 pending keys and bypasses coalescing beyond capacity", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gates: RequirementGate[] = [];
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          const gate = pendingGate();
          gates.push(gate);
          return gate.promise;
        },
      }),
    );

    const calls = Array.from({ length: 32 }, (_, index) =>
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          `account-${index}`,
          `req-${index}`,
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      ),
    );
    for (let index = 0; index < 32; index += 1) {
      await waitForDecryption(index);
    }
    expect(gates).toHaveLength(32);

    calls.push(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          "account-0",
          "req-dup",
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      ),
    );
    await waitForDecryption(32);
    expect(gates).toHaveLength(32);

    calls.push(
      runRequirements(
        getPublicationRequirementsEffect(
          env,
          session,
          "account-32",
          "req-over",
          customRegistry,
          now,
          options,
        ),
        customRegistry,
      ),
    );
    await waitForDecryption(33);
    expect(gates).toHaveLength(33);

    for (const gate of gates) gate.resolve(defaultRequirements);
    await Promise.all(calls);
  });

  it("keeps a shared read alive when the initiating caller aborts", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gate = pendingGate();
    let calls = 0;
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          calls += 1;
          return gate.promise;
        },
      }),
    );

    const controller = new AbortController();
    const leader = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-leader",
        customRegistry,
        now,
        options,
      ),
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
        options,
      ),
      customRegistry,
    );
    await waitForDecryption(1);
    controller.abort();
    gate.resolve(defaultRequirements);

    expect(await follower).toEqual(defaultRequirements);
    await expect(leader).rejects.toBeDefined();
    expect(calls).toEqual(1);
  });

  it("cancels a follower without disturbing the shared read", async () => {
    const { options, waitForDecryption } = fakeOptions();
    const gate = pendingGate();
    let calls = 0;
    const customRegistry = registry(
      adapter({
        getPublicationRequirements: () => {
          calls += 1;
          return gate.promise;
        },
      }),
    );

    const leader = runRequirements(
      getPublicationRequirementsEffect(
        env,
        session,
        accountId,
        "req-leader",
        customRegistry,
        now,
        options,
      ),
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
        options,
      ),
      customRegistry,
      { signal: controller.signal },
    );
    await waitForDecryption(1);
    controller.abort();
    gate.resolve(defaultRequirements);

    expect(await leader).toEqual(defaultRequirements);
    await expect(follower).rejects.toBeDefined();
    expect(calls).toEqual(1);
  });
});
