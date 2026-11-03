import { ProviderAdapterError, classifyProviderFailure } from "@meltiply/providers";
import { describe, expect, it } from "vite-plus/test";

import {
  operationForScheduledUnit,
  operationForTopic,
  queueDiagnosticReport,
  scheduledDiagnosticReport,
} from "../src/diagnostic-reporting";

/**
 * Boundary-shape cases for automation diagnostics.
 *
 * The real-PostgreSQL and controlled-egress behaviour is covered by
 * `test/improvement-reporting.integration.test.ts`; these pin the translation
 * contract: which fixed category, grouping and Provider class a boundary failure
 * becomes, and that no message, id or payload rides along.
 */

describe("automation diagnostic classification", () => {
  it("groups queue topics and scheduled units by their fixed operation", () => {
    expect(operationForTopic("distribution.publish.requested")).toBe("publish");
    expect(operationForTopic("comment.reply.requested")).toBe("inbox");
    expect(operationForTopic("channel.revocation.requested")).toBe("auth");
    expect(operationForTopic("asset.processing.requested")).toBe("assets");
    expect(operationForTopic("provider.sync")).toBe("analytics");
    expect(operationForTopic(undefined)).toBe("other");
    expect(operationForTopic("unrecognized.topic")).toBe("other");

    expect(operationForScheduledUnit("due-distribution-scan")).toBe("publish");
    expect(operationForScheduledUnit("provider-sync-sweep")).toBe("analytics");
    expect(operationForScheduledUnit("outbox-relay")).toBe("queues");
    expect(operationForScheduledUnit("improvement-reporting-delivery")).toBe("reporting");
  });

  it("reports a classified Provider condition as an expected Provider failure", () => {
    const cause = new ProviderAdapterError(
      classifyProviderFailure({ code: "rate_limited", status: 429 }),
    );

    const report = queueDiagnosticReport(cause, {
      outcome: "retry",
      provider: "threads",
      topic: "distribution.publish.requested",
    });

    expect(report).toMatchObject({
      category: "provider_failure",
      error: { name: "ProviderAdapterError" },
      failureClass: "rate_limit",
      handled: true,
      operation: "publish",
      platform: "threads",
    });
    // Only the class name and an optional bounded stack travel.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("rate_limited");
    expect(serialized).not.toContain("distribution.publish.requested");
  });

  it("reports an ambiguous write as the ambiguous Provider class", () => {
    const report = queueDiagnosticReport(new TypeError("timed out waiting for writes"), {
      outcome: "ambiguous",
      provider: "instagram",
      topic: "distribution.reconcile.requested",
    });

    expect(report).toMatchObject({
      category: "provider_failure",
      failureClass: "ambiguous",
      handled: true,
      operation: "publish",
    });
    expect(JSON.stringify(report)).not.toContain("timed out waiting");
  });

  it("reports a scheduled unit failure as a scheduled-job class", () => {
    const report = scheduledDiagnosticReport(new TypeError("maintenance boom"), "retention");

    expect(report).toMatchObject({
      category: "scheduled_job_failure",
      handled: false,
      operation: "other",
    });
    expect(JSON.stringify(report)).not.toContain("maintenance boom");
  });
});
