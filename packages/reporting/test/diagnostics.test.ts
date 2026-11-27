import { describe, expect, it } from "vite-plus/test";

import { diagnosticReportInput, extractProviderFailureClass } from "../src/diagnostics";

const AT = "2026-01-02T03:04:05.000Z";

function failure(name: string, stack?: string): Error {
  const error = new Error("never reported");
  error.name = name;
  error.stack = stack;
  return error;
}

describe("extractProviderFailureClass", () => {
  it.each([
    ["a classified provider failure", { failure: { classification: "rate_limit" } }, "rate_limit"],
    ["an unknown classification", { failure: { classification: "vendor said no" } }, undefined],
    ["a failure without a classification", { failure: {} }, undefined],
    ["a failure that is not an object", { failure: "boom" }, undefined],
    ["a null failure", { failure: null }, undefined],
    ["an error without a failure", new Error("boom"), undefined],
    ["a thrown string", "boom", undefined],
    ["a thrown null", null, undefined],
  ])("%s", (_example, cause, expected) => {
    expect(extractProviderFailureClass(cause)).toEqual(expected);
  });
});

describe("diagnosticReportInput", () => {
  it("every optional field", () => {
    const input = {
      category: "provider_failure",
      failureClass: "auth",
      handled: false,
      logicalId: "job-1",
      occurredAt: AT,
      operation: "publish",
      platform: "threads",
    } as const;

    expect(diagnosticReportInput(failure("TypeError", "at x"), input)).toEqual({
      category: "provider_failure",
      error: { name: "TypeError", stack: "at x" },
      failureClass: "auth",
      handled: false,
      logicalId: "job-1",
      occurredAt: AT,
      operation: "publish",
      platform: "threads",
    });
  });

  it("only an operation and a time", () => {
    const input = { occurredAt: AT, operation: "other" } as const;

    expect(diagnosticReportInput("boom", input)).toEqual({
      category: "unhandled_exception",
      error: { name: "Error" },
      handled: false,
      occurredAt: AT,
      operation: "other",
    });
  });

  it("no time", () => {
    expect(diagnosticReportInput("boom", { operation: "other" })).toEqual({
      category: "unhandled_exception",
      error: { name: "Error" },
      handled: false,
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      operation: "other",
    });
  });

  it("a provider failure is handled by default", () => {
    const input = { category: "provider_failure", occurredAt: AT, operation: "publish" } as const;

    expect(diagnosticReportInput(failure(""), input)).toEqual({
      category: "provider_failure",
      error: { name: "Error" },
      handled: true,
      occurredAt: AT,
      operation: "publish",
    });
  });

  it("a failure class outside the provider category", () => {
    const input = {
      category: "request_failure",
      failureClass: "auth",
      occurredAt: AT,
      operation: "publish",
    } as const;

    expect(diagnosticReportInput("boom", input)).toEqual({
      category: "request_failure",
      error: { name: "Error" },
      handled: false,
      occurredAt: AT,
      operation: "publish",
    });
  });

  it("a stack longer than 8192 characters", () => {
    const input = { occurredAt: AT, operation: "other" } as const;

    expect(diagnosticReportInput(failure("Error", "a".repeat(8193)), input)).toEqual({
      category: "unhandled_exception",
      error: { name: "Error", stack: "a".repeat(8192) },
      handled: false,
      occurredAt: AT,
      operation: "other",
    });
  });
});
