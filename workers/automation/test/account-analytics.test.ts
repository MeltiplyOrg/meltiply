import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { sweepAccountAnalytics } from "../src/account-analytics";
import { RetryableJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { tokenCipherFor } from "../src/provider-credentials";
import { fakeProviderAdapter, fakeSystemTransaction } from "./test-doubles";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails the job channel when the candidate query fails instead of reporting an empty sweep", async () => {
    withSystemTransactionEffect.mockImplementation(
      fakeSystemTransaction(() =>
        Effect.fail(new DatabaseError({ message: "candidate claim query failed" })),
      ),
    );
    const registry = analyticsRegistry(async () => ({
      followers: 1,
      recordedAt: new Date().toISOString(),
    }));

    const error = await Effect.runPromise(
      Effect.flip(sweepAccountAnalytics(env, { providerRegistry: registry })),
    );

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error.message).toBe("candidate claim query failed");
  });

  it("reports an empty result when the sweep legitimately scans nothing", async () => {
    withSystemTransactionEffect.mockImplementation(
      fakeSystemTransaction(() => Effect.succeed({ rows: [] })),
    );
    const registry = analyticsRegistry(async () => ({
      followers: 1,
      recordedAt: new Date().toISOString(),
    }));

    await expect(
      Effect.runPromise(sweepAccountAnalytics(env, { providerRegistry: registry })),
    ).resolves.toEqual({ failed: 0, recorded: 0, scanned: 0 });

    await expect(
      Effect.runPromise(sweepAccountAnalytics(env, { providerRegistry: new ProviderRegistry() })),
    ).resolves.toEqual({ failed: 0, recorded: 0, scanned: 0 });
  });

  it("keeps per-account provider failures as counts while recording the rest", async () => {
    const storedToken = await tokenCipherFor(env).encrypt("account-analytics-unit-token");
    const row = (id: string, accountId: string) => ({
      access_token: storedToken,
      connection_status: "connected",
      id,
      org_id: "9b000000-0000-4000-8000-000000000001",
      platform: "threads",
      platform_user_id: accountId,
      token_expires_at: null,
    });
    const inserts: Array<readonly unknown[]> = [];
    withSystemTransactionEffect.mockImplementation(
      fakeSystemTransaction((text, values) => {
        if (text.includes("WITH candidates AS")) {
          return Effect.succeed({
            rows: [row("row-failed", "account-failed"), row("row-recorded", "account-recorded")],
          });
        }
        if (text.includes("INSERT INTO platform_account_snapshots")) {
          inserts.push(values ?? []);
          return Effect.succeed({ rows: [] });
        }
        return Effect.succeed({ rows: [] });
      }),
    );
    const registry = analyticsRegistry(async (_context, credentials) => {
      if (credentials.accountId === "account-failed") {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "permission_denied", status: 403 }),
        );
      }
      return { followers: 42, recordedAt: new Date().toISOString() };
    });

    await expect(
      Effect.runPromise(sweepAccountAnalytics(env, { providerRegistry: registry })),
    ).resolves.toEqual({ failed: 1, recorded: 1, scanned: 2 });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[0]).toBe("row-recorded");
  });
});
