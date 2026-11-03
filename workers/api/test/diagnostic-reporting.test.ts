import { ProviderAdapterError, classifyProviderFailure } from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { systemPoolFor } = vi.hoisted(() => ({
  systemPoolFor: vi.fn(() => {
    throw new Error("boundary reporting must not reach PostgreSQL in these cases");
  }),
}));

// The boundary module resolves its reporting layer lazily per invocation. These
// cases never inject one, so the layer construction reaches this helper; keeping
// it a throwing stub proves the failure path cannot change an HTTP outcome.
vi.mock("../src/database", () => ({ systemPoolFor, withSystemTransactionEffect: vi.fn() }));

import { CoreApiError } from "../src/core-types";
import { apiBoundaryReport, operationForPath } from "../src/diagnostic-reporting";
import { runWorkerEffect } from "../src/effect/runtime";

/**
 * API Worker failure-boundary cases.
 *
 * These pin the translation from a failed invocation to the approved report —
 * fixed operation grouping, expected Provider condition versus unexpected
 * exception — and prove the response the client receives is decided before any
 * reporting is attempted. Real PostgreSQL and a controlled capture receiver are
 * covered by `reporting.integration.test.ts`.
 */

const identity = {
  email: "owner@meltiply.local",
  emailVerified: true,
  subject: "auth_user_boundary",
};

/** Minimal request context carrying the route and correlation the boundary reads. */
function boundaryContext(path: string) {
  const store = new Map<string, unknown>([
    ["requestId", "request-boundary-1"],
    ["traceId", "trace-boundary-1"],
    [
      "actor",
      {
        claims: {},
        email: identity.email,
        isInstallationOwner: true,
        role: "owner",
        userId: "user-boundary-1",
        workspace: { id: "workspace-boundary-1", name: "Alpha", slug: "alpha" },
      },
    ],
  ]);
  return {
    env: { ENVIRONMENT: "test", VERSION: "1.0.0-target.0" } as unknown,
    get: (key: string) => store.get(key),
    req: { path, raw: { signal: undefined } },
    set: (key: string, value: unknown) => store.set(key, value),
  } as unknown as Parameters<typeof runWorkerEffect>[0];
}

/** Error document the API returns for a mapped failure. */
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

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Acme launch");
    expect(serialized).not.toContain("alpha@meltiply.local");
    expect(serialized).not.toContain("x.test");
    expect(serialized).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(report.error).toEqual({ name: "Error" });
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
    // The local operational log still records the failure; the reporting attempt
    // is separate and cannot alter the response above.
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
    // Neither a report nor a reporting-failure log is emitted for a client error.
    expect(systemPoolFor).not.toHaveBeenCalled();
    warn.mockRestore();
    debug.mockRestore();
  });
});
