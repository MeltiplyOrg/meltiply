import type { Page } from "@playwright/test";

/** One measured journey: elapsed wall time plus resource, task, and layout attribution. */
export interface JourneyMetrics {
  apiMs: number;
  cls: number;
  elapsedMs: number;
  longTaskMs: number;
  resourceBytes: number;
}

/** Budgets are intentionally generous so a shared CI runner catches regressions, not jitter. */
export interface JourneyBudget {
  apiMs: number;
  cls: number;
  elapsedMs: number;
  longTaskMs: number;
}

/**
 * Reports whether a measurement is inside one budget. Every dimension must pass;
 * a slow API, long main-thread task, or visible layout shift fails the journey
 * even when the total wall time happened to land inside the ceiling.
 */
export function withinBudget(metrics: JourneyMetrics, budget: JourneyBudget): boolean {
  return (
    metrics.elapsedMs <= budget.elapsedMs &&
    metrics.apiMs <= budget.apiMs &&
    metrics.longTaskMs <= budget.longTaskMs &&
    metrics.cls <= budget.cls
  );
}

/**
 * Compares typed composer content with what remains in the field. A dropped or
 * reordered keystroke fails even when the journey's timing budget passed.
 */
export function typedContentMatches(actual: string, expected: string): boolean {
  return actual === expected;
}

/**
 * Installs buffered PerformanceObservers before application code runs. The
 * collector resets between journeys so one page's navigation cannot inflate the
 * next journey's attribution.
 */
export async function installPerformanceCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Collector = {
      apiMs: number;
      cls: number;
      longTaskMs: number;
      resourceBytes: number;
    };
    const target = window as unknown as { __meltiplyPerf?: Collector };
    const fresh = (): Collector => ({ apiMs: 0, cls: 0, longTaskMs: 0, resourceBytes: 0 });
    target.__meltiplyPerf = fresh();
    const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) callback(entry);
        }).observe({ type, buffered: true });
      } catch {
        // Older engines may not expose a type; the remaining attribution still runs.
      }
    };
    observe("layout-shift", (entry) => {
      const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
      if (!shift.hadRecentInput) target.__meltiplyPerf!.cls += shift.value ?? 0;
    });
    observe("longtask", (entry) => {
      target.__meltiplyPerf!.longTaskMs += entry.duration;
    });
    observe("resource", (entry) => {
      const resource = entry as PerformanceResourceTiming;
      if (resource.name.includes("/api/v1/")) {
        target.__meltiplyPerf!.apiMs += resource.duration;
      }
      if (entry.entryType === "resource") {
        target.__meltiplyPerf!.resourceBytes += resource.transferSize ?? 0;
      }
    });
  });
}

/**
 * Runs one journey and reads the collector after the caller's readiness
 * condition completes. The wall clock starts immediately before the action.
 *
 * @param page - Playwright page with {@link installPerformanceCollector} installed.
 * @param action - User action plus its real readiness wait.
 * @returns Measured journey attribution.
 */
export async function measureJourney(
  page: Page,
  action: () => Promise<void>,
): Promise<JourneyMetrics> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __meltiplyPerf?: {
        apiMs: number;
        cls: number;
        longTaskMs: number;
        resourceBytes: number;
      };
    };
    if (target.__meltiplyPerf) {
      target.__meltiplyPerf = { apiMs: 0, cls: 0, longTaskMs: 0, resourceBytes: 0 };
    }
  });
  const started = Date.now();
  await action();
  const elapsedMs = Date.now() - started;
  const metrics = await page.evaluate(() => {
    const target = window as unknown as {
      __meltiplyPerf?: {
        apiMs: number;
        cls: number;
        longTaskMs: number;
        resourceBytes: number;
      };
    };
    return target.__meltiplyPerf ?? { apiMs: 0, cls: 0, longTaskMs: 0, resourceBytes: 0 };
  });
  return { ...metrics, elapsedMs };
}

/** Median of a non-empty sample, used to compare repeat runs without one outlier deciding the gate. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Median across repeated journey samples, preserving each attribution dimension. */
export function medianMetrics(samples: readonly JourneyMetrics[]): JourneyMetrics {
  return {
    apiMs: median(samples.map((sample) => sample.apiMs)),
    cls: median(samples.map((sample) => sample.cls)),
    elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
    longTaskMs: median(samples.map((sample) => sample.longTaskMs)),
    resourceBytes: median(samples.map((sample) => sample.resourceBytes)),
  };
}
