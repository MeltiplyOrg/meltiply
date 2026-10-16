/**
 * Real-time FPS, dropped-frame, and JS heap monitor for the DevBox Benchmark tab.
 *
 * A `requestAnimationFrame` loop measures frame deltas: instantaneous FPS is a
 * 500ms sliding-window average, and a frame counts as dropped when its delta
 * exceeds twice the 60fps budget (~33.4ms). Heap usage comes from Chromium's
 * non-standard `performance.memory` and is `null` elsewhere — the UI shows an
 * em dash rather than a fake number.
 */

export interface PerfSample {
  /** Smoothed frames-per-second over the last ~500ms. */
  fps: number;
  /** Frames whose delta exceeded the dropped-frame budget since start. */
  droppedFrames: number;
  /** Total frames observed since start. */
  frames: number;
  /** JS heap bytes in use, or null when the browser does not expose it. */
  heapUsedBytes: number | null;
  /** JS heap size limit in bytes, or null when unavailable. */
  heapLimitBytes: number | null;
}

const droppedFrameBudgetMs = 1000 / 60 + 1000 / 60;
const windowMs = 500;

interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * Reads Chromium's non-standard `performance.memory`. Returns `null` on
 * browsers that do not expose it (Firefox, Safari, jsdom).
 */
function heapInfo(): { used: number; limit: number } | null {
  const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
  return memory ? { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit } : null;
}

/**
 * Starts the frame monitor. `onSample` fires at most every 250ms with the
 * latest metrics — the rAF loop still counts every frame, but throttled
 * emission keeps the dock from re-rendering 60 times per second. Returns a
 * stop function that cancels the loop.
 */
export function startPerfMonitor(onSample: (sample: PerfSample) => void): () => void {
  let running = true;
  let frames = 0;
  let dropped = 0;
  let last = performance.now();
  let lastEmit = 0;
  let windowStart = last;
  let windowFrames = 0;
  let fps = 0;

  const emit = () => {
    const heap = heapInfo();
    onSample({
      fps,
      droppedFrames: dropped,
      frames,
      heapUsedBytes: heap?.used ?? null,
      heapLimitBytes: heap?.limit ?? null,
    });
  };

  const tick = (now: number) => {
    if (!running) return;
    const delta = now - last;
    last = now;
    frames += 1;
    windowFrames += 1;
    if (delta > droppedFrameBudgetMs) dropped += 1;
    if (now - windowStart >= windowMs) {
      fps = Math.round((windowFrames * 1000) / (now - windowStart));
      windowStart = now;
      windowFrames = 0;
    }
    if (now - lastEmit >= 250) {
      lastEmit = now;
      emit();
    }
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  return () => {
    running = false;
  };
}
