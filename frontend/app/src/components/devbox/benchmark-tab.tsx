import { useEffect, useState } from "react";

import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Switch } from "@meltiply/ui/switch";
import { formatBytes } from "@/lib/format";

import { startPerfMonitor, type PerfSample } from "./perf-monitor";
import {
  isRenderScannerRunning,
  setRenderScannerSpeed,
  startRenderScanner,
  stopRenderScanner,
  type ScanAnimationSpeed,
} from "./render-scanner";

const speeds: readonly ScanAnimationSpeed[] = ["slow", "fast", "off"];

/**
 * Benchmark tab: render profiling and runtime performance gauges.
 *
 * The re-render toggle lazily loads `react-scan` and outlines re-rendering
 * components with commit durations and render counts; the speed control maps
 * to the scanner's outline animation. The FPS/dropped-frame and heap readouts
 * run off a lightweight rAF loop + `performance.memory` so they cost almost
 * nothing when the tab is closed.
 */
export function BenchmarkTab(): React.ReactElement {
  const [scanning, setScanning] = useState(isRenderScannerRunning());
  const [speed, setSpeed] = useState<ScanAnimationSpeed>("fast");
  const [sample, setSample] = useState<PerfSample | null>(null);

  useEffect(() => startPerfMonitor(setSample), []);

  const toggleScanner = async (next: boolean) => {
    if (next) {
      setScanning(await startRenderScanner(speed));
    } else {
      stopRenderScanner();
      setScanning(false);
    }
  };

  const changeSpeed = (next: ScanAnimationSpeed) => {
    setSpeed(next);
    if (scanning) setRenderScannerSpeed(next);
  };

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Re-render outlines</span>
        <Switch
          checked={scanning}
          onCheckedChange={(checked) => void toggleScanner(checked)}
          aria-label="Toggle re-render outlines"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Outline speed</span>
        <SegmentedControl
          options={speeds}
          value={speed}
          onChange={changeSpeed}
          label="Outline speed"
          className="h-7"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-line pt-3">
        <div className="rounded-control bg-inset px-2 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-3">FPS</p>
          <p className="font-mono text-[15px] font-semibold text-ink">{sample?.fps ?? "—"}</p>
        </div>
        <div className="rounded-control bg-inset px-2 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Dropped</p>
          <p className="font-mono text-[15px] font-semibold text-ink">
            {sample?.droppedFrames ?? "—"}
          </p>
        </div>
        <div className="rounded-control bg-inset px-2 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-3">Heap</p>
          <p className="font-mono text-[15px] font-semibold text-ink">
            {sample?.heapUsedBytes != null ? formatBytes(sample.heapUsedBytes) : "—"}
          </p>
        </div>
      </div>
      <p className="text-ink-3">Frames over ~33ms count as dropped. Heap is Chromium-only.</p>
    </div>
  );
}
