import type { Options } from "react-scan";

/**
 * On-demand React 19 fiber re-render scanner for the DevBox Benchmark tab.
 *
 * Wraps `react-scan` (devDependency). The module is dynamically imported —
 * deliberately, so the scanner's fiber instrumentation never loads until the
 * developer enables benchmarking, keeping the dev runtime unperturbed the rest
 * of the time. When active it outlines re-rendering components with commit
 * durations and render counts directly over the UI. The scanner's own toolbar
 * is suppressed — the DevBox dock is the single control surface — and the
 * animation speed maps to the user's preference.
 */

export type ScanAnimationSpeed = NonNullable<Options["animationSpeed"]>;

interface ScanApi {
  scan: (options: Options) => void;
  setOptions: (options: Partial<Options>) => unknown;
}

let api: ScanApi | null = null;
let running = false;

/**
 * Lazily imports `react-scan` and starts scanning with the given animation
 * speed. Subsequent calls while running just update the speed. Returns false
 * when the module cannot be loaded (e.g. test environments without the dep).
 */
export async function startRenderScanner(speed: ScanAnimationSpeed): Promise<boolean> {
  try {
    // Dynamic import is required: react-scan must stay out of the module graph
    // until benchmarking is explicitly enabled.
    api ??= (await import("react-scan")) as ScanApi;
    api.scan({
      enabled: true,
      showToolbar: false,
      showFPS: false,
      animationSpeed: speed,
      trackUnnecessaryRenders: true,
    });
  } catch {
    return false;
  }
  running = true;
  return true;
}

/**
 * Stops the scanner. No-op when it was never started.
 */
export function stopRenderScanner(): void {
  if (!api || !running) return;
  api.setOptions({ enabled: false });
  running = false;
}

/**
 * Updates the outline animation speed while the scanner is running.
 */
export function setRenderScannerSpeed(speed: ScanAnimationSpeed): void {
  api?.setOptions({ animationSpeed: speed });
}

/**
 * Reports whether the scanner is currently active.
 */
export function isRenderScannerRunning(): boolean {
  return running;
}
