import { describe, expect, it } from "vite-plus/test";

import { analyticsRangeWindow, isAnalyticsRangePreset } from "./analytics-range";

describe("analytics range windows", () => {
  it("subtracts the preset day span from one rolling end instant", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(analyticsRangeWindow("7d", now)).toEqual({
      end: "2026-10-20T12:00:00.000Z",
      start: "2026-10-13T12:00:00.000Z",
    });
    expect(analyticsRangeWindow("366d", now)).toEqual({
      end: "2026-10-20T12:00:00.000Z",
      start: "2025-10-19T12:00:00.000Z",
    });
  });

  it("accepts only the four supported presets", () => {
    expect(isAnalyticsRangePreset("30d")).toBe(true);
    expect(isAnalyticsRangePreset("366d")).toBe(true);
    expect(isAnalyticsRangePreset("12m")).toBe(false);
    expect(isAnalyticsRangePreset(null)).toBe(false);
  });
});
