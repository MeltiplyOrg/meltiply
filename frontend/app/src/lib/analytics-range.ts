import type { AnalyticsRangePreset } from "@/types";

const ANALYTICS_RANGE_DAYS: Record<AnalyticsRangePreset, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "366d": 366,
};

export function isAnalyticsRangePreset(
  value: string | null | undefined,
): value is AnalyticsRangePreset {
  return value === "7d" || value === "30d" || value === "90d" || value === "366d";
}

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
