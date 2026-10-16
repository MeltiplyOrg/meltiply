import type { QueryClient } from "@tanstack/react-query";

import { elementSelector } from "./dom";
import { setSkeletonHold } from "./network-throttle";

/** Handle returned by `watchLayoutShifts`: read the running score, stop observing. */
export interface LayoutShiftWatch {
  sample: () => LayoutShiftSample;
  stop: () => void;
}

/**
 * Skeleton-preview controller and skeleton/CLS audit helpers for the DevBox.
 *
 * Selecting Skeleton clears each cached query and holds its GET/HEAD refetch,
 * so views render their native loading trees. Selecting Rendered releases the
 * hold and invalidates the cache so the same queries refetch to real content.
 * Audit helpers capture placeholder geometry and live CLS during the toggle.
 */

/**
 * Forces every cached query into its pending skeleton state and holds all
 * subsequent reads. Reset dispatches synchronously, but its refetch promise
 * stays pending by design while Skeleton preview holds the network; return the
 * cache count immediately and suppress cancellation-only completion failures.
 */
export function forceSkeletons(queryClient: QueryClient): number {
  setSkeletonHold(true);
  const count = queryClient.getQueryCache().getAll().length;
  void queryClient.resetQueries().catch(() => undefined);
  return count;
}

/**
 * Releases the skeleton hold and invalidates all queries so they refetch and
 * resolve into real content.
 */
export async function releaseSkeletons(queryClient: QueryClient): Promise<void> {
  setSkeletonHold(false);
  await queryClient.invalidateQueries();
}

export interface SkeletonRect {
  /** CSS selector path hint for locating the element in devtools. */
  selector: string;
  width: number;
  height: number;
  top: number;
  left: number;
  /**
   * The skeleton's parent element — the slot the resolved content fills.
   * Retained so `diffSkeletonRects` can measure the same slot after release.
   */
  slot: Element | null;
}

/**
 * Captures the bounding box of every rendered skeleton placeholder.
 *
 * Skeletons are identified by the `animate-pulse` utility that the shared
 * `Skeleton` component applies — the single convention every view already
 * follows. Returns an empty array when no skeletons are on screen.
 */
export function captureSkeletonRects(root: ParentNode = document): SkeletonRect[] {
  return Array.from(root.querySelectorAll(".animate-pulse")).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      selector: elementSelector(element, ["animate-pulse"]),
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      left: Math.round(rect.left * 10) / 10,
      slot: element.parentElement,
    };
  });
}

export interface SkeletonDiff {
  selector: string;
  /** Skeleton placeholder dimensions. */
  skeleton: { width: number; height: number };
  /** Resolved slot dimensions measured after release. */
  resolved: { width: number; height: number };
  /** Absolute pixel deltas; large values mean the placeholder sized its slot wrong. */
  dWidth: number;
  dHeight: number;
}

/**
 * Compares captured skeleton rects against the same slots' current layout.
 * Call after selecting Rendered so the slots contain resolved content; detached
 * slots are skipped because they no longer describe an on-screen transition.
 */
export function diffSkeletonRects(captured: SkeletonRect[]): SkeletonDiff[] {
  const diffs: SkeletonDiff[] = [];
  for (const entry of captured) {
    const slot = entry.slot;
    if (!slot || !slot.isConnected) continue;
    const rect = slot.getBoundingClientRect();
    const resolved = {
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    };
    diffs.push({
      selector: entry.selector,
      skeleton: { width: entry.width, height: entry.height },
      resolved,
      dWidth: Math.round((resolved.width - entry.width) * 10) / 10,
      dHeight: Math.round((resolved.height - entry.height) * 10) / 10,
    });
  }
  return diffs;
}

interface LayoutShiftSample {
  /** Cumulative CLS score since observation started. */
  score: number;
  /** Number of observed layout-shift entries. */
  shifts: number;
}

/**
 * Starts observing `layout-shift` performance entries and accumulates a live
 * CLS score (entries with recent input are excluded, matching the web-vitals
 * definition). Returns a handle to read the running score and stop observing;
 * `null` when `PerformanceObserver` is unavailable (e.g. jsdom).
 */
export function watchLayoutShifts(): LayoutShiftWatch | null {
  if (typeof PerformanceObserver === "undefined") return null;
  let score = 0;
  let shifts = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
      if (shift.hadRecentInput || typeof shift.value !== "number") continue;
      score += shift.value;
      shifts += 1;
    }
  });
  try {
    observer.observe({ type: "layout-shift", buffered: true });
  } catch {
    // The entry type is unsupported in this browser.
    return null;
  }
  return {
    sample: () => ({ score, shifts }),
    stop: () => observer.disconnect(),
  };
}
