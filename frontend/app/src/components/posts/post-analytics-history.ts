import type { components } from "@meltiply/contracts/schema";

type Snapshot = components["schemas"]["AnalyticsSnapshot"];

/** Cumulative reported counters at one actual provider measurement time. */
export interface PostAnalyticsPoint {
  timestamp: number;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  reach: number;
  impressions: number;
}

/**
 * Merges chronological Channel histories into Post totals at observed timestamps.
 * Each Channel contributes only its most recent snapshot, never the sum of its
 * history. Simultaneous measurements form one point; later provider corrections
 * may decrease a counter. Before a Channel's first measurement it contributes
 * nothing, not an invented zero snapshot. Input arrays are not mutated.
 */
export function postAnalyticsHistory(snapshots: readonly Snapshot[]): PostAnalyticsPoint[] {
  const latest = new Map<string, Snapshot>();
  const points: PostAnalyticsPoint[] = [];
  const ordered = [...snapshots].sort(
    (a, b) => Date.parse(a.snapshot_at) - Date.parse(b.snapshot_at) || a.id.localeCompare(b.id),
  );
  const totals = { likes: 0, comments: 0, shares: 0, views: 0, reach: 0, impressions: 0 };
  const metrics = ["likes", "comments", "shares", "views", "reach", "impressions"] as const;
  for (const snapshot of ordered) {
    const previous = latest.get(snapshot.distribution_id);
    for (const metric of metrics) totals[metric] += snapshot[metric] - (previous?.[metric] ?? 0);
    latest.set(snapshot.distribution_id, snapshot);
    const point = { timestamp: Date.parse(snapshot.snapshot_at), ...totals };
    if (points.at(-1)?.timestamp === point.timestamp) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}
