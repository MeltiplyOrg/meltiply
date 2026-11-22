import { ProviderAdapterError, classifyProviderFailure } from "@meltiply/providers";
import { diagnosticProperties, payloadViolation } from "@meltiply/reporting";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { systemPoolFor } = vi.hoisted(() => ({
  systemPoolFor: vi.fn(() => {
    throw new Error("boundary reporting must not reach PostgreSQL in these cases");
  }),
}));

vi.mock("../src/database", () => ({ systemPoolFor, withSystemTransactionEffect: vi.fn() }));

import { CoreApiError } from "../src/core-types";
import { apiBoundaryReport, operationForPath } from "../src/diagnostic-reporting";
import { runWorkerEffect } from "../src/effect/runtime";
import { fakeHonoContext } from "../test-support/fakes";

const identity = {
  email: "owner@meltiply.local",
  emailVerified: true,
  subject: "auth_user_boundary",
};

function boundaryContext(path: string) {
  return fakeHonoContext({
    actor: {
      claims: {},
      email: identity.email,
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

interface ErrorBody {
  error: { code: string };
}

describe("diagnostic boundary classification", () => {
  it("groups API paths by the fixed operation vocabulary", () => {
    expect(operationForPath("/api/v1/posts/post-1")).toBe("publish");
    expect(operationForPath("/api/v1/distributions")).toBe("publish");
    expect(operationForPath("/api/v1/analytics/dashboard")).toBe("analytics");
    expect(operationForPath("/api/v1/inbox")).toBe("inbox");
    expect(operationForPath("/api/v1/platforms/threads/connect")).toBe("auth");
    expect(operationForPath("/api/v1/assets/asset-1")).toBe("assets");
    expect(operationForPath("/api/v1/installation/reporting")).toBe("reporting");
    expect(operationForPath("/api/v1/workspaces/w-1/audit")).toBe("installation");
    expect(operationForPath("/api/v1/unknown/thing")).toBe("other");
    expect(operationForPath("/api/auth/get-session")).toBe("other");
  });

  it("keeps an expected Provider condition separate from an unexpected exception", () => {
    const provider = apiBoundaryReport(
      new ProviderAdapterError(classifyProviderFailure({ code: "rate_limited", status: 429 })),
      "/api/v1/posts",
    );
    expect(provider).toMatchObject({
      category: "provider_failure",
      error: { name: "ProviderAdapterError" },
      failureClass: "rate_limit",
      handled: true,
      operation: "publish",
    });

    const unexpected = apiBoundaryReport(new TypeError("boom"), "/api/v1/inbox");
    expect(unexpected).toMatchObject({
      category: "unhandled_exception",
      error: { name: "TypeError" },
      handled: false,
      operation: "inbox",
    });
    expect(unexpected).not.toHaveProperty("failureClass");
  });

  it("never carries the runtime message, path or a request identifier", () => {
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
    expect(payloadViolation(properties)).toBeUndefined();
    const exception = (properties.$exception_list as Record<string, unknown>[])[0]!;
    expect(exception.value).toBe("unhandled_exception");
    expect(JSON.stringify(report)).not.toContain("/api/v1/posts");
    expect(report.error).toEqual({
      name: "Error",
      stack: expect.stringContaining("diagnostic-reporting.test.ts"),
    });
  });
});

describe("failed invocation reporting", () => {
  it("preserves the mapped status and envelope when reporting is unavailable", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await runWorkerEffect(
      boundaryContext("/api/v1/posts"),
      Effect.fail(new CoreApiError(503, "service_unavailable", "Try again shortly.")),
    );

    expect(response.status).toBe(503);
    const body: ErrorBody = await response.json();
    expect(body.error.code).toBe("service_unavailable");
    expect(response.headers.get("X-Request-ID")).toBe("request-boundary-1");
    logger.mockRestore();
  });

  it("reports nothing for a 4xx client mistake", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const response = await runWorkerEffect(
      boundaryContext("/api/v1/posts"),
      Effect.fail(new CoreApiError(400, "validation_error", "The request is invalid.")),
    );

    expect(response.status).toBe(400);
    expect(systemPoolFor).not.toHaveBeenCalled();
    warn.mockRestore();
    debug.mockRestore();
  });
});
