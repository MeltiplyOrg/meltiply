import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createReportingServiceTest, ReportingService } from "../src/service";
import { reportingConfiguration } from "../src/configuration";
import {
  isDiagnosticCategory,
  isDiscoverySource,
  isOperationCategory,
  isPlatform,
  isProviderFailureClass,
} from "../src/contracts";

/**
 * Service-boundary cases.
 *
 * The database-backed suites prove the live service against real PostgreSQL and a
 * controlled capture receiver. These cases pin the fail-closed test layer every
 * Worker can inject when reporting is unavailable, and the fixed enumerations the
 * HTTP surface and producers both narrow against.
 */

describe("unavailable reporting layer", () => {
  const layer = createReportingServiceTest();

  it("explains why nothing is sent instead of pretending reporting works", async () => {
    const policy = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ReportingService, (service) => service.policy()),
        layer,
      ),
    );

    expect(policy.destinationConfigured).toBe(false);
    // A category nobody asked for reports `not_requested`; the override only
    // becomes the stated reason once a choice exists.
    expect(policy.categories.usage).toMatchObject({
      effective: false,
      reason: "not_requested",
      requested: false,
    });
    expect(policy.installationReportingId).toBeNull();
  });

  it("accepts no work and transmits nothing", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ReportingService, (service) =>
          Effect.all({
            delivery: service.deliverPending(),
            diagnostic: service.enqueueDiagnostic({
              category: "request_failure",
              error: { name: "TypeError" },
              handled: true,
              occurredAt: "2026-01-02T03:04:05.000Z",
              operation: "publish",
            }),
            feedback: service.feedbackState(),
            usage: service.enqueueUsageReport({
              channels: {},
              engagement: {},
              engagementAsOf: null,
              engagementCoverage: null,
              publications: { distributions: {}, posts: 0 },
              reportDate: "2026-01-02",
            }),
          }),
        ),
        layer,
      ),
    );

    expect(result.delivery).toEqual({
      claimed: 0,
      delivered: 0,
      discarded: 0,
      failed: 0,
      skipped: 0,
    });
    expect(result.diagnostic).toBe("skipped");
    expect(result.usage).toBe("skipped");
    expect(result.feedback).toMatchObject({ deliveryStatus: "not_shared", shared: false });
  });

  it("reports the deployment's real status through an injected override", async () => {
    const configuration = reportingConfiguration({
      DEPLOYMENT_CATEGORY: "managed",
      REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123",
    });
    const policy = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ReportingService, (service) => service.policy()),
        createReportingServiceTest(undefined, configuration),
      ),
    );

    expect(policy.destinationConfigured).toBe(true);
    expect(policy.operatorForcedOff).toBe(false);
    expect(policy.categories.usage.reason).toBe("not_requested");
  });
});

describe("fixed enumerations", () => {
  it("narrows only documented discovery-source answers", () => {
    expect(isDiscoverySource("github")).toBe(true);
    expect(isDiscoverySource("prefer_not_to_say")).toBe(true);
    expect(isDiscoverySource("a blog post")).toBe(false);
    expect(isDiscoverySource(undefined)).toBe(false);
  });

  it("narrows only documented diagnostic, operation and Provider classes", () => {
    expect(isDiagnosticCategory("unhandled_exception")).toBe(true);
    expect(isDiagnosticCategory("provider_failure")).toBe(true);
    expect(isDiagnosticCategory("quiet_failure")).toBe(false);
    expect(isOperationCategory("publish")).toBe(true);
    expect(isOperationCategory("everything")).toBe(false);
    expect(isProviderFailureClass("rate_limit")).toBe(true);
    expect(isProviderFailureClass("provider said no")).toBe(false);
  });

  it("narrows only supported Platforms", () => {
    expect(isPlatform("threads")).toBe(true);
    expect(isPlatform("myspace")).toBe(false);
  });
});
