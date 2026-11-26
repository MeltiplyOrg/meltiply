import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import {
  createFakeRetentionRepository,
  FakeRetentionStore,
} from "../src/repositories/retention-repository";
import { runRetention } from "../src/retention";

const env = {
  ENVIRONMENT: "test",
  VERSION: "retention-unit-test",
} as AutomationEnv;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRetention", () => {
  it.each([0, 5_001, 1.5])("rejects out-of-range batch size %s before querying", async (size) => {
    const store = new FakeRetentionStore();

    await expect(
      Effect.runPromise(
        runRetention(env, {
          batchSize: size,
          repository: createFakeRetentionRepository(store),
        }),
      ),
    ).rejects.toThrow("retention batch size");
    expect(store.invokedSteps).toEqual([]);
  });

  it("counts a failing cleanup step while sweeping the remaining tables", async () => {
    const store = new FakeRetentionStore();
    store.failures.set("idempotency_keys", new DatabaseError({ message: "database unavailable" }));
    for (const table of [
      "webhook_events",
      "outbox_events",
      "async_job_events",
      "usage_corrections",
      "analytics_snapshots",
      "reporting_publication_daily",
    ]) {
      store.counts.set(table, 2);
    }

    const result = await Effect.runPromise(
      runRetention(env, {
        batchSize: 10,
        repository: createFakeRetentionRepository(store),
      }),
    );

    expect(result).toEqual({ deleted: 12, errors: 1 });
    expect(store.invokedSteps).toContain("brand_profiles");
  });

  it("purges owed Brand Profile objects through the configured S3 store and settles them", async () => {
    const requests: Array<{ method: string | undefined; url: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method, url: String(input) });
      return new Response(null, { status: 204 });
    });
    const store = new FakeRetentionStore();
    store.dueBrandProfileIds = ["profile-1"];
    store.claimedObjects = [
      { brand_profile_id: "profile-1", id: "object-1", r2_key: "org/asset/original" },
    ];

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
        { batchSize: 10, repository: createFakeRetentionRepository(store) },
      ),
    );

    expect(requests).toEqual([
      { method: "DELETE", url: "https://objects.example.test/meltiply-assets/org/asset/original" },
    ]);
    expect(store.settledObjectIds).toEqual(["object-1"]);
    expect(store.deletedProfileBatches).toEqual([["profile-1"]]);
    expect(result).toEqual({ deleted: 1, errors: 0 });
  });
});
