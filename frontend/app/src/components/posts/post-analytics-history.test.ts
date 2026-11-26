import type { components } from "@meltiply/contracts/schema";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { postAnalyticsHistory } from "./post-analytics-history";

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
    snapshot_at: `2026-07-01T${hour}:00:00Z`,
    likes: value,
    comments: 0,
    shares: 0,
    views: value * 10,
    reach: value * 2,
    impressions: value * 3,
    watch_time_sec: 0,
  };
}

const point = (hour: number, likes: number) => ({
  timestamp: Date.parse(`2026-07-01T${hour}:00:00Z`),
  likes,
  comments: 0,
  shares: 0,
  views: likes * 10,
  reach: likes * 2,
  impressions: likes * 3,
});

beforeAll(() => {
  postAnalyticsHistory([snapshot("b", "b", 10, 1), snapshot("a", "a", 10, 1)]);
});

describe("postAnalyticsHistory", () => {
  it("no snapshots", () => {
    expect(postAnalyticsHistory([])).toEqual([]);
  });

  it("two Channels measured at different times, out of order", () => {
    const snapshots = [
      snapshot("c", "a", 12, 15),
      snapshot("a", "a", 10, 10),
      snapshot("b", "b", 11, 20),
    ];

    expect(postAnalyticsHistory(snapshots)).toEqual([point(10, 10), point(11, 30), point(12, 35)]);
  });

  it("two Channels measured at one instant", () => {
    const snapshots = [snapshot("a", "a", 10, 10), snapshot("b", "b", 10, 20)];

    expect(postAnalyticsHistory(snapshots)).toEqual([point(10, 30)]);
  });

  it("a provider correction downwards", () => {
    const snapshots = [snapshot("a", "a", 10, 10), snapshot("c", "a", 11, 8)];

    expect(postAnalyticsHistory(snapshots)).toEqual([point(10, 10), point(11, 8)]);
  });

  it("one Channel measured twice at one instant", () => {
    const snapshots = [snapshot("b", "a", 10, 7), snapshot("a", "a", 10, 9)];

    expect(postAnalyticsHistory(snapshots)).toEqual([point(10, 7)]);
  });
});
