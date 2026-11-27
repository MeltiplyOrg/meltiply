import { describe, expect, it } from "vite-plus/test";

import { analyticsRangeWindow, isAnalyticsRangePreset } from "./analytics-range";

describe("analyticsRangeWindow", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");

  it.each([
    ["7d", "2026-10-13T12:00:00.000Z"],
    ["30d", "2026-09-20T12:00:00.000Z"],
    ["90d", "2026-07-22T12:00:00.000Z"],
    ["366d", "2025-10-19T12:00:00.000Z"],
  ] as const)("the %s preset", (range, start) => {
    expect(analyticsRangeWindow(range, now)).toEqual({ end: "2026-10-20T12:00:00.000Z", start });
  });
});

describe("isAnalyticsRangePreset", () => {
  it.each([
    ["the 7d preset", "7d", true],
    ["the 30d preset", "30d", true],
    ["the 90d preset", "90d", true],
    ["the 366d preset", "366d", true],
    ["another span", "12m", false],
    ["an empty string", "", false],
    ["a null value", null, false],
    ["no value", undefined, false],
  ])("%s", (_example, value, preset) => {
    expect(isAnalyticsRangePreset(value)).toEqual(preset);
  });
});
