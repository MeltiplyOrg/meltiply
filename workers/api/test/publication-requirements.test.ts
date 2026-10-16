import type { EffectTransactionClient } from "@meltiply/database";
import {
  classifyProviderFailure,
  createProviderServiceLive,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderService,
} from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { withTenantTransactionEffect } = vi.hoisted(() => ({
  withTenantTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withTenantTransactionEffect }));

import type { ApiWorkerEnv } from "../src/env";
import { getPublicationRequirementsEffect } from "../src/publication-requirements";
import { tokenCipherFor } from "../src/token-credentials";

/**
 * Runs one publication-requirements Effect with the live provider layer for the given registry.
 */
function runRequirements(
  program: Effect.Effect<unknown, unknown, ProviderService>,
  currentRegistry: ProviderRegistry,
) {
  return Effect.runPromise(Effect.provide(program, createProviderServiceLive(currentRegistry)));
}

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
    getPublicationRequirements: async () => ({
      commentAllowed: true,
      creatorAvatarUrl: "https://example.com/avatar.png",
      creatorDisplayName: "Test Creator",
      creatorUsername: "test.creator",
      duetAllowed: false,
      maxVideoDurationSeconds: 180,
      platform: "tiktok",
      privacyLevels: ["PUBLIC_TO_EVERYONE"],
      stitchAllowed: true,
    }),
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
});
