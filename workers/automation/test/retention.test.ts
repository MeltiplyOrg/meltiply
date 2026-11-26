import type { EffectTransactionClient } from "@meltiply/database";
import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as ObjectCleanupModule from "../src/object-cleanup";
import { fakeTransactionClient } from "./test-doubles";

const { withSystemTransactionEffect, claimObjectsForDeletion, settleDeletedObjects } = vi.hoisted(
  () => ({
    withSystemTransactionEffect: vi.fn(),
    claimObjectsForDeletion: vi.fn(),
    settleDeletedObjects: vi.fn(),
  }),
);

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));
vi.mock("../src/object-cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof ObjectCleanupModule>()),
  claimObjectsForDeletion,
  settleDeletedObjects,
}));

import type { AutomationEnv } from "../src/env";
import { runRetention } from "../src/retention";

const env = {
  ENVIRONMENT: "test",
  VERSION: "retention-unit-test",
} as AutomationEnv;

describe("retention cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) => operation(fakeTransactionClient(() => Effect.succeed({ rowCount: 2, rows: [] }))),
    );
    claimObjectsForDeletion.mockImplementation(() => Effect.succeed([]));
    settleDeletedObjects.mockImplementation(() => Effect.void);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects out-of-range batch sizes without opening a transaction", async () => {
    for (const batchSize of [0, 5_001, 1.5]) {
      await expect(Effect.runPromise(runRetention(env, { batchSize }))).rejects.toThrow(
        "retention batch size",
      );
    }
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("counts only the failing cleanup and still sweeps the rest", async () => {
    const statements: string[] = [];
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient((statement: string) => {
            statements.push(statement);
            if (statement.includes("idempotency_keys")) {
              return Effect.fail(new DatabaseError({ message: "database unavailable" }));
            }
            const deletion = statement.includes("DELETE FROM");
            return Effect.succeed({ rowCount: deletion ? 2 : 0, rows: [] });
          }),
        ),
    );

    const result = await Effect.runPromise(runRetention(env, { batchSize: 10 }));

    const issued = statements.filter((statement) => statement.includes("DELETE FROM"));
    const failed = issued.filter((statement) => statement.includes("idempotency_keys"));
    expect(failed).toHaveLength(1);
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe((issued.length - failed.length) * 2);
    expect(statements.some((statement) => statement.includes("brand_profiles AS profile"))).toBe(
      true,
    );
  });

  it("purges owed bytes through the configured object storage provider", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient((statement: string) =>
            Effect.succeed(
              statement.includes("SELECT profile.id")
                ? { rowCount: 1, rows: [{ id: "profile-1" }] }
                : statement.includes("DELETE FROM brand_profiles")
                  ? { rowCount: 1, rows: [] }
                  : { rowCount: 0, rows: [] },
            ),
          ),
        ),
    );
    claimObjectsForDeletion.mockImplementation(() =>
      Effect.succeed([
        { brand_profile_id: "profile-1", id: "object-1", r2_key: "org/asset/original" },
      ]),
    );

    const result = await Effect.runPromise(
      runRetention(
        {
          ...env,
          OBJECT_STORAGE_PROVIDER: "s3",
          S3_ACCESS_KEY_ID: "s3-access-key",
          S3_BUCKET: "meltiply-assets",
          S3_ENDPOINT: "https://objects.example.test",
          S3_SECRET_ACCESS_KEY: "s3-secret",
        },
        { batchSize: 10 },
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://objects.example.test/meltiply-assets/org/asset/original",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(settleDeletedObjects).toHaveBeenCalledWith(expect.anything(), [{ id: "object-1" }]);
    expect(result.errors).toBe(0);
  });
});
