import { DatabaseError } from "@meltiply/domain";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { sweepAccountAnalytics } from "../src/account-analytics";
import { RetryableJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { tokenCipherFor } from "../src/provider-credentials";
import {
  createFakeAccountAnalyticsRepository,
  FakeAccountAnalyticsStore,
} from "../src/repositories/account-analytics-repository";
import { fakeProviderAdapter } from "./test-doubles";

const env: AutomationEnv = {
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "account-analytics-test",
};

function analyticsRegistry(getAccountAnalytics: ProviderAdapter["getAccountAnalytics"]) {
  const registry = new ProviderRegistry();
  registry.register("threads", fakeProviderAdapter("threads", { getAccountAnalytics }));
  return registry;
}

describe("sweepAccountAnalytics", () => {
  it("fails the job channel with RetryableJobError when candidate claim fails", async () => {
    const store = new FakeAccountAnalyticsStore();
    store.claimError = new DatabaseError({ message: "candidate claim query failed" });
    const registry = analyticsRegistry(async () => ({
      followers: 1,
      recordedAt: "2026-02-01T00:00:00.000Z",
    }));

    const error = await Effect.runPromise(
      Effect.flip(
        sweepAccountAnalytics(env, {
          providerRegistry: registry,
          repository: createFakeAccountAnalyticsRepository(store),
        }),
      ),
    );

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error.message).toEqual("candidate claim query failed");
  });

  it("returns zeroes when no platform supports account analytics", async () => {
    const store = new FakeAccountAnalyticsStore();

    expect(
      await Effect.runPromise(
        sweepAccountAnalytics(env, {
          providerRegistry: new ProviderRegistry(),
          repository: createFakeAccountAnalyticsRepository(store),
        }),
      ),
    ).toEqual({ failed: 0, recorded: 0, scanned: 0 });
  });

  it("returns zeroes when no candidates are due", async () => {
    const store = new FakeAccountAnalyticsStore();
    const registry = analyticsRegistry(async () => ({
      followers: 1,
      recordedAt: "2026-02-01T00:00:00.000Z",
    }));

    expect(
      await Effect.runPromise(
        sweepAccountAnalytics(env, {
          providerRegistry: registry,
          repository: createFakeAccountAnalyticsRepository(store),
        }),
      ),
    ).toEqual({ failed: 0, recorded: 0, scanned: 0 });
  });

  it("counts per-account provider failures while recording succeeding accounts", async () => {
    const storedToken = await tokenCipherFor(env).encrypt("account-analytics-unit-token");
    const store = new FakeAccountAnalyticsStore();
    store.candidates.push(
      {
        access_token: storedToken,
        connection_status: "connected",
        id: "row-failed",
        org_id: "9b000000-0000-4000-8000-000000000001",
        platform: "threads",
        platform_user_id: "account-failed",
        token_expires_at: null,
      },
      {
        access_token: storedToken,
        connection_status: "connected",
        id: "row-recorded",
        org_id: "9b000000-0000-4000-8000-000000000001",
        platform: "threads",
        platform_user_id: "account-recorded",
        token_expires_at: null,
      },
    );
    const registry = analyticsRegistry(async (_context, credentials) => {
      if (credentials.accountId === "account-failed") {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "permission_denied", status: 403 }),
        );
      }
      return { followers: 42, recordedAt: "2026-02-01T00:00:00.000Z" };
    });

    expect(
      await Effect.runPromise(
        sweepAccountAnalytics(env, {
          providerRegistry: registry,
          repository: createFakeAccountAnalyticsRepository(store),
        }),
      ),
    ).toEqual({ failed: 1, recorded: 1, scanned: 2 });
    expect(store.snapshots).toEqual([
      {
        capturedAt: "2026-02-01T00:00:00.000Z",
        followers: 42,
        following: null,
        orgId: "9b000000-0000-4000-8000-000000000001",
        platformAccountId: "row-recorded",
        posts: null,
      },
    ]);
  });
});
