import { describe, expect, it } from "vite-plus/test";

import {
  analyticsRowMetricState,
  formatAnalyticsCompact,
  formatAnalyticsDecimal,
  formatAnalyticsInteger,
  formatAnalyticsRelativeTime,
  formatAnalyticsSearchParams,
  formatAnalyticsTimestamp,
  formatAnalyticsWhole,
  isAnalyticsFormat,
  isAnalyticsStale,
  isCompactOnPhone,
  nextAnalyticsLimit,
  parseAnalyticsSearchParams,
  resolveAnalyticsEmptyState,
} from "./analytics-helpers";
import type { AnalyticsSummary, PlatformMetrics } from "@/types";

const ACCOUNT = "00000000-0000-4000-8000-000000000111";
const defaults = {
  accountId: undefined,
  format: undefined,
  metric: "views",
  platform: undefined,
  range: "30d",
};

describe("isAnalyticsFormat", () => {
  it.each([
    ["carousel", true],
    ["story", false],
    ["", false],
  ])("the value %j", (value, expected) => {
    expect(isAnalyticsFormat(value)).toEqual(expected);
  });
});

describe("parseAnalyticsSearchParams", () => {
  const parse = (query: string) =>
    parseAnalyticsSearchParams(new URLSearchParams(query), ["instagram", "threads"]);

  it("every supported value", () => {
    const query = `range=7d&metric=shares&platform=threads&account=${ACCOUNT}&format=video`;

    expect(parse(query)).toEqual({
      accountId: ACCOUNT,
      format: "video",
      metric: "shares",
      platform: "threads",
      range: "7d",
    });
  });

  it("no parameters", () => {
    expect(parse("")).toEqual(defaults);
  });

  it("unsupported values", () => {
    expect(parse("range=year&metric=reach&platform=tiktok&account=abc&format=story")).toEqual(
      defaults,
    );
  });

  it.each(["likes", "comments"])("the %s metric", (metric) => {
    expect(parse(`metric=${metric}`)).toEqual({ ...defaults, metric });
  });
});

describe("formatAnalyticsSearchParams", () => {
  it("only a metric and a range", () => {
    expect(formatAnalyticsSearchParams({ metric: "views", range: "30d" })).toEqual(
      "metric=views&range=30d",
    );
  });

  it("every filter", () => {
    const input = {
      accountId: ACCOUNT,
      format: "image",
      metric: "likes",
      platform: "instagram",
      range: "90d",
    } as const;

    expect(formatAnalyticsSearchParams(input)).toEqual(
      `metric=likes&range=90d&platform=instagram&account=${ACCOUNT}&format=image`,
    );
  });
});

describe("isCompactOnPhone", () => {
  it.each([
    [9_999_999, false],
    [10_000_000, true],
  ])("a total of %i", (value, compact) => {
    expect(isCompactOnPhone(value)).toEqual(compact);
  });
});

describe("nextAnalyticsLimit", () => {
  it.each([
    [10, 20],
    [40, 50],
    [45, 50],
    [50, 50],
  ])("a limit of %i", (current, next) => {
    expect(nextAnalyticsLimit(current)).toEqual(next);
  });
});

describe("analyticsRowMetricState", () => {
  const synced = "2026-10-30T00:00:00Z";

  it.each([
    ["every platform unsupported", null, ["tiktok"], ["tiktok"], "unsupported"],
    ["no sync yet", null, ["instagram"], [], "awaiting-sync"],
    ["one platform unsupported", synced, ["instagram", "tiktok"], ["tiktok"], "partial"],
    ["every platform measured", synced, ["instagram"], [], "measured"],
    ["no platforms", synced, [], [], "measured"],
  ] as const)("%s", (_example, last_synced_at, platforms, unsupported, state) => {
    const row = {
      last_synced_at,
      platforms: [...platforms],
      unsupported_platforms: [...unsupported],
    };

    expect(analyticsRowMetricState(row)).toEqual(state);
  });
});

describe("resolveAnalyticsEmptyState", () => {
  const totals = {
    comments: 0,
    impressions: 0,
    likes: 0,
    post_count: 1,
    reach: 0,
    shares: 0,
    views: 0,
    watch_time_sec: 0,
  };
  const platformRow: PlatformMetrics = {
    ...totals,
    last_synced_at: "2026-10-30T00:00:00Z",
    platform: "instagram",
  };
  const summary = (patch: Partial<AnalyticsSummary>): AnalyticsSummary => ({
    by_platform: [platformRow],
    last_synced_at: null,
    partial: false,
    range: { end: "2026-10-31T00:00:00Z", start: "2026-10-01T00:00:00Z" },
    totals,
    unsupported_platforms: [],
    ...patch,
  });

  it.each([
    ["no posts", summary({ totals: { ...totals, post_count: 0 } }), "no-posts"],
    [
      "only unsupported platforms",
      summary({ unsupported_platforms: ["instagram"] }),
      "all-unsupported",
    ],
    [
      "no platform synced",
      summary({ by_platform: [{ ...platformRow, last_synced_at: null }] }),
      "awaiting-sync",
    ],
    ["a synced platform", summary({}), null],
    ["posts without a platform breakdown", summary({ by_platform: [] }), null],
  ])("%s", (_example, input, state) => {
    expect(resolveAnalyticsEmptyState(input)).toEqual(state);
  });
});

const NOW = Date.parse("2026-10-20T12:00:00Z");

describe("isAnalyticsStale", () => {
  it.each([
    ["a sync just now", "2026-10-20T12:00:00Z", false],
    ["a sync exactly 26 hours ago", "2026-10-19T10:00:00Z", false],
    ["a sync just over 26 hours ago", "2026-10-19T09:59:59Z", true],
    ["no sync", null, false],
    ["an unreadable sync time", "yesterday", false],
  ])("%s", (_example, lastSyncedAt, stale) => {
    expect(isAnalyticsStale(lastSyncedAt, NOW)).toEqual(stale);
  });
});

describe("formatAnalyticsInteger", () => {
  it.each([
    ["en", "1,234,567"],
    ["de", "1.234.567"],
  ] as const)("a large count in %s", (language, text) => {
    expect(formatAnalyticsInteger(1234567, language)).toEqual(text);
  });

  it("a zero count in the default language", () => {
    expect(formatAnalyticsInteger(0)).toEqual("0");
  });
});

describe("formatAnalyticsDecimal", () => {
  it("a value with two decimals", () => {
    expect(formatAnalyticsDecimal(12.36)).toEqual("12.4");
  });
});

describe("formatAnalyticsWhole", () => {
  it("a value with decimals", () => {
    expect(formatAnalyticsWhole(12.5)).toEqual("13");
  });
});

describe("formatAnalyticsCompact", () => {
  it("a count in the thousands", () => {
    expect(formatAnalyticsCompact(12_345)).toEqual("12.3K");
  });
});

describe("formatAnalyticsTimestamp", () => {
  it("an instant", () => {
    expect(formatAnalyticsTimestamp("2026-10-20T12:00:00Z")).toEqual(
      expect.stringMatching(/^Oct (19|20|21), 2026, \d{1,2}:\d{2}\s(AM|PM)$/),
    );
  });

  it("text that is not an instant", () => {
    expect(formatAnalyticsTimestamp("yesterday")).toEqual("yesterday");
  });
});

describe("formatAnalyticsRelativeTime", () => {
  it.each([
    ["a year ago", "2025-10-20T12:00:00Z", "last year"],
    ["two months ago", "2026-08-21T12:00:00Z", "2 months ago"],
    ["two days ago", "2026-10-18T12:00:00Z", "2 days ago"],
    ["three hours ahead", "2026-10-20T15:00:00Z", "in 3 hours"],
    ["exactly one minute ago", "2026-10-20T11:59:00Z", "1 minute ago"],
    ["59 seconds ago", "2026-10-20T11:59:01Z", "59 seconds ago"],
    ["this instant", "2026-10-20T12:00:00Z", "now"],
    ["text that is not an instant", "yesterday", "yesterday"],
  ])("%s", (_example, iso, text) => {
    expect(formatAnalyticsRelativeTime(iso, "en", NOW)).toEqual(text);
  });

  it("two days ago in German", () => {
    expect(formatAnalyticsRelativeTime("2026-10-18T12:00:00Z", "de", NOW)).toEqual("vorgestern");
  });
});
