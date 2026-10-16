import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Switch } from "@meltiply/ui/switch";
import { useTheme, type Theme } from "@/lib/theme";
import { themeOriginFromEvent } from "@meltiply/ui/theme-transition";
import { cn } from "@meltiply/ui/utils";

import { type DevBoxLatency } from "./devbox-state";
import { isSkeletonHoldActive } from "./network-throttle";
import {
  captureSkeletonRects,
  diffSkeletonRects,
  forceSkeletons,
  releaseSkeletons,
  watchLayoutShifts,
  type LayoutShiftWatch,
  type SkeletonDiff,
  type SkeletonRect,
} from "./skeleton-controller";
import { breakpointForWidth, isViewportFrameActive, setViewportFrame } from "./viewport-frame";

const previewOptions = ["Rendered", "Skeleton"] as const;
type PreviewMode = (typeof previewOptions)[number];

const latencyOptions = ["0ms", "300ms", "1.5s", "∞"] as const;
type LatencyOption = (typeof latencyOptions)[number];

const latencyToOption: Record<DevBoxLatency, LatencyOption> = {
  0: "0ms",
  300: "300ms",
  1500: "1.5s",
  infinite: "∞",
};

const optionToLatency: Record<LatencyOption, DevBoxLatency> = {
  "0ms": 0,
  "300ms": 300,
  "1.5s": 1500,
  "∞": "infinite",
};

interface SkeletonsTabProps {
  latency: DevBoxLatency;
  onLatencyChange: (latency: DevBoxLatency) => void;
  queryClient: QueryClient | null;
  agentation: boolean;
  onAgentationChange: (enabled: boolean) => void;
}

/**
 * "Rendered | Skeleton" is the direct loading-state preview: Skeleton resets
 * the workspace cache then holds its reads so native query-backed skeletons
 * stay visible; Rendered releases the hold and refetches. The latency slider
 * merely delays `fetch` — it cannot alter component-local render state.
 * The 390px frame and breakpoint pill cover the responsive gate; Capture and
 * Compare record placeholder vs resolved geometry; the Agentation toggle
 * mounts the visual feedback tool from the same control surface.
 * Theme segments anchor the shared ink transition to the activated button.
 */
export function SkeletonsTab({
  latency,
  onLatencyChange,
  queryClient,
  agentation,
  onAgentationChange,
}: SkeletonsTabProps): React.ReactElement {
  const { requestedTheme, setTheme } = useTheme();
  const [preview, setPreview] = useState<PreviewMode>(
    isSkeletonHoldActive() ? "Skeleton" : "Rendered",
  );
  const [previewQueryCount, setPreviewQueryCount] = useState(0);
  const [framed, setFramed] = useState(isViewportFrameActive());
  const [width, setWidth] = useState(() => window.innerWidth);
  const [audit, setAudit] = useState<SkeletonRect[] | null>(null);
  const [diffs, setDiffs] = useState<SkeletonDiff[] | null>(null);
  const [cls, setCls] = useState<number | null>(null);
  const clsWatch = useRef<LayoutShiftWatch | null>(null);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    clsWatch.current = watchLayoutShifts();
    return () => clsWatch.current?.stop();
  }, []);

  /**
   * Selects the visible query-backed state for the current workspace route.
   * Skeleton clears cached query results before holding GET/HEAD refetches;
   * Rendered releases them and invalidates the cache. The cache count is shown
   * to distinguish “this route has no query skeleton” from a failed preview.
   */
  const selectPreview = async (next: PreviewMode) => {
    if (!queryClient || next === preview) return;
    setPreview(next);
    if (next === "Skeleton") {
      setPreviewQueryCount(forceSkeletons(queryClient));
      return;
    }
    await releaseSkeletons(queryClient);
    setPreviewQueryCount(0);
  };

  const toggleFrame = (next: boolean) => {
    setFramed(next);
    setViewportFrame(next);
  };

  const runAudit = () => {
    setAudit(captureSkeletonRects());
    setDiffs(null);
    setCls(clsWatch.current?.sample().score ?? null);
  };

  // Second audit step: after the developer selects Rendered, measure the same slots.
  const runCompare = () => {
    if (audit) setDiffs(diffSkeletonRects(audit));
  };

  /** Anchors the theme wave to the selected segment's button for pointer and keyboard activation. */
  const selectTheme = (next: Theme, control: HTMLButtonElement) => {
    setTheme(
      next,
      themeOriginFromEvent({ clientX: 0, clientY: 0, detail: 0, currentTarget: control }),
    );
  };

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Loading preview</span>
        {queryClient ? (
          <SegmentedControl
            options={previewOptions}
            value={preview}
            onChange={(next) => void selectPreview(next)}
            label="Loading preview"
            className="h-7"
          />
        ) : (
          <span className="text-ink-3">Unavailable on this route</span>
        )}
      </div>
      <p className="-mt-1 text-ink-3">
        {preview === "Skeleton"
          ? previewQueryCount > 0
            ? `Skeleton preview holds workspace reads for ${previewQueryCount} cached ${previewQueryCount === 1 ? "query" : "queries"}.`
            : "Skeleton preview found no cached workspace queries on this route."
          : "Rendered preview allows workspace reads to resolve normally."}
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Network latency</span>
        <SegmentedControl
          options={latencyOptions}
          value={latencyToOption[latency]}
          onChange={(option) => onLatencyChange(optionToLatency[option])}
          label="Network latency"
          className="h-7"
        />
      </div>
      <p className="-mt-1 text-ink-3">
        Selected: {latencyToOption[latency]} — applies to every request.
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">390px frame</span>
        <Switch
          checked={framed}
          onCheckedChange={toggleFrame}
          aria-label="Toggle 390px viewport frame"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Viewport</span>
        <span className="rounded-chip bg-inset px-2 py-0.5 font-mono text-[11px] text-ink-2">
          {breakpointForWidth(width)} · {width}px
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Theme</span>
        <div>
          <SegmentedControl
            options={["light", "dark"] as const}
            value={requestedTheme}
            onChange={selectTheme}
            label="Theme"
            className="h-7"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Agentation feedback</span>
        <Switch
          checked={agentation}
          onCheckedChange={onAgentationChange}
          aria-label="Toggle Agentation feedback tool"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="font-medium">Skeleton audit</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={runAudit}
            className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
          >
            Capture
          </button>
          <button
            type="button"
            onClick={runCompare}
            disabled={!audit || audit.length === 0}
            className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover disabled:opacity-50"
          >
            Compare
          </button>
        </div>
      </div>
      {cls !== null && (
        <p className={cn("font-mono text-[11px]", cls > 0.1 ? "text-red" : "text-ink-2")}>
          CLS since dock opened: {cls.toFixed(3)}
        </p>
      )}
      {audit !== null &&
        (audit.length === 0 ? (
          <p className="text-ink-3">No skeletons on screen — select Skeleton first.</p>
        ) : (
          <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto font-mono text-[11px] text-ink-2">
            {audit.map((rect, index) => (
              <li key={index} className="truncate">
                {rect.selector} — {rect.width}×{rect.height} @ {rect.left},{rect.top}
              </li>
            ))}
          </ul>
        ))}
      {diffs !== null && (
        <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto font-mono text-[11px]">
          {diffs.map((diff, index) => {
            const off = Math.abs(diff.dWidth) > 4 || Math.abs(diff.dHeight) > 4;
            return (
              <li key={index} className={cn("truncate", off ? "text-red" : "text-ink-2")}>
                {diff.selector} — {diff.skeleton.width}×{diff.skeleton.height} →{" "}
                {diff.resolved.width}×{diff.resolved.height} (Δ{diff.dWidth},{diff.dHeight})
              </li>
            );
          })}
          {diffs.length === 0 && (
            <li className="text-ink-3">Captured slots left the DOM — nothing to compare.</li>
          )}
        </ul>
      )}
    </div>
  );
}
