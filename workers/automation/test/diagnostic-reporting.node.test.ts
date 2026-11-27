import { classifyProviderFailure, ProviderAdapterError } from "@meltiply/providers";
import { diagnosticProperties, payloadViolation } from "@meltiply/reporting";
import { describe, expect, it } from "vite-plus/test";

import {
  operationForScheduledUnit,
  operationForTopic,
  queueDiagnosticReport,
  scheduledDiagnosticReport,
} from "../src/diagnostic-reporting";

const payloadContext = { appVersion: "1.0.0", deploymentCategory: "selfhosted" } as const;

describe("operationForTopic", () => {
  it.each([
    ["distribution.publish.requested", "publish"],
    ["comment.reply.requested", "inbox"],
    ["channel.revocation.requested", "auth"],
    ["asset.processing.requested", "assets"],
    ["provider.sync", "analytics"],
    [undefined, "other"],
    ["unrecognized.topic", "other"],
  ] as const)("%s maps to %s", (topic, expected) => {
    expect(operationForTopic(topic)).toEqual(expected);
  });
});

describe("operationForScheduledUnit", () => {
  it.each([
    ["due-distribution-scan", "publish"],
    ["provider-sync-sweep", "analytics"],
    ["outbox-relay", "queues"],
    ["improvement-reporting-delivery", "reporting"],
    ["retention", "other"],
  ] as const)("%s maps to %s", (unit, expected) => {
    expect(operationForScheduledUnit(unit)).toEqual(expected);
  });
});

describe("queueDiagnosticReport and scheduledDiagnosticReport", () => {
  it("reports a classified ProviderAdapterError as an expected Provider failure", () => {
    const report = queueDiagnosticReport(
      new ProviderAdapterError(classifyProviderFailure({ code: "rate_limited", status: 429 })),
      {
        outcome: "retry",
        provider: "threads",
        topic: "distribution.publish.requested",
      },
    );

    expect(report).toMatchObject({
      category: "provider_failure",
      error: { name: "ProviderAdapterError" },
      failureClass: "rate_limit",
      handled: true,
      operation: "publish",
      platform: "threads",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("rate_limited");
    expect(serialized).not.toContain("distribution.publish.requested");
  });

  it("reports an ambiguous write outcome as the ambiguous Provider class", () => {
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
    const properties = diagnosticProperties(report, payloadContext);
    expect(JSON.stringify(properties)).not.toContain("timed out waiting");
    expect(payloadViolation(properties)).toEqual(undefined);
  });

  it("reports a scheduled unit failure as scheduled_job_failure without leaking message or unit", () => {
    const report = scheduledDiagnosticReport(new TypeError("maintenance boom"), "retention");

    expect(report).toMatchObject({
      category: "scheduled_job_failure",
      handled: false,
      operation: "other",
    });
    const properties = diagnosticProperties(report, payloadContext);
    expect(JSON.stringify(properties)).not.toContain("maintenance boom");
    expect(JSON.stringify(properties)).not.toContain("retention");
    expect(payloadViolation(properties)).toEqual(undefined);
  });
});
