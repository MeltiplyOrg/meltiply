import { describe, expect, it } from "vite-plus/test";

import {
  boundedCount,
  containsForbiddenValue,
  diagnosticProperties,
  feedbackProperties,
  payloadViolation,
  sanitizedFrames,
  usageProperties,
} from "../src/sanitize";

const context = { appVersion: "1.0.0-target.0", deploymentCategory: "selfhosted" } as const;
const enveloped = {
  app_version: "1.0.0-target.0",
  deployment_category: "selfhosted",
  schema_version: 1,
};
const NOTHING_MEASURED = {
  channels: {},
  engagement: {},
  engagementAsOf: null,
  engagementCoverage: null,
  publications: { distributions: {}, posts: 0 },
  reportDate: "2026-01-02",
};
const nothingReported = { ...enveloped, publications: { posts: 0 } };

const frame = (filename: string, lineno: number) => ({
  filename,
  function: "<anonymous>",
  in_app: true,
  lang: "javascript",
  lineno,
  platform: "custom",
});

describe("containsForbiddenValue", () => {
  it.each([
    ["an email address", "alpha@meltiply.local", true],
    ["a URL", "https://api.threads.test/v1/posts", true],
    ["a UUID", "00000000-0000-4000-8000-000000000001", true],
    ["a bearer credential", "Bearer abc.def.ghi", true],
    ["a password assignment", "password=hunter2", true],
    ["an api key header", "api-key: abc", true],
    ["a query string", "graph.facebook.com/posts?fields=abc", true],
    ["a function name", "publishDistribution", false],
    ["a source path", "workers/api/src/app.ts", false],
    ["an empty string", "", false],
  ])("%s", (_example, value, forbidden) => {
    expect(containsForbiddenValue(value)).toEqual(forbidden);
  });
});

describe("boundedCount", () => {
  it.each([
    ["zero", 0, 0],
    ["a fraction", 2.9, 2],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["past the safe integers", Number.MAX_SAFE_INTEGER + 1, null],
    ["a negative number", -1, null],
    ["an infinite number", Number.POSITIVE_INFINITY, null],
    ["not a number", Number.NaN, null],
    ["a numeric string", "3", null],
    ["no value", undefined, null],
  ])("%s", (_example, value, count) => {
    expect(boundedCount(value)).toEqual(count);
  });
});

describe("usageProperties", () => {
  it("every measurement", () => {
    const input = {
      channels: { threads: 2 },
      engagement: {
        threads: {
          asOf: "2026-01-02T00:00:00Z",
          comments: 4,
          distributions: 1,
          reactions: 7,
          shares: 2,
          views: 120,
        },
      },
      engagementAsOf: "2026-01-02T00:00:00Z",
      engagementCoverage: {
        measured: 1,
        missing: 4,
        truncated: true,
        unsupportedMetrics: ["reactions", "views"] as const,
      },
      expectedIntervalStartedAt: "2026-01-01T00:00:00Z",
      publications: { distributions: { threads: 1 }, posts: 1 },
      reportDate: "2026-01-02",
    };

    expect(usageProperties(input, context)).toEqual({
      ...enveloped,
      channels: { threads: 2 },
      consent_interval_started_at: "2026-01-01T00:00:00.000Z",
      engagement: {
        threads: {
          as_of: "2026-01-02T00:00:00.000Z",
          comments: 4,
          distributions: 1,
          reactions: 7,
          shares: 2,
          views: 120,
        },
      },
      engagement_as_of: "2026-01-02T00:00:00.000Z",
      engagement_coverage: {
        measured: 1,
        missing: 4,
        truncated: true,
        unsupported_metrics: ["views", "reactions"],
      },
      publications: { distributions: { threads: 1 }, posts: 1 },
      report_date: "2026-01-02",
    });
  });

  it("nothing measured", () => {
    expect(usageProperties(NOTHING_MEASURED, context)).toEqual({
      ...nothingReported,
      report_date: "2026-01-02",
    });
  });

  it.each([
    ["a date in another format", "02/01/2026"],
    ["a day that does not exist", "2026-02-30"],
    ["a month that does not exist", "2026-13-01"],
  ])("%s", (_example, reportDate) => {
    const input = { ...NOTHING_MEASURED, reportDate };

    expect(usageProperties(input, context)).toEqual(nothingReported);
  });

  it("a metric with no observation next to an observed zero", () => {
    const input = {
      ...NOTHING_MEASURED,
      engagement: {
        threads: {
          asOf: null,
          comments: null,
          distributions: 1,
          reactions: 0,
          shares: null,
          views: null,
        },
      },
    };

    expect(usageProperties(input, context)).toEqual({
      ...nothingReported,
      engagement: { threads: { distributions: 1, reactions: 0 } },
      report_date: "2026-01-02",
    });
  });

  it("identifiers smuggled into the per-Platform maps", () => {
    const channels = { threads: 2, "account-id-9f8e": 5 };
    const input = { ...NOTHING_MEASURED, channels };

    expect(usageProperties(input, context)).toEqual({
      ...nothingReported,
      channels: { threads: 2 },
      report_date: "2026-01-02",
    });
  });

  it("a metric outside the engagement vocabulary", () => {
    const input = {
      ...NOTHING_MEASURED,
      engagementCoverage: {
        measured: 1,
        missing: 0,
        truncated: false,
        unsupportedMetrics: ["follower_count"] as never,
      },
    };

    expect(usageProperties(input, context)).toEqual({
      ...nothingReported,
      engagement_coverage: { measured: 1, missing: 0 },
      report_date: "2026-01-02",
    });
  });

  it("unusable times and counts", () => {
    const input = {
      ...NOTHING_MEASURED,
      engagementAsOf: "not-a-time",
      engagementCoverage: { measured: -1, missing: -1, truncated: false, unsupportedMetrics: [] },
      publications: { distributions: {}, posts: -1 },
    };

    expect(usageProperties(input, context)).toEqual({ ...enveloped, report_date: "2026-01-02" });
  });
});

describe("sanitizedFrames", () => {
  it.each([
    [
      "a named V8 frame",
      "    at publish (workers/automation/src/distribution.ts:42:7)",
      "workers/automation/source",
      42,
    ],
    [
      "an async V8 frame",
      "    at async publish (workers/automation/src/distribution.ts:42:7)",
      "workers/automation/source",
      42,
    ],
    [
      "an anonymous V8 frame",
      "    at workers/automation/src/distribution.ts:42:7",
      "workers/automation/source",
      42,
    ],
    [
      "a package source frame",
      "    at safe (packages/reporting/src/service.ts:10:3)",
      "packages/reporting/source",
      10,
    ],
    ["an app source frame", "    at x (src/lib/api.ts:3:1)", "src/lib/source", 3],
    [
      "a hashed asset behind an origin",
      "    at render (https://installation.example/assets/index-DiwrgTda.js:4:12)",
      "assets/DiwrgTda.js",
      4,
    ],
    [
      "a hashed asset with a credential query",
      "    at boot (https://app.example/assets/index-AbCdEf12.js?access_token=leak:1:1)",
      "assets/AbCdEf12.js",
      1,
    ],
    ["a release bundle", "    at run (/opt/meltiply/worker.js:9:1)", "worker.js", 9],
  ])("%s", (_example, stack, filename, lineno) => {
    expect(sanitizedFrames(stack)).toEqual([frame(filename, lineno)]);
  });

  it.each([
    ["no stack", undefined],
    ["an empty stack", ""],
    ["a dependency bundle", "    at handler (https://cdn.provider.test/bundle.js:1:22)"],
    ["an arbitrary absolute path", "    at run (/opt/meltiply/app.js:9:1)"],
    ["an unhashed asset name", "    at x (https://app.example/assets/customer-name.js:1:1)"],
    ["an unknown source area", "    at x (workers/billing/src/app.ts:1:1)"],
    ["a source path with no code extension", "    at x (workers/api/notes.txt:1:1)"],
    ["a location without a line", "    at publish (workers/automation/src/distribution.ts)"],
    ["a location without a column", "    at publish (workers/automation/src/distribution.ts:4)"],
    ["a frame without a location", "    at publishDistribution"],
    ["a blank frame", "    at    "],
    ["an eval frame", "    at eval (eval at <anonymous> (src/worker.ts:1:1), <anonymous>:1:1)"],
    ["a promise combinator frame", "    at async Promise.all (index 0)"],
    ["a message line", "TypeError: Cannot publish https://api.provider.test?access_token=x"],
    ["a very long malformed line", `at ${" ".repeat(100_000)}x`],
  ])("%s", (_example, stack) => {
    expect(sanitizedFrames(stack)).toEqual([]);
  });

  it("a hostile function name before a source location", () => {
    const stack = `at ${"private-customer-name ".repeat(100)}(workers/automation/src/a.ts:42:7)`;

    expect(sanitizedFrames(stack)).toEqual([frame("workers/automation/source", 42)]);
  });

  it("a line number past the safe integers", () => {
    const stack = "    at boot (workers/automation/src/a.ts:99999999999999999999:1)";

    expect(sanitizedFrames(stack)).toEqual([
      {
        filename: "workers/automation/source",
        function: "<anonymous>",
        in_app: true,
        lang: "javascript",
        platform: "custom",
      },
    ]);
  });

  it("thirteen usable frames", () => {
    const stack = Array.from({ length: 13 }, (_, i) => `at src/app/a.ts:${i + 1}:1`).join("\n");

    expect(sanitizedFrames(stack)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((line) => frame("src/app/source", line)),
    );
  });
});

describe("diagnosticProperties", () => {
  const occurredAt = "2026-01-02T03:04:05.000Z";
  const exception = (type: string, value: string, handled: boolean) => ({
    mechanism: { exception_id: 0, handled, synthetic: false, type: "generic" },
    type,
    value,
  });

  it("an exception with a stack and a platform", () => {
    const input = {
      category: "unhandled_exception",
      error: {
        name: "TypeError",
        stack: [
          "TypeError: Cannot publish https://api.provider.test/v1/posts?access_token=secret",
          "    at publish (workers/automation/src/distribution.ts:42:7)",
        ].join("\n"),
      },
      handled: false,
      occurredAt,
      operation: "publish",
      platform: "threads",
    } as const;

    expect(diagnosticProperties(input, context)).toEqual({
      ...enveloped,
      $exception_level: "error",
      $exception_list: [
        {
          ...exception("TypeError", "unhandled_exception", false),
          stacktrace: { frames: [frame("workers/automation/source", 42)], type: "raw" },
        },
      ],
      diagnostic_category: "unhandled_exception",
      diagnostic_handled: false,
      operation_category: "publish",
      platform: "threads",
    });
  });

  it("a classified provider failure", () => {
    const input = {
      category: "provider_failure",
      error: { name: "ProviderAdapterError" },
      failureClass: "rate_limit",
      handled: true,
      occurredAt,
      operation: "publish",
    } as const;

    expect(diagnosticProperties(input, context)).toEqual({
      ...enveloped,
      $exception_level: "error",
      $exception_list: [exception("ProviderAdapterError", "provider_failure", true)],
      diagnostic_category: "provider_failure",
      diagnostic_handled: true,
      operation_category: "publish",
      provider_failure_class: "rate_limit",
    });
  });

  it("raw values in every classified field", () => {
    const input = {
      category: "raw provider error",
      error: { name: "SensitiveCustomerName" },
      failureClass: "provider said no",
      handled: true,
      occurredAt,
      operation: "publish https://leak.test",
      platform: "alpha@example.test",
    } as never;

    expect(diagnosticProperties(input, context)).toEqual({
      ...enveloped,
      $exception_level: "error",
      $exception_list: [exception("Error", "unhandled_exception", true)],
      diagnostic_category: "unhandled_exception",
      diagnostic_handled: true,
      operation_category: "other",
    });
  });

  it.each([
    ["an unknown class of a provider failure", "provider_failure", "provider said no"],
    ["a class outside the provider category", "request_failure", "rate_limit"],
  ])("%s", (_example, category, failureClass) => {
    const input = {
      category,
      error: { name: "TypeError" },
      failureClass,
      handled: true,
      occurredAt,
      operation: "publish",
    } as never;

    expect(diagnosticProperties(input, context)).toEqual({
      ...enveloped,
      $exception_level: "error",
      $exception_list: [exception("TypeError", category, true)],
      diagnostic_category: category,
      diagnostic_handled: true,
      operation_category: "publish",
    });
  });
});

describe("feedbackProperties", () => {
  it("a discovery source", () => {
    expect(feedbackProperties("github", context)).toEqual({
      ...enveloped,
      discovery_source: "github",
    });
  });
});

describe("payloadViolation", () => {
  const listOf = (...entries: unknown[]) => ({ $exception_list: entries });
  const framed = (frames: unknown) =>
    listOf({ stacktrace: { frames, type: "raw" }, type: "TypeError" });
  const nested = (depth: number): unknown => (depth === 0 ? "x" : [nested(depth - 1)]);

  it.each([
    ["an empty payload", {}],
    ["ordinary enumerations", { platform: "threads", schema_version: 1 }],
    ["a value of 200 characters", { platform: "a".repeat(200) }],
    ["an array of 64 items", { channels: Array.from({ length: 64 }, () => 1) }],
    ["strings six levels deep", { channels: nested(5) }],
    ["an exception without a stack", listOf({ type: "TypeError" })],
    ["an approved frame", framed([{ filename: "assets/AbCdEf12.js", function: "<anonymous>" }])],
  ])("%s", (_example, payload) => {
    expect(payloadViolation(payload)).toEqual(undefined);
  });

  it.each([
    ["an unexpected property", { workspace_name: "Acme" }, "unexpected_property:workspace_name"],
    [
      "an unexpected nested key",
      listOf({ type: "Error", body: "raw request body" }),
      "unexpected_nested_key:body",
    ],
    ["strings seven levels deep", { channels: nested(6) }, "payload_too_deep"],
    ["an array of 65 items", { channels: Array.from({ length: 65 }, () => 1) }, "payload_too_wide"],
    ["a value of 201 characters", { platform: "a".repeat(201) }, "oversized_value"],
    ["a leaked value", { platform: "alpha@meltiply.local" }, "forbidden_value"],
    ["an exception list that is not a list", { $exception_list: "x" }, "exception_list_not_list"],
    ["an exception that is not an object", listOf("x"), "exception_entry_invalid"],
    ["an unapproved exception type", listOf({ type: "CustomerName" }), "unapproved_exception_type"],
    ["frames that are not a list", framed("x"), "frames_not_list"],
    ["a frame that is not an object", framed(["x"]), "frame_invalid"],
    [
      "an unapproved frame location",
      framed([{ filename: "packages/SensitiveCustomerName.ts" }]),
      "unapproved_frame_location",
    ],
    [
      "a free-form frame symbol",
      framed([{ filename: "assets/AbCdEf12.js", function: "customerName" }]),
      "unapproved_frame_symbol",
    ],
  ])("%s", (_example, payload, violation) => {
    expect(payloadViolation(payload)).toEqual(violation);
  });
});
