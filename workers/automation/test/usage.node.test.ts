import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import {
  createFakeUsageReconciliationRepository,
  FakeUsageReconciliationStore,
} from "../src/repositories/usage-reconciliation-repository";
import { reconcileDueUsage, reconcileDueUsageEffect } from "../src/usage";

const env: AutomationEnv = { ENVIRONMENT: "test", VERSION: "test" };
const now = new Date("2026-08-15T12:00:00Z");

describe("reconcileDueUsage", () => {
  it.each([
    ["batch limit 0", { batchLimit: 0, now }, "usage reconciliation batch limit must be 1 to 100"],
    [
      "batch limit 101",
      { batchLimit: 101, now },
      "usage reconciliation batch limit must be 1 to 100",
    ],
    ["invalid date", { now: new Date("invalid") }, "usage reconciliation time must be valid"],
  ])("rejects %s before querying", async (_example, options, expectedMessage) => {
    const store = new FakeUsageReconciliationStore();

    await expect(
      reconcileDueUsage(env, {
        ...options,
        repository: createFakeUsageReconciliationRepository(store),
      }),
    ).rejects.toThrow(expectedMessage);
    expect(store.claimCalls).toEqual(0);
  });

  it("reconciles organizations, records corrections, and backs off failures", async () => {
    const store = new FakeUsageReconciliationStore();
    store.due.push(
      { consecutive_failures: 0, org_id: "org-ok" },
      { consecutive_failures: 1, org_id: "org-fail" },
    );
    store.priorByOrg.set("org-ok", {
      api_calls: 0,
      distributions: 1,
      storage_bytes: 100,
      uploads: 1,
    });
    store.authoritativeByOrg.set("org-ok", {
      active_platforms: 1,
      distributions: 2,
      provider_operations: 3,
      storage_bytes: 250,
      uploads: 1,
    });
    store.failOrg.set("org-fail", new DatabaseError({ message: "deadlock" }));

    const result = await Effect.runPromise(
      reconcileDueUsageEffect(env, {
        batchLimit: 10,
        now,
        repository: createFakeUsageReconciliationRepository(store),
      }),
    );

    expect(result).toEqual({ claimed: 2, corrected: 1, failed: 1, reconciled: 1 });
    expect(store.corrections).toEqual([
      {
        evidence: {
          active_platforms: 1,
          provider_operations: 3,
          source: "domain_rows_and_r2_verified_metadata",
        },
        organizationId: "org-ok",
        periodKey: "2026-08",
        prior: { api_calls: 0, distributions: 1, storage_bytes: 100, uploads: 1 },
        reconciled: { api_calls: 0, distributions: 2, storage_bytes: 250, uploads: 1 },
      },
    ]);
    expect(store.reconciledOrgs).toEqual(["org-ok"]);
    expect(store.failedReleases).toEqual([
      { consecutiveFailures: 2, orgId: "org-fail", retrySeconds: expect.any(Number) },
    ]);
  });

  it("skips recording a correction when authoritative counts already match prior counts", async () => {
    const store = new FakeUsageReconciliationStore();
    store.due.push({ consecutive_failures: 0, org_id: "org-match" });
    store.priorByOrg.set("org-match", {
      api_calls: 5,
      distributions: 2,
      storage_bytes: 250,
      uploads: 1,
    });
    store.authoritativeByOrg.set("org-match", {
      active_platforms: 1,
      distributions: 2,
      provider_operations: 3,
      storage_bytes: 250,
      uploads: 1,
    });

    const result = await Effect.runPromise(
      reconcileDueUsageEffect(env, {
        now,
        repository: createFakeUsageReconciliationRepository(store),
      }),
    );

    expect(result).toEqual({ claimed: 1, corrected: 0, failed: 0, reconciled: 1 });
    expect(store.corrections).toEqual([]);
  });
});
