import type { AnalyticsRangePreset } from "@/types";

/**
 * Day spans for the Analytics toolbar presets. `366d` matches the API's
 * maximum cohort span, including the leap-year day.
 */
const ANALYTICS_RANGE_DAYS: Record<AnalyticsRangePreset, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "366d": 366,
};

/** Type guard accepting only the four supported range presets. */
export function isAnalyticsRangePreset(
  value: string | null | undefined,
): value is AnalyticsRangePreset {
  return value === "7d" || value === "30d" || value === "90d" || value === "366d";
}

/**
 * Computes the rolling UTC instant window for one range preset.
 *
 * The window is `now - days` through `now`, so boundaries move with the clock
 * but never depend on a workspace timezone: the page does not bucket by day.
 * `now` is injectable so tests can pin the instants.
 *
 * @param range - Supported range preset.
 * @param now - Instant treated as the range end; defaults to the current time.
 * @returns ISO-8601 `start` and `end` instants accepted by the API.
 */
export function analyticsRangeWindow(
  range: AnalyticsRangePreset,
  now: Date = new Date(),
): { end: string; start: string } {
  const end = now.getTime();
  return {
    end: new Date(end).toISOString(),
    start: new Date(end - ANALYTICS_RANGE_DAYS[range] * 24 * 60 * 60 * 1_000).toISOString(),
  };
}
