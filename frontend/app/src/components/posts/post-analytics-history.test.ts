import { describe, expect, it } from "vite-plus/test";
import { postAnalyticsHistory } from "./post-analytics-history";
import type { components } from "@meltiply/contracts/schema";

/** Builds deterministic measurements; changing likes also changes the exposure counters. */
function snapshot(
  id: string,
  channel: string,
  hour: number,
  value: number,
): components["schemas"]["AnalyticsSnapshot"] {
  return {
    id,
    distribution_id: channel,
    post_id: "post",
    snapshot_at: `2026-07-01T${String(hour).padStart(2, "0")}:00:00Z`,
    likes: value,
    comments: 0,
    shares: 0,
    views: value * 10,
    reach: value * 2,
    impressions: value * 3,
    watch_time_sec: 0,
  };
}

describe("Post snapshot timelines", () => {
  it("carries asynchronous Channel measurements forward without summing historical snapshots", () => {
    const points = postAnalyticsHistory([
      snapshot("c", "a", 12, 15),
      snapshot("a", "a", 10, 10),
      snapshot("b", "b", 11, 20),
    ]);
    expect(points.map(({ likes, reach, impressions }) => [likes, reach, impressions])).toEqual([
      [10, 20, 30],
      [30, 60, 90],
      [35, 70, 105],
    ]);
  });
  it("groups simultaneous syncs and preserves downward provider corrections", () => {
    const points = postAnalyticsHistory([
      snapshot("a", "a", 10, 10),
      snapshot("b", "b", 10, 20),
      snapshot("c", "a", 11, 8),
    ]);
    expect(points.map(({ likes }) => likes)).toEqual([30, 28]);
  });
});
