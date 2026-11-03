import { createExecutionContext } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { classifyJobError } from "../src/effect/index";
import { createAutomationHandler, type AutomationDependencies } from "../src/index";
import type { AutomationEnv } from "../src/env";
import type { DeliverySummary } from "@meltiply/reporting";
import type { UsageReportResult } from "../src/usage-reporting";

/**
 * Scheduled-wiring cases for the usage summary producer.
 *
 * The producer is registered on the daily tier and ordered immediately before
 * the delivery pass that drains the same queue, so one invocation both freezes
 * and sends the day's report. Its failure must not abort sibling scheduled work.
 * The measurement semantics themselves run against real PostgreSQL in
 * `test/usage-reporting.integration.test.ts`.
 */

const env = {
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} as AutomationEnv;

const zeroDelivery: DeliverySummary = {
  claimed: 0,
  delivered: 0,
  discarded: 0,
  failed: 0,
  released: 0,
  skipped: 1,
};

const zeroUsage: UsageReportResult = { considered: 0, queued: 0 };

/**
 * Stubs every scheduled unit except the reporting pair.
 *
 * @param overrides - Reporting-specific overrides for one case.
 * @returns Dependency set making only those units observable.
 */
function dependencies(overrides: AutomationDependencies = {}): AutomationDependencies {
  return {
    assetProcessorFor: () => ({
      process: () => Effect.succeed("processed" as const),
      runMaintenance: () =>
        Effect.succeed({
          cleanup_errors: 0,
          expired_sessions: 0,
          orphan_assets_claimed: 0,
          reconciliation_events: 0,
          stale_writing_objects_deleted: 0,
          terminal_sessions_reclaimed: 0,
          usage_rows: 0,
        }),
    }),
    deliverImprovementReports: () => Effect.succeed(zeroDelivery),
    enqueueDailyUsageReport: () => Effect.succeed(zeroUsage),
    enqueueDue: () => Effect.succeed(0),
    enqueueDueReplyReconciliations: () => Effect.succeed(0),
    relay: () => Effect.succeed({ claimed: 0, dead: 0, failed: 0, published: 0 }),
    runRetention: () => Effect.succeed({ deleted: 0, errors: 0 }),
    sweepAccountAnalytics: () => Effect.succeed({ failed: 0, recorded: 0, scanned: 0 }),
    sweepDue: () => Effect.succeed(0),
    sweepProviderDue: () => Effect.succeed({ analytics: 0, comments: 0, token_refresh: 0 }),
    ...overrides,
  };
}

/** Runs one scheduled invocation for a cron expression. */
async function runScheduled(deps: AutomationDependencies, cron: string) {
  const handler = createAutomationHandler(deps);
  await handler.scheduled?.(
    { cron, noRetry: vi.fn(), scheduledTime: Date.parse("2040-01-01T00:00:00Z") },
    env,
    createExecutionContext(),
  );
}

describe("usage reporting scheduled wiring", () => {
  it("runs the producer on the daily tier only", async () => {
    const enqueueDailyUsageReport = vi.fn(() => Effect.succeed(zeroUsage));

    await runScheduled(dependencies({ enqueueDailyUsageReport }), "0 * * * *");
    expect(enqueueDailyUsageReport).not.toHaveBeenCalled();

    await runScheduled(dependencies({ enqueueDailyUsageReport }), "0 0 * * *");
    expect(enqueueDailyUsageReport).toHaveBeenCalledTimes(1);
  });

  it("runs the producer before the delivery pass in one daily invocation", async () => {
    const order: string[] = [];
    await runScheduled(
      dependencies({
        deliverImprovementReports: () => {
          order.push("delivery");
          return Effect.succeed(zeroDelivery);
        },
        enqueueDailyUsageReport: () => {
          order.push("usage");
          return Effect.succeed(zeroUsage);
        },
      }),
      "0 0 * * *",
    );

    // The producer must queue the day's report before the drain reads the queue.
    expect(order).toEqual(["usage", "delivery"]);
  });

  it("keeps a producer failure from aborting the sibling scheduled units", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverImprovementReports = vi.fn(() => Effect.succeed(zeroDelivery));
    const enqueueDailyUsageReport = vi.fn(() =>
      Effect.fail(classifyJobError(new TypeError("usage producer boom"))),
    );

    await expect(
      runScheduled(dependencies({ deliverImprovementReports, enqueueDailyUsageReport }), "0 0 * * *"),
    ).rejects.toThrow();
    expect(deliverImprovementReports).toHaveBeenCalled();
    error.mockRestore();
  });
});
