import type { EffectTransactionClient } from "@meltiply/database";
import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import type { AutomationEnv } from "../src/env";
import { reconcileDueUsage, reconcileDueUsageEffect } from "../src/usage";
import { fakeTransactionClient } from "./test-doubles";

const env: AutomationEnv = { ENVIRONMENT: "test", VERSION: "test" };
const now = new Date("2026-08-15T12:00:00Z");

describe("usage reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects out-of-range batch limits and invalid dates", async () => {
    await expect(reconcileDueUsage(env, { batchLimit: 0, now })).rejects.toThrow(
      "usage reconciliation batch limit must be 1 to 100",
    );
    await expect(reconcileDueUsage(env, { batchLimit: 101, now })).rejects.toThrow(
      "usage reconciliation batch limit must be 1 to 100",
    );
    await expect(reconcileDueUsage(env, { now: new Date("invalid") })).rejects.toThrow(
      "usage reconciliation time must be valid",
    );
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("reconciles organizations, records corrections, and backs off failures", async () => {
    const queries: string[] = [];
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient((sql, values) => {
            queries.push(sql);
            if (sql.includes("WITH due AS")) {
              return Effect.succeed({
                rows: [
                  { consecutive_failures: 0, org_id: "org-ok" },
                  { consecutive_failures: 1, org_id: "org-fail" },
                ],
              });
            }
            if (sql.includes("INSERT INTO usage_records")) {
              if (values?.[0] === "org-fail") {
                return Effect.fail(new DatabaseError({ message: "deadlock" }));
              }
              return Effect.succeed({
                rowCount: 1,
                rows: [{ api_calls: 0, distributions: 1, storage_bytes: 100, uploads: 1 }],
              });
            }
            if (sql.includes("AS provider_operations")) {
              return Effect.succeed({
                rowCount: 1,
                rows: [
                  {
                    active_platforms: 1,
                    distributions: 2,
                    provider_operations: 3,
                    storage_bytes: 250,
                    uploads: 1,
                  },
                ],
              });
            }
            return Effect.succeed({ rowCount: 1, rows: [] });
          }),
        ),
    );

    const result = await Effect.runPromise(reconcileDueUsageEffect(env, { batchLimit: 10, now }));
    expect(result).toEqual({ claimed: 2, corrected: 1, failed: 1, reconciled: 1 });
    expect(queries.some((sql) => sql.includes("INSERT INTO usage_corrections"))).toBe(true);
    expect(queries.some((sql) => sql.includes("usage_reconciliation_failed"))).toBe(true);
  });
});
