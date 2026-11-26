import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ReportingConfiguration } from "../src/configuration";
import type { PreferencesRow } from "../src/policy";
import type { PublicationUsageRepository } from "../src/repository";
import type { ReportingClient } from "../src/service";
import { recordPublicationUsage } from "../src/usage";

const configured: ReportingConfiguration = {
  deploymentCategory: "selfhosted",
  destination: {
    captureUrl: "https://us.i.posthog.com/i/v0/e/",
    projectToken: "phc_testToken1234567890",
  },
  forcedOff: false,
};

const enabledPreferences: PreferencesRow = {
  diagnostics_decided_at: null,
  diagnostics_disclosure_version: null,
  diagnostics_interval_started_at: null,
  diagnostics_requested: false,
  installation_reporting_id: "inst-1",
  schema_version: 1,
  usage_decided_at: "2026-02-01T00:00:00.000Z",
  usage_disclosure_version: 1,
  usage_interval_started_at: "2026-02-01T00:00:00.000Z",
  usage_requested: true,
};

const unusedClient: ReportingClient = {
  query: () => Effect.die(new Error("Unexpected direct ReportingClient query")),
};

function fakeUsageStore(
  options: {
    clock?: Date;
    failOn?: "increment" | "mark";
    preferences?: PreferencesRow | null;
    priorPublished?: { found: boolean; publishedAt: Date | string | null };
  } = {},
) {
  const distributionMarks = new Map<string, { confirmedAt: string; platform: string }>();
  const postMarks = new Map<string, { counted: boolean; firstConfirmedAt: string }>();
  const daily = new Map<string, number>();
  let rolledBack = false;
  let released = false;

  const repository: PublicationUsageRepository = {
    beginSavepoint: () => Effect.void,
    releaseSavepoint: () =>
      Effect.sync(() => {
        released = true;
      }),
    rollbackSavepoint: () =>
      Effect.sync(() => {
        rolledBack = true;
      }),
    lockMeasurement: () => Effect.void,
    currentTime: () => Effect.sync(() => options.clock ?? new Date("2026-02-01T12:00:00.000Z")),
    markDistribution: (distributionId, platform, confirmedAt) => {
      if (options.failOn === "mark") {
        return Effect.fail(new DatabaseError({ message: "relation missing" }));
      }
      return Effect.sync(() => {
        if (distributionMarks.has(distributionId)) return false;
        distributionMarks.set(distributionId, { confirmedAt, platform });
        return true;
      });
    },
    loadPreferences: () =>
      Effect.sync(() =>
        options.preferences === undefined ? enabledPreferences : options.preferences,
      ),
    hasPostMark: (postId) => Effect.sync(() => postMarks.has(postId)),
    findPriorPublishedDistribution: () =>
      Effect.sync(() => options.priorPublished ?? { found: false, publishedAt: null }),
    insertPostMark: (postId, firstConfirmedAt, counted) =>
      Effect.sync(() => {
        if (!postMarks.has(postId)) {
          postMarks.set(postId, { counted, firstConfirmedAt });
        }
      }),
    incrementDailyDistribution: (intervalStartedAt, reportDate, platform) => {
      if (options.failOn === "increment") {
        return Effect.fail(new DatabaseError({ message: "write rejected" }));
      }
      return Effect.sync(() => {
        const key = `${intervalStartedAt}:${reportDate}:${platform}`;
        daily.set(key, (daily.get(key) ?? 0) + 1);
      });
    },
  };

  return {
    daily,
    distributionMarks,
    isReleased: () => released,
    isRolledBack: () => rolledBack,
    postMarks,
    repository,
  };
}

describe("recordPublicationUsage", () => {
  it("counts the first eligible distribution and marks the post as counted", async () => {
    const store = fakeUsageStore();

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(outcome).toEqual("counted");
    expect(store.isReleased()).toEqual(true);
    expect(store.postMarks.get("post-1")).toEqual({
      counted: true,
      firstConfirmedAt: "2026-02-01T12:00:00.000Z",
    });
    expect(store.daily.get("2026-02-01T00:00:00.000Z:2026-02-01:youtube")).toEqual(1);
  });

  it("returns already_counted on a replayed distribution without incrementing again", async () => {
    const store = fakeUsageStore();
    await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    const replay = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(replay).toEqual("already_counted");
    expect(store.daily.get("2026-02-01T00:00:00.000Z:2026-02-01:youtube")).toEqual(1);
  });

  it("marks a post once across multiple distributions while counting each distribution", async () => {
    const store = fakeUsageStore();
    await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );
    const second = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-2", platform: "tiktok", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(second).toEqual("counted");
    expect(store.postMarks.size).toEqual(1);
    expect(store.daily.get("2026-02-01T00:00:00.000Z:2026-02-01:youtube")).toEqual(1);
    expect(store.daily.get("2026-02-01T00:00:00.000Z:2026-02-01:tiktok")).toEqual(1);
  });

  it("backdates post mark to a pre-consent prior publication while counting the new distribution", async () => {
    const store = fakeUsageStore({
      priorPublished: { found: true, publishedAt: "2026-01-15T08:00:00.000Z" },
    });

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-2", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(outcome).toEqual("counted");
    expect(store.postMarks.get("post-1")).toEqual({
      counted: false,
      firstConfirmedAt: "2026-01-15T08:00:00.000Z",
    });
  });

  it("records domain marks without advancing aggregates when usage reporting is disabled", async () => {
    const store = fakeUsageStore({ preferences: null });

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(outcome).toEqual("not_counted");
    expect(store.distributionMarks.has("dist-1")).toEqual(true);
    expect(store.postMarks.get("post-1")?.counted).toEqual(false);
    expect(store.daily.size).toEqual(0);
  });

  it("returns not_counted when observation predates the enabled interval", async () => {
    const store = fakeUsageStore({ clock: new Date("2026-01-31T23:59:59.000Z") });

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(outcome).toEqual("not_counted");
    expect(store.daily.size).toEqual(0);
  });

  it("returns not_counted when the injected clock produces an invalid date", async () => {
    const store = fakeUsageStore();

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { now: () => new Date("invalid"), repository: store.repository },
      ),
    );

    expect(outcome).toEqual("not_counted");
    expect(store.distributionMarks.size).toEqual(0);
  });

  it("rolls back to the savepoint and returns unavailable when a reporting write fails", async () => {
    const store = fakeUsageStore({ failOn: "increment" });

    const outcome = await Effect.runPromise(
      recordPublicationUsage(
        unusedClient,
        { distributionId: "dist-1", platform: "youtube", postId: "post-1" },
        configured,
        { repository: store.repository },
      ),
    );

    expect(outcome).toEqual("unavailable");
    expect(store.isRolledBack()).toEqual(true);
  });
});
