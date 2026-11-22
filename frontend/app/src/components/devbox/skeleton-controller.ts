import type { QueryClient } from "@tanstack/react-query";

import { elementSelector } from "./dom";
import { setSkeletonHold } from "./network-throttle";

export interface LayoutShiftWatch {
  sample: () => LayoutShiftSample;
  stop: () => void;
}

export function forceSkeletons(queryClient: QueryClient): number {
  setSkeletonHold(true);
  const count = queryClient.getQueryCache().getAll().length;
  void queryClient.resetQueries().catch(() => undefined);
  return count;
}

export async function releaseSkeletons(queryClient: QueryClient): Promise<void> {
  setSkeletonHold(false);
  await queryClient.invalidateQueries();
}

export interface SkeletonRect {
  selector: string;
  width: number;
  height: number;
  top: number;
  left: number;
  slot: Element | null;
}

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
  skeleton: { width: number; height: number };
  resolved: { width: number; height: number };
  dWidth: number;
  dHeight: number;
}

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
  score: number;
  shifts: number;
}

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
    return null;
  }
  return {
    sample: () => ({ score, shifts }),
    stop: () => observer.disconnect(),
  };
}
