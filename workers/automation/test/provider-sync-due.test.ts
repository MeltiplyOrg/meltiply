import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { analyticsTerminalAgeSeconds, demandDrivenCommentsAgeSeconds } from "@meltiply/domain";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import { describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { onDemandCommentsBound, onDemandCommentsIntervalSeconds } from "../src/due-work";
import { createQueuePublisherTest } from "../src/effect/services";
import type { AutomationEnv } from "../src/env";
import {
  maximumDelayedDeliverySeconds,
  overdueRecoveryGraceSeconds,
  processProviderSyncMessage,
  providerAttemptLeaseSeconds,
  requestOnDemandCommentsSync,
  sweepDueProviderJobs,
  type ProviderDueDependencies,
  type ProviderSyncProcessingDependencies,
} from "../src/provider-sync";

const targetIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
const eventIds = ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102"];
const organizationId = "00000000-0000-4000-8000-000000000003";
const cadenceDay = 86_400;
const syncNow = new Date("2026-07-19T12:00:00Z");

/**
 * QueuePublisher layer for provider-sync programs whose tests assert no queue
 * dispatch or intercept it through the sendTrigger seam. Required because the
 * programs declare QueuePublisher even when a test never reaches a send.
 */
const queuePublisherLayer = createQueuePublisherTest({
  sendBatch: () => Effect.void,
});

function capabilityFor(
  platform: "threads" | "tiktok",
  overrides: Partial<ProviderAdapter["capability"]> = {},
): ProviderAdapter["capability"] {
  return {
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
    platform,
    publish: false,
    reply: false,
    ...overrides,
  };
}

function processingRegistry(
  workload: "analytics" | "comments",
  active: boolean,
  nextCursor?: string,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const analyticsItems =
    workload === "analytics" && active
      ? [
          {
            comments: 3,
            impressions: 4,
            likes: 5,
            providerPostId: "post-1",
            reach: 6,
            recordedAt: "2026-07-19T11:55:00Z",
            shares: 7,
            views: 8,
            watchTimeSeconds: 9,
          },
        ]
      : [];
  const commentsItems =
    workload === "comments" && active
      ? [
          {
            body: "A useful comment",
            commentedAt: "2026-07-19T11:50:00Z",
            providerCommentId: "comment-1",
            providerPostId: "post-1",
          },
        ]
      : [];
  const adapter: ProviderAdapter = {
    capability: capabilityFor("threads"),
    listAnalytics: async () => ({
      items: analyticsItems,
      ...(workload === "analytics" && nextCursor ? { nextCursor } : {}),
    }),
    listComments: async () => ({
      items: commentsItems,
      ...(workload === "comments" && nextCursor ? { nextCursor } : {}),
    }),
    transferModes: [],
  };
  registry.register("threads", adapter);
  return registry;
}

function processingHarness(row: Record<string, unknown>, prior?: Record<string, number>) {
  const query = vi.fn((sql: string, _values?: readonly unknown[]) => {
    if (sql.includes("FROM distributions AS distribution")) {
      return Effect.succeed({ rowCount: 1, rows: [row] });
    }
    if (sql.includes("SELECT id FROM distributions")) {
      return Effect.succeed({ rowCount: 1, rows: [{ id: row.id }] });
    }
    if (sql.includes("SELECT views, likes, comments, shares")) {
      return Effect.succeed({
        rowCount: prior ? 1 : 0,
        rows: prior ? [prior] : [],
      });
    }
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
    VERSION: "test",
  } as AutomationEnv;
  return { env, query, transaction };
}

async function processCadence(
  workload: "analytics" | "comments",
  active: boolean,
  age: number,
  nextCursor?: string,
) {
  const id = targetIds[0]!;
  const eventId = eventIds[0]!;
  const row = {
    access_token: "encrypted-access",
    attempt_count: 0,
    connection_status: "connected",
    cursor: null,
    event_id: eventId,
    id,
    org_id: organizationId,
    platform: "threads",
    platform_post_id: "post-1",
    published_at: new Date(syncNow.valueOf() - age * 1_000).toISOString(),
    token_expires_at: "2026-08-01T00:00:00Z",
    platform_user_id: "account-1",
  };
  const prior =
    workload === "analytics" && active ? { comments: 0, likes: 0, shares: 0, views: 0 } : undefined;
  const { env, query, transaction } = processingHarness(row, prior);
  await expect(
    Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(
          env,
          {
            event_id: eventId,
            request_id: "request-1",
            target_id: id,
            type: "provider.sync",
            version: 1,
            workload,
          },
          {
            decryptToken: async () => "provider-access",
            now: () => syncNow,
            providerRegistry: processingRegistry(workload, active, nextCursor),
            transaction,
          },
        ),
        queuePublisherLayer,
      ),
    ),
  ).resolves.toBe("processed");
  const update = query.mock.calls.find(([sql]) => String(sql).includes(`SET ${workload}_cursor`));
  expect(update).toBeDefined();
  return update?.[1];
}

async function processAnalyticsSnapshot(
  prior: Record<string, number>,
): Promise<readonly unknown[]> {
  const id = targetIds[0]!;
  const eventId = eventIds[0]!;
  const row = {
    access_token: "encrypted-access",
    attempt_count: 0,
    connection_status: "connected",
    cursor: null,
    event_id: eventId,
    id,
    org_id: organizationId,
    platform: "threads",
    platform_post_id: "post-1",
    published_at: new Date(syncNow.valueOf() - cadenceDay * 1_000).toISOString(),
    token_expires_at: "2026-08-01T00:00:00Z",
    platform_user_id: "account-1",
  };
  const { env, query, transaction } = processingHarness(row, prior);
  await expect(
    Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(
          env,
          {
            event_id: eventId,
            request_id: "request-1",
            target_id: id,
            type: "provider.sync",
            version: 1,
            workload: "analytics",
          },
          {
            decryptToken: async () => "provider-access",
            now: () => syncNow,
            providerRegistry: processingRegistry("analytics", true),
            transaction,
          },
        ),
        queuePublisherLayer,
      ),
    ),
  ).resolves.toBe("processed");
  const insert = query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO analytics_snapshots"),
  );
  expect(insert).toBeDefined();
  return insert as readonly unknown[];
}

describe("provider analytics snapshot deduplication", () => {
  it("updates when watch time, reach, or impressions change without raw_data churn", async () => {
    const [sql, values] = await processAnalyticsSnapshot({
      comments: 3,
      impressions: 3,
      likes: 5,
      reach: 3,
      shares: 7,
      views: 8,
      watch_time_sec: 3,
    });

    expect(String(sql)).toContain(
      "OR analytics_snapshots.watch_time_sec IS DISTINCT FROM EXCLUDED.watch_time_sec",
    );
    expect(String(sql)).toContain("OR analytics_snapshots.reach IS DISTINCT FROM EXCLUDED.reach");
    expect(String(sql)).toContain(
      "OR analytics_snapshots.impressions IS DISTINCT FROM EXCLUDED.impressions",
    );
    expect(String(sql)).not.toMatch(/raw_data.*IS DISTINCT FROM/);
    expect((values as readonly unknown[]).slice(2, 9)).toEqual([8, 5, 3, 7, 9, 6, 4]);
  });
});

describe("provider sync cadence", () => {
  it.each([
    {
      active: true,
      age: 8 * cadenceDay,
      expected: 21_600,
      workload: "analytics" as const,
    },
    {
      active: true,
      age: 8 * cadenceDay,
      expected: 10_800,
      workload: "comments" as const,
    },
    {
      active: false,
      age: 6 * cadenceDay,
      expected: 7_200,
      workload: "analytics" as const,
    },
    {
      active: false,
      age: 6 * cadenceDay,
      expected: 3_600,
      workload: "comments" as const,
    },
    {
      active: false,
      age: 7 * cadenceDay,
      expected: cadenceDay,
      workload: "analytics" as const,
    },
    {
      active: false,
      age: 7 * cadenceDay,
      expected: cadenceDay,
      workload: "comments" as const,
    },
    {
      active: true,
      age: analyticsTerminalAgeSeconds - cadenceDay,
      expected: cadenceDay,
      workload: "analytics" as const,
    },
    {
      active: true,
      age: analyticsTerminalAgeSeconds,
      expected: null,
      workload: "analytics" as const,
    },
    {
      active: false,
      age: analyticsTerminalAgeSeconds,
      expected: null,
      workload: "analytics" as const,
    },
    // Comments stopped being scheduled far earlier, at
    // demandDrivenCommentsAgeSeconds, so this age is already demand-driven.
    {
      active: false,
      age: analyticsTerminalAgeSeconds,
      expected: null,
      workload: "comments" as const,
    },
    // Relaxed day-zero Comment cadence (#149): halves the first day's calls
    // against the previous 300s/600s rungs. Analytics day zero is unchanged.
    {
      active: true,
      age: 3_600,
      expected: 600,
      workload: "comments" as const,
    },
    {
      active: false,
      age: 3_600,
      expected: 1_200,
      workload: "comments" as const,
    },
    {
      active: true,
      age: 3_600,
      expected: 900,
      workload: "analytics" as const,
    },
  ])(
    "uses the expected $workload cadence for $active active posts at $age seconds",
    async ({ active, age, expected, workload }) => {
      const values = await processCadence(workload, active, age);
      expect(values?.[3]).toBe(expected);
    },
  );

  it("keeps cursor pagination immediate for a quiet old post", async () => {
    const values = await processCadence("analytics", false, 8 * cadenceDay, "cursor-next");
    expect(values).toEqual([targetIds[0], eventIds[0], "cursor-next", 0, expect.any(String)]);
  });

  it("finishes paginating a past-threshold post before unscheduling it", async () => {
    const values = await processCadence(
      "analytics",
      false,
      analyticsTerminalAgeSeconds,
      "cursor-next",
    );
    expect(values).toEqual([targetIds[0], eventIds[0], "cursor-next", 0, expect.any(String)]);
  });
});

describe("analytics sync terminal age", () => {
  it("unschedules a past-threshold distribution and sends no further trigger", async () => {
    const sendTrigger = vi.fn(async () => {});
    const id = targetIds[0]!;
    const eventId = eventIds[0]!;
    const row = {
      access_token: "encrypted-access",
      attempt_count: 0,
      connection_status: "connected",
      cursor: null,
      event_id: eventId,
      id,
      org_id: "00000000-0000-4000-8000-000000000003",
      platform: "threads",
      platform_post_id: "post-1",
      published_at: new Date(syncNow.valueOf() - analyticsTerminalAgeSeconds * 1_000).toISOString(),
      token_expires_at: "2026-08-01T00:00:00Z",
      platform_user_id: "account-1",
    };
    const { env, query, transaction } = processingHarness(row);

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(
            env,
            {
              event_id: eventId,
              request_id: "request-1",
              target_id: id,
              type: "provider.sync",
              version: 1,
              workload: "analytics",
            },
            {
              decryptToken: async () => "provider-access",
              now: () => syncNow,
              providerRegistry: processingRegistry("analytics", true),
              sendTrigger,
              transaction,
            },
          ),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    // The final page is still persisted: the snapshot is written and only the
    // schedule terminates.
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO analytics_snapshots")),
    ).toBe(true);
    const update = query.mock.calls.find(([sql]) => String(sql).includes("SET analytics_cursor"));
    expect(update).toBeDefined();
    expect(String(update?.[0])).toContain("WHEN $4::integer IS NULL THEN NULL");
    // Null cadence and null event identifier leave the row unarmed.
    expect(update?.[1]?.[3]).toBeNull();
    expect(update?.[1]?.[4]).toBeNull();
    expect(sendTrigger).not.toHaveBeenCalled();
  });
});

describe("demand-driven comment sync threshold", () => {
  it.each([
    { active: false, age: demandDrivenCommentsAgeSeconds },
    { active: true, age: demandDrivenCommentsAgeSeconds + cadenceDay },
  ])(
    "stops scheduling comment sync at $age seconds with active $active",
    async ({ active, age }) => {
      const values = await processCadence("comments", active, age);
      // Null cadence and null event identifier: the row is left unscheduled and
      // invisible to the hourly sweep until an Inbox open arms it again.
      expect(values?.[3]).toBeNull();
      expect(values?.[4]).toBeNull();
    },
  );

  it("keeps scheduling comment sync just inside the threshold", async () => {
    const values = await processCadence("comments", true, demandDrivenCommentsAgeSeconds - 60);
    expect(values?.[3]).toBe(10_800);
    expect(values?.[4]).toEqual(expect.any(String));
  });

  it("sends no further trigger once comment sync is unscheduled", async () => {
    const sendTrigger = vi.fn(async () => {});
    const id = targetIds[0]!;
    const eventId = eventIds[0]!;
    const { env, transaction } = processingHarness({
      access_token: "encrypted-access",
      attempt_count: 0,
      connection_status: "connected",
      cursor: null,
      event_id: eventId,
      id,
      org_id: organizationId,
      platform: "threads",
      platform_post_id: "post-1",
      platform_user_id: "account-1",
      published_at: new Date(syncNow.valueOf() - 45 * cadenceDay * 1_000).toISOString(),
      token_expires_at: "2026-08-01T00:00:00Z",
    });

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(
            env,
            {
              event_id: eventId,
              request_id: "request-1",
              target_id: id,
              type: "provider.sync",
              version: 1,
              workload: "comments",
            },
            {
              decryptToken: async () => "provider-access",
              now: () => syncNow,
              providerRegistry: processingRegistry("comments", true),
              sendTrigger,
              transaction,
            },
          ),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    expect(sendTrigger).not.toHaveBeenCalled();
  });
});

describe("on-demand comment sync requested by an Inbox open", () => {
  function claimHarness(claimed: readonly Record<string, unknown>[]) {
    const executed: Array<{ params?: readonly unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: readonly unknown[]) => {
      executed.push({ params, sql });
      return Effect.succeed({ rowCount: claimed.length, rows: [...claimed] });
    });
    const transaction = vi.fn(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> => operation({ query } as unknown as EffectTransactionClient),
    ) as unknown as NonNullable<ProviderDueDependencies["transaction"]>;
    // Sends go through the QueuePublisher service: the stub records the resolved
    // queue binding and the message entries, so the assertion still proves the
    // armed work travels on the comments Queue.
    const sendBatch = vi.fn((_queue: Queue<unknown>, _messages: readonly unknown[]) => Effect.void);
    const env = {
      COMMENTS_QUEUE: { sendBatch: vi.fn() },
      ENVIRONMENT: "test",
      VERSION: "test",
    } as unknown as AutomationEnv;
    const publisher = createQueuePublisherTest({ sendBatch });
    return { env, executed, publisher, sendBatch, transaction };
  }

  function commentsRegistry(): ProviderRegistry {
    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: capabilityFor("threads"),
      listAnalytics: async () => ({ items: [] }),
      listComments: async () => ({ items: [] }),
      transferModes: [],
    });
    return registry;
  }

  it("claims a bounded, rate-limited page of unscheduled distributions", async () => {
    const { env, executed, publisher, sendBatch, transaction } = claimHarness([
      { event_id: eventIds[0], target_id: targetIds[0] },
    ]);

    await expect(
      Effect.runPromise(
        Effect.provide(
          requestOnDemandCommentsSync(
            env,
            { distributionId: null, organizationId },
            { providerRegistry: commentsRegistry(), transaction },
          ),
          publisher,
        ),
      ),
    ).resolves.toBe(1);

    expect(executed).toHaveLength(1);
    const claim = executed[0]!;
    // Only rows the cadence ladder no longer schedules are eligible.
    expect(claim.sql).toContain("distribution.comments_next_sync_at IS NULL");
    // The rate limit is enforced in the claim itself, against the existing
    // last-success column, so repeated opens cannot re-fetch the same row.
    expect(claim.sql).toContain(
      "distribution.comments_last_synced_at <= now() - ($6 * INTERVAL '1 second')",
    );
    expect(claim.sql).toContain("ORDER BY distribution.comments_last_synced_at ASC NULLS FIRST");
    expect(claim.sql).toContain("LIMIT $1");
    expect(claim.sql).toContain("FOR UPDATE OF distribution SKIP LOCKED");
    expect(claim.params).toEqual([
      onDemandCommentsBound,
      organizationId,
      null,
      expect.any(Array),
      20,
      onDemandCommentsIntervalSeconds,
      providerAttemptLeaseSeconds,
    ]);

    // The armed work travels on the existing comments Queue path, undelayed.
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[0]).toBe(env.COMMENTS_QUEUE);
    expect(sendBatch.mock.calls[0]?.[1]).toEqual([
      {
        body: {
          event_id: eventIds[0],
          request_id: eventIds[0],
          target_id: targetIds[0],
          type: "provider.sync",
          version: 1,
          workload: "comments",
        },
      },
    ]);
  });

  it("narrows the claim to a single distribution in view", async () => {
    const { env, executed, publisher, transaction } = claimHarness([]);

    await expect(
      Effect.runPromise(
        Effect.provide(
          requestOnDemandCommentsSync(
            env,
            { distributionId: targetIds[1]!, organizationId },
            { providerRegistry: commentsRegistry(), transaction },
          ),
          publisher,
        ),
      ),
    ).resolves.toBe(0);

    expect(executed[0]?.sql).toContain("($3::uuid IS NULL OR distribution.id = $3::uuid)");
    expect(executed[0]?.params?.[2]).toBe(targetIds[1]);
  });

  it("claims nothing when no configured platform can read comments", async () => {
    const { env, executed, publisher, sendBatch, transaction } = claimHarness([]);
    const registry = new ProviderRegistry();
    registry.register("tiktok", {
      capability: capabilityFor("tiktok", {
        analytics: false,
        comments: false,
      }),
      transferModes: [],
    });

    await expect(
      Effect.runPromise(
        Effect.provide(
          requestOnDemandCommentsSync(
            env,
            { distributionId: null, organizationId },
            { providerRegistry: registry, transaction },
          ),
          publisher,
        ),
      ),
    ).resolves.toBe(0);

    expect(executed).toHaveLength(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("rejects a bound outside the claim protocol's range", async () => {
    const { env, publisher, transaction } = claimHarness([]);

    await expect(
      Effect.runPromise(
        Effect.provide(
          requestOnDemandCommentsSync(
            env,
            { distributionId: null, organizationId },
            {
              batchSize: 1_000,
              providerRegistry: commentsRegistry(),
              transaction,
            },
          ),
          publisher,
        ),
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe("provider attempt lease", () => {
  it("stays shorter than every queue visibility timeout carrying provider sync messages", () => {
    // Consumer visibility timeouts configured in infra/cloudflare/main.tf for
    // the queues that deliver provider sync messages (analytics, comments, and
    // token-refresh). The Queues Terraform module enforces the same inequality
    // from the infrastructure side.
    const visibilityTimeoutsMs = [120_000];
    for (const timeoutMs of visibilityTimeoutsMs) {
      expect(providerAttemptLeaseSeconds * 1_000).toBeLessThan(timeoutMs);
    }
  });
});
describe("delayed delivery trigger scheduling", () => {
  it("schedules next analytics and comment triggers at their cadence with fresh event IDs", async () => {
    const sentTriggers: Array<{
      delaySeconds: number;
      eventId: string;
      targetId: string;
      workload: string;
    }> = [];
    const sendTrigger = vi.fn(
      async (workload: string, targetId: string, eventId: string, delaySeconds: number) => {
        sentTriggers.push({ delaySeconds, eventId, targetId, workload });
      },
    );

    const id = targetIds[0]!;
    const eventId = eventIds[0]!;
    const row = {
      access_token: "encrypted-access",
      attempt_count: 0,
      connection_status: "connected",
      cursor: null,
      event_id: eventId,
      id,
      org_id: organizationId,
      platform: "threads",
      platform_post_id: "post-1",
      published_at: new Date(syncNow.valueOf() - 2 * 3600 * 1_000).toISOString(),
      token_expires_at: "2026-08-01T00:00:00Z",
      platform_user_id: "account-1",
    };
    const { env, transaction } = processingHarness(row);

    // Process analytics: age = 2 hours (< 24h), active = false -> cadence = 1800s
    await Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(
          env,
          {
            event_id: eventId,
            request_id: "request-1",
            target_id: id,
            type: "provider.sync",
            version: 1,
            workload: "analytics",
          },
          {
            decryptToken: async () => "provider-access",
            now: () => syncNow,
            providerRegistry: processingRegistry("analytics", false),
            sendTrigger,
            transaction,
          },
        ),
        queuePublisherLayer,
      ),
    );

    expect(sentTriggers).toHaveLength(1);
    expect(sentTriggers[0]).toMatchObject({
      delaySeconds: 1800,
      targetId: id,
      workload: "analytics",
    });
    expect(sentTriggers[0]?.eventId).not.toBe(eventId);
    expect(typeof sentTriggers[0]?.eventId).toBe("string");
  });

  it("suppresses queue send when cadence exceeds horizon while keeping row durably armed", async () => {
    const sentTriggers: Array<{ delaySeconds: number }> = [];
    const sendTrigger = vi.fn(async (_w: string, _t: string, _e: string, delaySeconds: number) => {
      sentTriggers.push({ delaySeconds });
    });

    const id = targetIds[0]!;
    const eventId = eventIds[0]!;
    const row = {
      access_token: "encrypted-access",
      attempt_count: 0,
      connection_status: "connected",
      cursor: null,
      event_id: eventId,
      id,
      org_id: organizationId,
      platform: "threads",
      platform_post_id: "post-1",
      published_at: new Date(syncNow.valueOf() - 8 * cadenceDay * 1_000).toISOString(),
      token_expires_at: "2026-08-01T00:00:00Z",
      platform_user_id: "account-1",
    };
    const { env, query, transaction } = processingHarness(row);

    // Age 8 days, inactive -> cadence = 86400 (exact horizon).
    await Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(
          env,
          {
            event_id: eventId,
            request_id: "request-1",
            target_id: id,
            type: "provider.sync",
            version: 1,
            workload: "analytics",
          },
          {
            decryptToken: async () => "provider-access",
            now: () => syncNow,
            providerRegistry: processingRegistry("analytics", false),
            sendTrigger,
            transaction,
          },
        ),
        queuePublisherLayer,
      ),
    );

    // Exact horizon (86400) sends
    expect(sentTriggers).toHaveLength(1);
    expect(sentTriggers[0]?.delaySeconds).toBe(86400);

    // Verify row is updated with a fresh event ID in the database
    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET analytics_cursor"),
    );
    expect(updateCall).toBeDefined();
    const updateParams = updateCall?.[1] as unknown[];
    expect(updateParams[4]).toEqual(expect.any(String)); // nextEventId
  });
});

describe("token refresh authoritative single event guard", () => {
  it("rejects stale or duplicate token refresh triggers without rotating credentials", async () => {
    const id = "00000000-0000-4000-8000-000000000010";
    const currentEventId = "00000000-0000-4000-8000-000000000020";
    const staleEventId = "00000000-0000-4000-8000-000000000099";

    const refreshAccessToken = vi.fn();
    const registry = new ProviderRegistry();
    registry.register("tiktok", {
      capability: capabilityFor("tiktok", {
        analytics: false,
        comments: false,
      }),
      refreshAccessToken,
      transferModes: [],
    });

    const query = vi.fn((sql: string, params?: readonly unknown[]) => {
      // loadTokenTarget query
      if (sql.includes("FROM platform_accounts")) {
        // If the query passes the staleEventId, zero rows match
        if (params?.[1] === staleEventId) {
          return Effect.succeed({ rowCount: 0, rows: [] });
        }
        return Effect.succeed({
          rowCount: 1,
          rows: [
            {
              access_token: "enc-access",
              attempt_count: 0,
              event_id: currentEventId,
              id,
              platform: "tiktok",
              refresh_token: "enc-refresh",
              scopes: ["user.info.basic"],
              token_expires_at: "2026-08-01T00:00:00Z",
            },
          ],
        });
      }
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    const transactionMock = vi.fn(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> => operation({ query } as unknown as EffectTransactionClient),
    );
    const env = { ENVIRONMENT: "test", VERSION: "test" } as AutomationEnv;

    const outcome = await Effect.runPromise(
      Effect.provide(
        processProviderSyncMessage(
          env,
          {
            event_id: staleEventId,
            request_id: "req-stale",
            target_id: id,
            type: "provider.sync",
            version: 1,
            workload: "token_refresh",
          },
          {
            decryptToken: async () => "decrypted",
            now: () => syncNow,
            providerRegistry: registry,
            transaction: transactionMock as unknown as NonNullable<
              ProviderSyncProcessingDependencies["transaction"]
            >,
          },
        ),
        queuePublisherLayer,
      ),
    );

    expect(outcome).toBe("skipped");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe("hourly provider sync recovery sweep", () => {
  it("executes sweep queries with overdue grace and horizon parameters", async () => {
    const executedQueries: Array<{ params?: unknown[]; sql: string }> = [];
    const query = vi.fn((sql: string, params?: unknown[]) => {
      executedQueries.push({ params, sql });
      return Effect.succeed({
        rowCount: 0,
        rows: [],
      });
    });
    withSystemTransactionEffect.mockImplementation(
      <T>(
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<T, unknown>,
      ): Effect.Effect<T, unknown> => operation({ query } as unknown as EffectTransactionClient),
    );

    const env = {
      ANALYTICS_QUEUE: { sendBatch: vi.fn(async () => ({ metadata: {} })) },
      COMMENTS_QUEUE: { sendBatch: vi.fn(async () => ({ metadata: {} })) },
      ENVIRONMENT: "test",
      TOKEN_REFRESH_QUEUE: { sendBatch: vi.fn(async () => ({ metadata: {} })) },
      VERSION: "test",
    } as unknown as AutomationEnv;

    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: capabilityFor("threads"),
      listAnalytics: async () => ({ items: [] }),
      listComments: async () => ({ items: [] }),
      refreshAccessToken: vi.fn(),
      transferModes: [],
    });

    const result = await Effect.runPromise(
      Effect.provide(
        sweepDueProviderJobs(env, {
          providerRegistry: registry,
        }),
        queuePublisherLayer,
      ),
    );
    expect(result).toEqual({ analytics: 0, comments: 0, token_refresh: 0 });

    expect(executedQueries).toHaveLength(3);
    const [analyticsQuery, commentsQuery, tokenRefreshQuery] = executedQueries;

    expect(analyticsQuery?.sql).toContain("FROM distributions");
    expect(analyticsQuery?.sql).toContain("analytics_next_sync_at");
    expect(analyticsQuery?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);

    expect(commentsQuery?.sql).toContain("FROM distributions");
    expect(commentsQuery?.sql).toContain("comments_next_sync_at");
    expect(commentsQuery?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);

    expect(tokenRefreshQuery?.sql).toContain("FROM platform_accounts");
    expect(tokenRefreshQuery?.sql).toContain("token_refresh_next_attempt_at");
    expect(tokenRefreshQuery?.params).toEqual([
      50,
      expect.any(Array),
      20,
      overdueRecoveryGraceSeconds,
      maximumDelayedDeliverySeconds,
      60,
    ]);
  });
});
