import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "./worker";

const environment = {
  ASSETS: { fetch: vi.fn() },
  ENVIRONMENT: "test",
  VERSION: "test-version",
};

function telemetryRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://frontend.test/__frontend-telemetry", {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://frontend.test",
      ...headers,
    },
    method: "POST",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("frontend Worker telemetry boundary", () => {
  it("logs one structured, server-correlated event and returns 204", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));

    const response = await worker.fetch(
      telemetryRequest({
        code: "provider/internal",
        configurationKey: "API_BASE_URL",
        configurationSource: "vite_public_env",
        configurationState: "invalid",
        diagnosticCode: "api_base_url_invalid",
        field: "query-cache",
        kind: "frontend-error",
        message: "raw exception detail",
        retryable: true,
        stack: "Error: raw stack",
        status: 503,
        valueHash: "0123456789abcdef",
        valueType: "Error",
      }),
      environment,
    );

    expect(response.status).toBe(204);
    expect(logger).toHaveBeenCalledTimes(1);
    const event = JSON.parse(logger.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(event).toMatchObject({
      context: expect.objectContaining({
        configuration_key: "API_BASE_URL",
        configuration_source: "vite_public_env",
        configuration_state: "invalid",
        diagnostic_code: "api_base_url_invalid",
        error_code: "provider_internal",
        event: "frontend_client_error",
        field: "query-cache",
        hash: "0123456789abcdef",
        outcome: "error",
        retry_class: "client_retry",
        status: 503,
        type: "Error",
      }),
      environment: "test",
      service: "frontend",
      trace_id: expect.any(String),
      version: "test-version",
    });
    expect(JSON.stringify(event)).not.toContain("raw exception detail");
    expect(JSON.stringify(event)).not.toContain("raw stack");
  });

  it.each([
    [
      "unsafe configuration key",
      telemetryRequest({
        configurationKey: "better_auth_secret_value",
        kind: "frontend-error",
      }),
      400,
    ],
    [
      "wrong method",
      new Request("https://frontend.test/__frontend-telemetry", { method: "GET" }),
      405,
    ],
    [
      "cross origin",
      telemetryRequest({ kind: "frontend-error" }, { Origin: "https://attacker.test" }),
      403,
    ],
    [
      "wrong content type",
      new Request("https://frontend.test/__frontend-telemetry", {
        body: "{}",
        headers: { Origin: "https://frontend.test", "Content-Type": "text/plain" },
        method: "POST",
      }),
      400,
    ],
    [
      "oversized body",
      telemetryRequest({ kind: "frontend-error", message: "x".repeat(5000) }),
      413,
    ],
  ])("rejects %s without logging", async (_label, request, status) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(request, environment);

    expect(response.status).toBe(status);
    expect(logger).not.toHaveBeenCalled();
  });

  it("returns generic copy and emits one safe event when assets fail", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assets = { fetch: vi.fn().mockRejectedValue(new Error("private asset failure")) };

    const response = await worker.fetch(new Request("https://frontend.test/assets/app.js"), {
      ...environment,
      ASSETS: assets,
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("An error has occurred.");
    expect(logger).toHaveBeenCalledTimes(1);
    const event = JSON.parse(logger.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(event).toMatchObject({
      context: expect.objectContaining({
        error_code: "asset_fetch_failed",
        event: "frontend_asset_fetch",
        outcome: "error",
        retry_class: "none",
      }),
    });
    expect(JSON.stringify(event)).not.toContain("private asset failure");
  });
});

describe("frontend Worker API proxy", () => {
  it("forwards /api/* requests to the API service binding unchanged", async () => {
    const api = {
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    const request = new Request("https://frontend.test/api/v1/users/me", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    const response = await worker.fetch(request, { ...environment, API: api });

    expect(response.status).toBe(200);
    expect(api.fetch).toHaveBeenCalledTimes(1);
    const forwarded = api.fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://frontend.test/api/v1/users/me");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer test.jwt.token");
  });

  it("rewrites /api/* onto API_ORIGIN when no service binding exists", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      new Request("https://frontend.test/api/auth/get-session?x=1"),
      { ...environment, API_ORIGIN: "http://127.0.0.1:8787" },
    );

    expect(response.status).toBe(200);
    const forwarded = upstream.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("http://127.0.0.1:8787/api/auth/get-session?x=1");
  });

  it("returns 502 and logs a safe event when the API upstream fails", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = {
      fetch: vi.fn().mockRejectedValue(new Error("binding exploded")),
    };

    const response = await worker.fetch(new Request("https://frontend.test/api/v1/plan"), {
      ...environment,
      API: api,
    });

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("The API is unavailable.");
    expect(logger).toHaveBeenCalledTimes(1);
    const event = JSON.parse(logger.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(event).toMatchObject({
      context: expect.objectContaining({
        error_code: "api_proxy_failed",
        event: "frontend_api_proxy",
        outcome: "error",
        retry_class: "client_retry",
      }),
    });
    expect(JSON.stringify(event)).not.toContain("binding exploded");
  });

  it("does not route non-API paths to the API binding", async () => {
    const api = { fetch: vi.fn() };
    const assets = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };

    await worker.fetch(new Request("https://frontend.test/apiary"), {
      ...environment,
      API: api,
      ASSETS: assets,
    });

    expect(api.fetch).not.toHaveBeenCalled();
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });
});
