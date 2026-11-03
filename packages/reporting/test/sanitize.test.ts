import { describe, expect, it } from "vite-plus/test";

import {
  containsForbiddenValue,
  diagnosticProperties,
  feedbackProperties,
  payloadViolation,
  sanitizedFrames,
  usageProperties,
} from "../src/sanitize";

/**
 * Sanitization cases.
 *
 * These prove the allowlist itself, using deliberate sensitive canaries. They are
 * supplementary: the integration suites assert the same canaries never reach the
 * bytes a real capture receiver actually receives.
 */

const context = { appVersion: "1.0.0-target.0", deploymentCategory: "selfhosted" } as const;

const usageInput = {
  channels: { threads: 2 },
  engagement: {
    threads: { comments: 4, distributions: 1, reactions: 7, shares: null, views: 120 },
  },
  engagementAsOf: "2026-01-02T00:00:00.000Z",
  engagementCoverage: { measured: 1, missing: 0 },
  publications: { distributions: { threads: 1 }, posts: 1 },
  reportDate: "2026-01-02",
};

describe("usage payload", () => {
  it("carries only documented aggregate properties", () => {
    const properties = usageProperties(usageInput, context);

    expect(properties).toEqual({
      app_version: "1.0.0-target.0",
      channels: { threads: 2 },
      deployment_category: "selfhosted",
      engagement: {
        threads: { comments: 4, distributions: 1, reactions: 7, views: 120 },
      },
      engagement_as_of: "2026-01-02T00:00:00.000Z",
      engagement_coverage: { measured: 1, missing: 0 },
      publications: { distributions: { threads: 1 }, posts: 1 },
      report_date: "2026-01-02",
      schema_version: 1,
    });
    expect(payloadViolation(properties)).toBeUndefined();
  });

  it("reports an unsupported metric as absent rather than an observed zero", () => {
    const properties = usageProperties(
      {
        ...usageInput,
        engagement: {
          threads: { comments: null, distributions: 1, reactions: 0, shares: null, views: null },
        },
      },
      context,
    );

    const gauge = (properties.engagement as Record<string, Record<string, number>>).threads!;
    // `reactions: 0` is a real measured zero and survives; unsupported counters vanish.
    expect(gauge.reactions).toBe(0);
    expect(gauge.views).toBeUndefined();
    expect(gauge.shares).toBeUndefined();
    expect(gauge.comments).toBeUndefined();
  });

  it("drops a malformed reporting period instead of forwarding it", () => {
    const properties = usageProperties({ ...usageInput, reportDate: "02/01/2026" }, context);
    expect(properties.report_date).toBeUndefined();
  });

  it("ignores identifiers smuggled into the per-Platform maps", () => {
    const properties = usageProperties(
      {
        ...usageInput,
        channels: { threads: 2, "account-id-9f8e": 5 } as never,
      },
      context,
    );

    expect(properties.channels).toEqual({ threads: 2 });
  });
});

describe("diagnostic payload", () => {
  it("emits the documented exception shape with fixed category values", () => {
    const properties = diagnosticProperties(
      {
        category: "unhandled_exception",
        error: {
          name: "TypeError",
          stack: [
            "TypeError: Cannot publish https://api.provider.test/v1/posts?access_token=secret-value",
            "    at publishDistribution (workers/automation/src/distribution.ts:42:7)",
            "    at Object.<anonymous> (node:internal/process/task_queues:95:5)",
            "    at eval (eval at <anonymous> (src/worker.ts:1:1), <anonymous>:1:1)",
          ].join("\n"),
        },
        handled: false,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "publish",
        platform: "threads",
      },
      context,
    );

    expect(properties).toMatchObject({
      app_version: "1.0.0-target.0",
      deployment_category: "selfhosted",
      diagnostic_category: "unhandled_exception",
      diagnostic_handled: false,
      operation_category: "publish",
      platform: "threads",
      schema_version: 1,
    });
    expect(properties.$exception_level).toBe("error");
    const list = properties.$exception_list as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      mechanism: { exception_id: 0, handled: false, synthetic: false, type: "generic" },
      type: "TypeError",
      value: "unhandled_exception",
    });
    const stacktrace = list[0]!.stacktrace as { frames: Record<string, unknown>[]; type: string };
    expect(stacktrace.type).toBe("raw");
    // Only the application frame survives; node internals and eval frames are cut.
    expect(stacktrace.frames).toEqual([
      {
        filename: "workers/automation/src/distribution.ts",
        function: "publishDistribution",
        in_app: true,
        lang: "javascript",
        lineno: 42,
        platform: "custom",
      },
    ]);
    expect(payloadViolation(properties)).toBeUndefined();
  });

  it("never carries the raw exception message, URL or credential", () => {
    const properties = diagnosticProperties(
      {
        category: "request_failure",
        error: {
          name: "ProviderAdapterError",
          stack: "    at syncComments (workers/automation/src/provider-sync.ts:88:11)",
        },
        handled: true,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "inbox",
      },
      context,
    );

    const serialized = JSON.stringify(properties);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("provider.test");
    expect(serialized).not.toContain("secret-value");
  });

  it("falls back to a safe type and category when the producer passes a raw value", () => {
    const properties = diagnosticProperties(
      {
        category: "raw provider error" as never,
        error: { name: "alpha@example.test" },
        handled: true,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "publish https://leak.test" as never,
      },
      context,
    );

    const list = properties.$exception_list as Record<string, unknown>[];
    expect(list[0]!.type).toBe("Error");
    expect(list[0]!.value).toBe("unhandled_exception");
    expect(properties.operation_category).toBe("other");
    expect(payloadViolation(properties)).toBeUndefined();
  });

  it("drops frames whose location is not an application source path", () => {
    expect(
      sanitizedFrames(
        [
          "    at handler (https://cdn.provider.test/bundle.js:1:22)",
          "    at run (/opt/meltiply/app.js:9:1)",
          "    at safe (packages/reporting/src/service.ts:10:3)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        filename: "packages/reporting/src/service.ts",
        function: "safe",
        in_app: true,
        lang: "javascript",
        lineno: 10,
        platform: "custom",
      },
    ]);
  });
});

describe("feedback payload", () => {
  it("attributes the fixed answer with schema and deployment context only", () => {
    const properties = feedbackProperties("github", context);
    expect(properties).toEqual({
      app_version: "1.0.0-target.0",
      deployment_category: "selfhosted",
      discovery_source: "github",
      schema_version: 1,
    });
    expect(payloadViolation(properties)).toBeUndefined();
  });
});

describe("payload validation", () => {
  it("rejects an unexpected property", () => {
    expect(payloadViolation({ workspace_name: "Acme" })).toBe("unexpected_property:workspace_name");
  });

  it("rejects a nested key outside the documented exception shape", () => {
    expect(
      payloadViolation({ $exception_list: [{ type: "Error", body: "raw request body" }] }),
    ).toBe("unexpected_nested_key:body");
  });

  it("rejects canary values anywhere in the payload", () => {
    for (const canary of [
      "alpha@meltiply.local",
      "https://api.threads.test/v1/posts",
      "00000000-0000-4000-8000-000000000001",
      "Bearer abc.def.ghi",
      "password=hunter2",
      "graph.facebook.com/posts?access_token=abc",
    ]) {
      expect(containsForbiddenValue(canary), canary).toBe(true);
      expect(payloadViolation({ platform: canary }), canary).toBe("forbidden_value");
    }
  });

  it("accepts ordinary identifiers and enumerations", () => {
    expect(containsForbiddenValue("publishDistribution")).toBe(false);
    expect(containsForbiddenValue("workers/api/src/app.ts")).toBe(false);
    expect(payloadViolation({ platform: "threads", schema_version: 1 })).toBeUndefined();
  });
});

describe("provider failure payload", () => {
  it("carries the canonical class as its own documented property", () => {
    const properties = diagnosticProperties(
      {
        category: "provider_failure",
        error: { name: "ProviderAdapterError" },
        failureClass: "rate_limit",
        handled: true,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "publish",
        platform: "threads",
      },
      context,
    );

    expect(properties).toMatchObject({
      diagnostic_category: "provider_failure",
      diagnostic_handled: true,
      provider_failure_class: "rate_limit",
    });
    const [exception] = properties.$exception_list as Record<string, unknown>[];
    expect(exception).toMatchObject({ value: "provider_failure" });
    expect(payloadViolation(properties)).toBeUndefined();
  });

  it("drops an out-of-vocabulary class and a class outside the Provider category", () => {
    const rawClass = diagnosticProperties(
      {
        category: "provider_failure",
        error: { name: "ProviderAdapterError" },
        failureClass: "provider said no" as never,
        handled: true,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "publish",
      },
      context,
    );
    expect(rawClass).not.toHaveProperty("provider_failure_class");

    const wrongCategory = diagnosticProperties(
      {
        category: "unhandled_exception",
        error: { name: "TypeError" },
        failureClass: "rate_limit",
        handled: false,
        occurredAt: "2026-01-02T03:04:05.000Z",
        operation: "publish",
      },
      context,
    );
    expect(wrongCategory).not.toHaveProperty("provider_failure_class");
    expect(payloadViolation(wrongCategory)).toBeUndefined();
  });
});
