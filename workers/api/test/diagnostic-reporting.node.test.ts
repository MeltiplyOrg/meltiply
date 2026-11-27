import { classifyProviderFailure, ProviderAdapterError } from "@meltiply/providers";
import { diagnosticProperties, payloadViolation } from "@meltiply/reporting";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import { apiBoundaryReport, operationForPath } from "../src/diagnostic-reporting";
import { runWorkerEffect } from "../src/effect/runtime";
import { fakeHonoContext } from "../test-support/fakes";

function boundaryContext(path: string) {
  return fakeHonoContext({
    actor: {
      claims: {},
      email: "owner@meltiply.local",
      isInstallationOwner: true,
      role: "owner",
      userId: "user-boundary-1",
      workspace: { id: "workspace-boundary-1", name: "Alpha", slug: "alpha" },
    },
    env: { VERSION: "1.0.0-target.0" },
    path,
    requestId: "request-boundary-1",
    traceId: "trace-boundary-1",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("operationForPath", () => {
  it.each([
    ["/api/v1/posts/post-1", "publish"],
    ["/api/v1/distributions", "publish"],
    ["/api/v1/analytics/dashboard", "analytics"],
    ["/api/v1/inbox", "inbox"],
    ["/api/v1/platforms/threads/connect", "auth"],
    ["/api/v1/assets/asset-1", "assets"],
    ["/api/v1/installation/reporting", "reporting"],
    ["/api/v1/workspaces/w-1/audit", "installation"],
    ["/api/v1/unknown/thing", "other"],
    ["/api/auth/get-session", "other"],
  ])("%s maps to %s", (path, operation) => {
    expect(operationForPath(path)).toEqual(operation);
  });
});

describe("apiBoundaryReport", () => {
  it("classifies a ProviderAdapterError as handled provider_failure", () => {
    const report = apiBoundaryReport(
      new ProviderAdapterError(classifyProviderFailure({ code: "rate_limited", status: 429 })),
      "/api/v1/posts",
    );

    expect(report).toMatchObject({
      category: "provider_failure",
      error: { name: "ProviderAdapterError" },
      failureClass: "rate_limit",
      handled: true,
      operation: "publish",
    });
  });

  it("classifies an unexpected exception without a failureClass", () => {
    const report = apiBoundaryReport(new TypeError("boom"), "/api/v1/inbox");

    expect(report).toMatchObject({
      category: "unhandled_exception",
      error: { name: "TypeError" },
      handled: false,
      operation: "inbox",
    });
    expect(report).not.toHaveProperty("failureClass");
  });

  it("never carries the runtime message, path, email, URL, or resource UUID", () => {
    const report = apiBoundaryReport(
      new Error("Post 'Acme launch' failed for alpha@meltiply.local at https://x.test/a?b=c"),
      "/api/v1/posts/00000000-0000-4000-8000-000000000001",
    );

    const properties = diagnosticProperties(report, {
      appVersion: "1.0.0-target.0",
      deploymentCategory: "selfhosted",
    });
    const sent = JSON.stringify(properties);
    expect(sent).not.toContain("Acme launch");
    expect(sent).not.toContain("alpha@meltiply.local");
    expect(sent).not.toContain("x.test");
    expect(sent).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(payloadViolation(properties)).toEqual(undefined);
    expect(JSON.stringify(report)).not.toContain("/api/v1/posts");
    expect(report.error).toEqual({
      name: "Error",
      stack: expect.stringContaining("diagnostic-reporting.node.test.ts"),
    });
  });
});

describe("failed invocation reporting", () => {
  it("preserves the mapped 503 envelope when reporting is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await runWorkerEffect(
      boundaryContext("/api/v1/posts"),
      Effect.fail(new CoreApiError(503, "service_unavailable", "Try again shortly.")),
    );

    expect(response.status).toEqual(503);
    expect(response.headers.get("X-Request-ID")).toEqual("request-boundary-1");
    expect(await response.json()).toEqual({
      error: {
        code: "service_unavailable",
        details: [],
        issues: [],
        message: "Try again shortly.",
        request_id: "request-boundary-1",
        retryable: true,
      },
    });
  });

  it("returns a 400 client error cleanly without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const response = await runWorkerEffect(
      boundaryContext("/api/v1/posts"),
      Effect.fail(new CoreApiError(400, "validation_error", "The request is invalid.")),
    );

    expect(response.status).toEqual(400);
    expect(warn).not.toHaveBeenCalled();
  });
});
