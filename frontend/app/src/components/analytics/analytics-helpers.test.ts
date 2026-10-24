import { describe, expect, it } from "vite-plus/test";

import {
  ANALYTICS_MAX_LIMIT,
  analyticsRowMetricState,
  formatAnalyticsInteger,
  formatAnalyticsRelativeTime,
  formatAnalyticsSearchParams,
  isAnalyticsStale,
  nextAnalyticsLimit,
  parseAnalyticsSearchParams,
  resolveAnalyticsEmptyState,
} from "./analytics-helpers";
import type { AnalyticsSummary, PlatformMetrics } from "@/types";

function summary(overrides: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    by_platform: [],
    last_synced_at: null,
    partial: false,
    range: { end: "2026-10-31T00:00:00Z", start: "2026-10-01T00:00:00Z" },
    totals: {
      comments: 0,
      impressions: 0,
      likes: 0,
      post_count: 0,
      reach: 0,
      shares: 0,
      views: 0,
      watch_time_sec: 0,
    },
    unsupported_platforms: [],
    ...overrides,
  };
}

function platformRow(overrides: Partial<PlatformMetrics> = {}): PlatformMetrics {
  return {
    comments: 0,
    impressions: 0,
    last_synced_at: "2026-10-30T00:00:00Z",
    likes: 0,
    platform: "instagram",
    post_count: 1,
    reach: 0,
    shares: 0,
    views: 10,
    watch_time_sec: 0,
    ...overrides,
  };
}

describe("analytics URL state", () => {
  it("parses supported values and falls back without throwing", () => {
    const platforms = ["instagram", "threads"] as const;
    expect(
      parseAnalyticsSearchParams(
        new URLSearchParams("range=7d&metric=shares&platform=threads"),
        platforms,
      ),
    ).toEqual({
      metric: "shares",
      platform: "threads",
      range: "7d",
    });
    expect(
      parseAnalyticsSearchParams(
        new URLSearchParams("range=year&metric=reach&platform=tiktok"),
        platforms,
      ),
    ).toEqual({
      accountId: undefined,
      format: undefined,
      metric: "views",
      platform: undefined,
      range: "30d",
    });
  });

  it("serializes only shareable state, omitting the aggregate platform", () => {
    expect(
      formatAnalyticsSearchParams({ metric: "likes", platform: "instagram", range: "90d" }),
    ).toBe("metric=likes&range=90d&platform=instagram");
    expect(formatAnalyticsSearchParams({ metric: "views", range: "30d" })).toBe(
      "metric=views&range=30d",
    );
  });
});

describe("analytics pagination and row honesty", () => {
  it("raises the top-N window by ten up to the page maximum", () => {
    expect(nextAnalyticsLimit(10)).toBe(20);
    expect(nextAnalyticsLimit(40)).toBe(ANALYTICS_MAX_LIMIT);
    expect(nextAnalyticsLimit(ANALYTICS_MAX_LIMIT)).toBe(ANALYTICS_MAX_LIMIT);
  });

  it("never reports an unsupported or unsynced row as measured", () => {
    expect(
      analyticsRowMetricState({
        last_synced_at: null,
        platforms: ["tiktok"],
        unsupported_platforms: ["tiktok"],
      }),
    ).toBe("unsupported");
    expect(
      analyticsRowMetricState({
        last_synced_at: null,
        platforms: ["instagram"],
        unsupported_platforms: [],
      }),
    ).toBe("awaiting-sync");
    expect(
      analyticsRowMetricState({
        last_synced_at: "2026-10-30T00:00:00Z",
        platforms: ["instagram", "tiktok"],
        unsupported_platforms: ["tiktok"],
      }),
    ).toBe("partial");
    expect(
      analyticsRowMetricState({
        last_synced_at: "2026-10-30T00:00:00Z",
        platforms: ["instagram"],
        unsupported_platforms: [],
      }),
    ).toBe("measured");
  });

  it("selects distinct cohort empty states", () => {
    expect(resolveAnalyticsEmptyState(summary())).toBe("no-posts");
    expect(
      resolveAnalyticsEmptyState(
        summary({
          by_platform: [platformRow({ last_synced_at: null, platform: "youtube", post_count: 2 })],
          partial: true,
          totals: { ...summary().totals, post_count: 2 },
          unsupported_platforms: ["youtube"],
        }),
      ),
    ).toBe("all-unsupported");
    expect(
      resolveAnalyticsEmptyState(
        summary({
          by_platform: [platformRow({ last_synced_at: null })],
          totals: { ...summary().totals, post_count: 1 },
        }),
      ),
    ).toBe("awaiting-sync");
    expect(
      resolveAnalyticsEmptyState(
        summary({
          by_platform: [platformRow()],
          totals: { ...summary().totals, post_count: 1 },
        }),
      ),
    ).toBeNull();
  });
});

describe("analytics freshness and formatting", () => {
  it("warns only after the 26-hour sync margin", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(isAnalyticsStale("2026-10-20T12:00:00Z", now)).toBe(false);
    expect(isAnalyticsStale("2026-10-19T10:00:00Z", now)).toBe(false);
    expect(isAnalyticsStale("2026-10-19T09:59:59Z", now)).toBe(true);
    expect(isAnalyticsStale(null, now)).toBe(false);
  });

  it("formats exact integers and relative publication times", () => {
    expect(formatAnalyticsInteger(1234567)).toBe("1,234,567");
    expect(
      formatAnalyticsRelativeTime("2026-10-18T12:00:00Z", "en", Date.parse("2026-10-20T12:00:00Z")),
    ).toBe("2 days ago");
  });
});
