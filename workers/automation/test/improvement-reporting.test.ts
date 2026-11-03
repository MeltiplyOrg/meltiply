import { createExecutionContext } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { classifyJobError } from "../src/effect/index";
import { createAutomationHandler, type AutomationDependencies } from "../src/index";
import type { AutomationEnv } from "../src/env";
import type { DeliverySummary } from "@meltiply/reporting";

/**
 * Scheduled-wiring cases for improvement reporting.
 *
 * Improvement reporting is best-effort: it is registered on the daily tier,
 * never on the hourly tier, and a failure inside it must not abort the sibling
 * scheduled units or change their reported outcomes. The delivery semantics
 * themselves are covered against real PostgreSQL in
 * `test/improvement-reporting.integration.test.ts`.
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
  skipped: 1,
};

/**
 * Stubs every scheduled unit except reporting.
 *
 * @param overrides - Reporting-specific overrides for one case.
 * @returns Dependency set making only the reporting unit observable.
 */
function dependencies(overrides: AutomationDependencies = {}): AutomationDependencies {
  return {
    // Asset maintenance has no dependency slot of its own; the processor factory
    // is its injection seam, so a stub keeps pg-backed maintenance out of the
    // workerd pool while leaving the scheduled loop real.
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

describe("improvement reporting scheduled wiring", () => {
  it("runs the delivery pass on the daily tier only", async () => {
    const deliverImprovementReports = vi.fn(() => Effect.succeed(zeroDelivery));

    await runScheduled(dependencies({ deliverImprovementReports }), "0 * * * *");
    expect(deliverImprovementReports).not.toHaveBeenCalled();

    await runScheduled(dependencies({ deliverImprovementReports }), "0 0 * * *");
    expect(deliverImprovementReports).toHaveBeenCalledTimes(1);
  });

  it("runs when a direct invocation dispatches every tier", async () => {
    const deliverImprovementReports = vi.fn(() => Effect.succeed(zeroDelivery));
    const handler = createAutomationHandler(dependencies({ deliverImprovementReports }));

    // A missing controller is the documented "dispatch every tier" path.
    await handler.scheduled?.({} as ScheduledController, env, createExecutionContext());

    expect(deliverImprovementReports).toHaveBeenCalledTimes(1);
  });

  it("keeps a reporting failure from aborting the sibling scheduled units", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliverImprovementReports = vi.fn(() =>
      Effect.fail(classifyJobError(new TypeError("capture boom"))),
    );
    // Retention is the sibling unit that shares the daily tier with reporting.
    const runRetention = vi.fn(() => Effect.succeed({ deleted: 0, errors: 0 }));

    // Every daily unit still runs; the invocation then reports the first
    // failure, so a PostHog problem cannot silently disable unrelated work.
    await expect(
      runScheduled(dependencies({ deliverImprovementReports, runRetention }), "0 0 * * *"),
    ).rejects.toThrow();

    expect(runRetention).toHaveBeenCalled();
    expect(deliverImprovementReports).toHaveBeenCalled();
    error.mockRestore();
  });
});
