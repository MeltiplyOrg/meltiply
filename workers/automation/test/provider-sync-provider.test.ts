import { Effect } from "effect";
import { runProviderProgram } from "./provider-program";
import type { EffectTransactionClient } from "@meltiply/database";

import {
  classifyProviderFailure,
  type ProviderAdapter,
  ProviderAdapterError,
  ProviderRegistry,
} from "@meltiply/providers";
import { describe, expect, it, vi } from "vite-plus/test";

import { createQueuePublisherTest } from "../src/effect/services";
import type { AutomationEnv } from "../src/env";
import {
  processProviderSyncMessage,
  type ProviderSyncProcessingDependencies,
} from "../src/provider-sync";
import {
  executeProviderAnalyticsEffect,
  executeProviderCommentsEffect,
  executeProviderTokenRefreshEffect,
} from "../src/provider-sync-provider";

vi.mock("../src/database", () => ({ withSystemTransactionEffect: vi.fn() }));

const context = { operationId: "sync-1", requestId: "request-1" };
const now = new Date("2026-07-19T12:00:00Z");
const retryPolicy = {
  baseDelaySeconds: 15,
  maxAttempts: 5,
  maxDelaySeconds: 300,
};

function adapter(patch: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    capability: {
      accepted_mime_types: [],
      analytics: true,
      asset_types: [],
      comments: true,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: [],
      notes: [],
      platform: "threads",
      publish: false,
      reply: false,
    },
    listAnalytics: async () => ({ items: [] }),
    listComments: async () => ({ items: [] }),
    refreshAccessToken: async () => ({
      accessToken: "access-new",
      expiresAt: "2026-09-19T12:00:00Z",
      scopes: ["threads_basic"],
    }),
    retryPolicy,
    transferModes: [],
    ...patch,
  };
}

function registry(value: ProviderAdapter): ProviderRegistry {
  const result = new ProviderRegistry();
  result.register("threads", value);
  return result;
}

const readTarget = {
  connectionStatus: "connected",
  cursor: null,
  platform: "threads" as const,
  providerAccountId: "account-1",
  providerPostId: "post-1",
  storedAccessToken: "encrypted-access",
  tokenExpiresAt: new Date("2026-08-01T00:00:00Z"),
};

describe("provider synchronization execution", () => {
  it("normalizes analytics and keeps credentials outside the page request", async () => {
    const listAnalytics = vi.fn(async () => ({
      items: [
        {
          comments: 3,
          impressions: 0,
          likes: 7,
          providerPostId: "post-1",
          reach: 0,
          recordedAt: "2026-07-19T11:55:00Z",
          shares: 2,
          views: 40,
          watchTimeSeconds: 0,
        },
      ],
    }));
    const result = await runProviderProgram(
      executeProviderAnalyticsEffect,
      registry(adapter({ listAnalytics })),
      context,
      readTarget,
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(listAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      { accessToken: "provider-access", accountId: "account-1" },
      { providerPostId: "post-1" },
      { limit: 100 },
    );
    expect(result).toMatchObject({
      outcome: "success",
      page: { items: [{ views: 40, likes: 7 }] },
    });
  });

  it("rejects malformed metrics before persistence", async () => {
    const result = await runProviderProgram(
      executeProviderAnalyticsEffect,
      registry(
        adapter({
          listAnalytics: async () => ({
            items: [
              {
                comments: 0,
                impressions: 0,
                likes: -1,
                providerPostId: "post-1",
                reach: 0,
                recordedAt: "2026-07-19T11:55:00Z",
                shares: 0,
                views: 0,
                watchTimeSeconds: 0,
              },
            ],
          }),
        }),
      ),
      context,
      readTarget,
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(result).toMatchObject({
      failure: {
        classification: "transient",
        code: "provider_analytics_invalid_response",
      },
      outcome: "failure",
    });
  });

  it("normalizes comment cursors and removes avatar URL secrets", async () => {
    const result = await runProviderProgram(
      executeProviderCommentsEffect,
      registry(
        adapter({
          listComments: async () => ({
            items: [
              {
                authorAvatarUrl: "https://images.example/avatar.png?signature=private#fragment",
                authorDisplayName: "Viewer",
                body: "A useful comment",
                commentedAt: "2026-07-19T11:50:00Z",
                providerCommentId: "comment-1",
                providerPostId: "post-1",
              },
            ],
            nextCursor: "cursor-next",
          }),
        }),
      ),
      context,
      { ...readTarget, cursor: "cursor-current" },
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(result).toMatchObject({
      outcome: "success",
      page: {
        items: [
          {
            authorAvatarUrl: "https://images.example/avatar.png",
            providerCommentId: "comment-1",
          },
        ],
        nextCursor: "cursor-next",
      },
    });
  });

  it("normalizes provider auth failures for token refresh", async () => {
    const refreshAccessToken = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "invalid_grant", status: 401 }),
      );
    });
    const result = await runProviderProgram(
      executeProviderTokenRefreshEffect,
      registry(adapter({ refreshAccessToken })),
      context,
      {
        platform: "threads",
        storedAccessToken: "encrypted-access",
        storedRefreshToken: "encrypted-refresh",
      },
      { decryptToken: async (value) => `decrypted:${value}` },
      now,
    );

    expect(refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      "decrypted:encrypted-refresh",
    );
    expect(result).toMatchObject({
      failure: {
        classification: "auth",
        code: "invalid_grant",
        retryable: false,
      },
      outcome: "failure",
    });
  });

  it("fails closed before decrypting when a capability is unavailable", async () => {
    const decryptToken = vi.fn(async () => "provider-access");
    const result = await runProviderProgram(
      executeProviderAnalyticsEffect,
      new ProviderRegistry(),
      context,
      readTarget,
      { decryptToken },
      now,
    );

    expect(result).toMatchObject({
      failure: { code: "provider_analytics_unavailable", retryable: false },
      outcome: "failure",
    });
    expect(decryptToken).not.toHaveBeenCalled();
  });

  it("maps unexpected listAnalytics throws to transient provider_analytics_failed", async () => {
    const listAnalytics = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runProviderProgram(
      executeProviderAnalyticsEffect,
      registry(adapter({ listAnalytics })),
      context,
      readTarget,
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(result).toEqual({
      failure: {
        classification: "transient",
        code: "provider_analytics_failed",
        message: "The provider is temporarily unavailable.",
        retryable: true,
      },
      outcome: "failure",
      retryPolicy,
    });
  });

  it("preserves structured provider adapter failures for analytics", async () => {
    const listAnalytics = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "token_revoked", status: 401 }),
      );
    });
    const result = await runProviderProgram(
      executeProviderAnalyticsEffect,
      registry(adapter({ listAnalytics })),
      context,
      readTarget,
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(result).toEqual({
      failure: {
        classification: "auth",
        code: "token_revoked",
        message: "The provider authorization must be refreshed.",
        retryable: false,
      },
      outcome: "failure",
      retryPolicy,
    });
  });

  it("maps unexpected listComments throws to transient provider_comments_failed", async () => {
    const listComments = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runProviderProgram(
      executeProviderCommentsEffect,
      registry(adapter({ listComments })),
      context,
      { ...readTarget, cursor: "cursor-current" },
      { decryptToken: async () => "provider-access" },
      now,
    );

    expect(result).toEqual({
      failure: {
        classification: "transient",
        code: "provider_comments_failed",
        message: "The provider is temporarily unavailable.",
        retryable: true,
      },
      outcome: "failure",
      retryPolicy,
    });
  });

  it("maps unexpected refreshAccessToken throws to transient provider_token_refresh_failed", async () => {
    const refreshAccessToken = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runProviderProgram(
      executeProviderTokenRefreshEffect,
      registry(adapter({ refreshAccessToken })),
      context,
      {
        platform: "threads",
        storedAccessToken: "encrypted-access",
        storedRefreshToken: "encrypted-refresh",
      },
      { decryptToken: async (value) => `decrypted:${value}` },
      now,
    );

    expect(result).toEqual({
      failure: {
        classification: "transient",
        code: "provider_token_refresh_failed",
        message: "The provider is temporarily unavailable.",
        retryable: true,
      },
      outcome: "failure",
      retryPolicy,
    });
  });
});

const refreshAccountId = "00000000-0000-4000-8000-000000000201";
const refreshEventId = "00000000-0000-4000-8000-000000000301";

function refreshMessage() {
  return {
    event_id: refreshEventId,
    request_id: "request-redelivery",
    target_id: refreshAccountId,
    type: "provider.sync",
    version: 1,
    workload: "token_refresh",
  } as const;
}

function tokenRefreshRow(): Record<string, unknown> {
  return {
    access_token: "encrypted-access",
    attempt_count: 0,
    event_id: refreshEventId,
    id: refreshAccountId,
    platform: "threads",
    refresh_token: "encrypted-refresh",
    scopes: ["threads_basic"],
    token_expires_at: "2026-08-01T00:00:00Z",
  };
}

/**
 * QueuePublisher layer for provider-sync programs under test: messages whose
 * processing never reaches a queue send still declare the service requirement.
 */
const queuePublisherLayer = createQueuePublisherTest({
  sendBatch: () => Effect.void,
});

function tokenRefreshHarness() {
  // The claim row exists until its delivery checkpoints; recording success or
  // failure clears token_refresh_event_id, so a redelivery of the same event
  // key finds no claim and must no-op.
  let claim: Record<string, unknown> | undefined = tokenRefreshRow();
  const updates: Array<[string, readonly unknown[] | undefined]> = [];
  const query = vi.fn((sql: string, values?: readonly unknown[]) => {
    if (sql.includes("FROM platform_accounts")) {
      const rows = claim ? [claim] : [];
      claim = undefined;
      return Effect.succeed({ rowCount: rows.length, rows });
    }
    updates.push([sql, values]);
    return Effect.succeed({ rowCount: 1, rows: [] });
  });
  const transactionMock = vi.fn(
    <T>(
      _env: AutomationEnv,
      operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
    ): Effect.Effect<T, unknown> => operation({ query } as unknown as EffectTransactionClient),
  );
  const transaction = transactionMock as unknown as NonNullable<
    ProviderSyncProcessingDependencies["transaction"]
  >;
  const env = {
    ENVIRONMENT: "test",
    // Exactly 32 UTF-8 bytes so TokenCipher accepts it as raw key material.
    TOKEN_ENCRYPTION_KEY: "0".repeat(32),
    VERSION: "test",
  } as AutomationEnv;
  return { env, transaction, updates };
}

describe("redelivered provider sync messages", () => {
  it("performs no second token refresh when the same event key is redelivered", async () => {
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-rotated",
      expiresAt: "2026-09-19T12:00:00Z",
      scopes: ["threads_basic"],
    }));
    const { env, transaction, updates } = tokenRefreshHarness();
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("skipped");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    const rotations = updates.filter(
      ([sql]) => sql.includes("SET access_token") && sql.includes("refresh_token"),
    );
    expect(rotations).toHaveLength(1);
  });

  it("does not transition the account again when a failed refresh is redelivered", async () => {
    const refreshAccessToken = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "invalid_grant", status: 401 }),
      );
    });
    const { env, transaction, updates } = tokenRefreshHarness();
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("skipped");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(updates.filter(([sql]) => sql.includes("connection_status = CASE"))).toHaveLength(1);
  });

  it("schedules another due-work attempt when token refresh throws an unexpected error", async () => {
    const refreshAccessToken = vi.fn(async () => {
      throw new Error("boom");
    });
    const { env, transaction, updates } = tokenRefreshHarness();
    const sendTrigger = vi.fn(async () => {});
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      sendTrigger,
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sendTrigger).toHaveBeenCalledWith(
      "token_refresh",
      refreshAccountId,
      expect.any(String),
      expect.any(Number),
    );
    const failureUpdates = updates.filter(([sql]) => sql.includes("token_refresh_last_error = $7"));
    expect(failureUpdates).toHaveLength(1);
    const [, values] = failureUpdates[0]!;
    expect(values?.[2]).toBe(false);
    expect(values?.[5]).toBeGreaterThan(0);
    expect(values?.[6]).toBe("transient:provider_token_refresh_failed");
    expect(values?.[7]).toEqual(expect.any(String));
  });

  it("transitions finite token expiry to NULL and unschedules refresh when refresh response omits expiresAt", async () => {
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-rotated",
      scopes: ["threads_basic"],
    }));
    const { env, transaction, updates } = tokenRefreshHarness();
    const sendTrigger = vi.fn(async () => {});
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      sendTrigger,
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sendTrigger).not.toHaveBeenCalled();

    const rotations = updates.filter(
      ([sql]) => sql.includes("SET access_token") && sql.includes("refresh_token"),
    );
    expect(rotations).toHaveLength(1);
    const [, values] = rotations[0]!;
    expect(values?.[4]).toBeNull();
    expect(values?.[6]).toBe("2026-08-01T00:00:00Z");
    expect(values?.[7]).toBeNull();
    expect(values?.[8]).toBeNull();
  });

  it("rejects token refresh with malformed expiresAt without updating credentials", async () => {
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-rotated",
      expiresAt: "malformed-expiry",
      scopes: ["threads_basic"],
    }));
    const { env, transaction, updates } = tokenRefreshHarness();
    const sendTrigger = vi.fn(async () => {});
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      sendTrigger,
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    const rotations = updates.filter(
      ([sql]) => sql.includes("SET access_token") && sql.includes("refresh_token"),
    );
    expect(rotations).toHaveLength(0);

    const failureUpdates = updates.filter(([sql]) => sql.includes("token_refresh_last_error = $7"));
    expect(failureUpdates).toHaveLength(1);
    const [, values] = failureUpdates[0]!;
    expect(values?.[6]).toBe("transient:provider_token_invalid_response");
  });

  it("rejects token refresh with past expiresAt without updating credentials", async () => {
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-rotated",
      expiresAt: "2026-01-01T00:00:00Z",
      scopes: ["threads_basic"],
    }));
    const { env, transaction, updates } = tokenRefreshHarness();
    const sendTrigger = vi.fn(async () => {});
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      now: () => now,
      providerRegistry: registry(adapter({ refreshAccessToken })),
      sendTrigger,
      transaction,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(env, refreshMessage(), dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    const rotations = updates.filter(
      ([sql]) => sql.includes("SET access_token") && sql.includes("refresh_token"),
    );
    expect(rotations).toHaveLength(0);

    const failureUpdates = updates.filter(([sql]) => sql.includes("token_refresh_last_error = $7"));
    expect(failureUpdates).toHaveLength(1);
    const [, values] = failureUpdates[0]!;
    expect(values?.[6]).toBe("transient:provider_token_invalid_response");
  });
});
