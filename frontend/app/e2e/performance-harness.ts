import type { Page } from "@playwright/test";

export interface JourneyMetrics {
  apiMs: number;
  cls: number;
  elapsedMs: number;
  longTaskMs: number;
  resourceBytes: number;
}

export interface JourneyBudget {
  apiMs: number;
  cls: number;
  elapsedMs: number;
  longTaskMs: number;
}

export function withinBudget(metrics: JourneyMetrics, budget: JourneyBudget): boolean {
  return (
    metrics.elapsedMs <= budget.elapsedMs &&
    metrics.apiMs <= budget.apiMs &&
    metrics.longTaskMs <= budget.longTaskMs &&
    metrics.cls <= budget.cls
  );
}

export function typedContentMatches(actual: string, expected: string): boolean {
  return actual === expected;
}

export async function installPerformanceCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Collector = {
      apiMs: number;
      cls: number;
      longTaskMs: number;
      resourceBytes: number;
    };
    const target = window as Window & { __meltiplyPerf?: Collector };
    const fresh = (): Collector => ({ apiMs: 0, cls: 0, longTaskMs: 0, resourceBytes: 0 });
    target.__meltiplyPerf = fresh();
    const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) callback(entry);
        }).observe({ type, buffered: true });
      } catch {
        return;
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

export async function measureJourney(
  page: Page,
  action: () => Promise<void>,
): Promise<JourneyMetrics> {
  await page.evaluate(() => {
    const target = window as Window & {
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
    const target = window as Window & {
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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function medianMetrics(samples: readonly JourneyMetrics[]): JourneyMetrics {
  return {
    apiMs: median(samples.map((sample) => sample.apiMs)),
    cls: median(samples.map((sample) => sample.cls)),
    elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
    longTaskMs: median(samples.map((sample) => sample.longTaskMs)),
    resourceBytes: median(samples.map((sample) => sample.resourceBytes)),
  };
}
