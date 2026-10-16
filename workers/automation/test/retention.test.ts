import type { EffectTransactionClient } from "@meltiply/database";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect, claimObjectsForDeletion, settleDeletedObjects } = vi.hoisted(
  () => ({
    withSystemTransactionEffect: vi.fn(),
    claimObjectsForDeletion: vi.fn(),
    settleDeletedObjects: vi.fn(),
  }),
);

// The sweep reaches PostgreSQL through one transaction helper and delegates
// per-object deletion to the Asset module, so both seams are stubbed here. No
// statement text is asserted: purge behavior is proven against a real database
// in retention.integration.test.ts, where the durable per-object state, the R2
// calls, and the released storage accounting are all observable.
vi.mock("../src/database", () => ({ withSystemTransactionEffect }));
vi.mock("../src/assets", () => ({
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
      ) =>
        operation({
          query: () => Effect.succeed({ rowCount: 2, rows: [] }),
        } as unknown as EffectTransactionClient),
    );
    claimObjectsForDeletion.mockImplementation(() => Effect.succeed([]));
    settleDeletedObjects.mockImplementation(() => Effect.void);
  });

  it("rejects out-of-range batch sizes without opening a transaction", async () => {
    // Caller misuse fails before any work: an invalid batch size must neither
    // delete a partial batch nor reach the database.
    for (const batchSize of [0, 5_001, 1.5]) {
      await expect(Effect.runPromise(runRetention(env, { batchSize }))).rejects.toThrow(
        "retention batch size",
      );
    }
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("counts every failing cleanup instead of aborting the daily sweep", async () => {
    // One unreachable table must not hide or cancel the remaining cleanup
    // classes: idempotency keys, webhook events, outbox events, async job
    // events, usage corrections, analytics snapshots, and due Brand Profile
    // purges each report their own failure.
    withSystemTransactionEffect.mockImplementation(() =>
      Effect.fail(new Error("database unavailable")),
    );

    const result = await Effect.runPromise(runRetention(env, { batchSize: 10 }));
    expect(result).toEqual({ deleted: 0, errors: 7 });
  });
});
