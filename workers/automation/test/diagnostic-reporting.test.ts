import { ProviderAdapterError, classifyProviderFailure } from "@meltiply/providers";
import { diagnosticProperties, payloadViolation } from "@meltiply/reporting";
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
 * becomes.
 *
 * The boundary report intentionally keeps the thrown value's bounded stack — the
 * allowlist that strips it runs downstream, in the payload the installation
 * sends. So the privacy assertions below cross that real consumer boundary by
 * assembling the properties and validating them with the same
 * `payloadViolation` gate the service applies before transport, rather than
 * searching the boundary input for a message it is supposed to carry.
 */

/** Payload context the consumer uses for a self-hosted installation. */
const payloadContext = { appVersion: "1.0.0", deploymentCategory: "selfhosted" } as const;

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
    // The runtime message must not survive into the payload the installation
    // would send: the exception value is the fixed category, and the frame the
    // test's own stack names reduces to a reviewed release location.
    const properties = diagnosticProperties(report, payloadContext);
    expect(JSON.stringify(properties)).not.toContain("timed out waiting");
    expect(payloadViolation(properties)).toBeUndefined();
  });

  it("reports a scheduled unit failure as a scheduled-job class", () => {
    const report = scheduledDiagnosticReport(new TypeError("maintenance boom"), "retention");

    expect(report).toMatchObject({
      category: "scheduled_job_failure",
      handled: false,
      operation: "other",
    });
    // Same boundary: the boundary report carries the stack, the sent payload
    // must not carry the message or the unit name the failure came from.
    const properties = diagnosticProperties(report, payloadContext);
    expect(JSON.stringify(properties)).not.toContain("maintenance boom");
    expect(JSON.stringify(properties)).not.toContain("retention");
    expect(payloadViolation(properties)).toBeUndefined();
  });
});
