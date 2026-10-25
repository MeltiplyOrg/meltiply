// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  frontendTelemetryEvent,
  reportFrontendError,
  reportFrontendTelemetry,
  reportUnknownContractValue,
} from "./frontend-telemetry";
import { ApiError } from "./api";

describe("frontend telemetry boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits only bounded, support-safe API error metadata", () => {
    const listener = vi.fn();
    window.addEventListener(frontendTelemetryEvent, listener);

    new ApiError(
      new Response(null, {
        headers: { "x-request-id": "request-123" },
        status: 503,
      }),
      {
        error: {
          code: "provider/internal",
          details: [],
          message: "raw-response-secret",
          request_id: "request-123",
          retryable: true,
        },
      },
    );

    const detail = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(detail.detail).toEqual({
      code: "provider_internal",
      kind: "api-error",
      requestId: "request-123",
      retryable: true,
      status: 503,
    });
    expect(JSON.stringify(detail.detail)).not.toContain("raw-response-secret");
    const fetchSpy = vi.mocked(globalThis.fetch);
    const body = JSON.stringify(fetchSpy.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("raw-response-secret");
    expect(body).not.toContain("request-123");
    window.removeEventListener(frontendTelemetryEvent, listener);
  });

  it("preserves safe configuration diagnostics without sending secret-shaped keys", () => {
    const listener = vi.fn();
    window.addEventListener(frontendTelemetryEvent, listener);

    reportFrontendTelemetry({
      configurationKey: "APP_URL",
      configurationSource: "vite_public_env",
      configurationState: "invalid",
      diagnosticCode: "api_base_url_invalid",
      kind: "frontend-error",
    });

    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        configurationKey: "APP_URL",
        configurationSource: "vite_public_env",
        configurationState: "invalid",
        diagnosticCode: "api_base_url_invalid",
      },
    });

    reportFrontendTelemetry({
      configurationKey: "better_auth_secret_value",
      kind: "frontend-error",
    });
    const unsafeDetail = listener.mock.calls[1]?.[0] as CustomEvent;
    expect(unsafeDetail.detail).not.toHaveProperty("configurationKey");
    expect(JSON.stringify(unsafeDetail.detail)).not.toContain("better_auth_secret_value");
    expect(JSON.stringify(vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.body)).not.toContain(
      "better_auth_secret_value",
    );
    window.removeEventListener(frontendTelemetryEvent, listener);
  });

  it("reports unknown values by type and stable hash, never by raw value", () => {
    const listener = vi.fn();
    window.addEventListener(frontendTelemetryEvent, listener);

    reportUnknownContractValue("platform status", "provider-secret-value");

    const detail = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(detail.detail).toMatchObject({
      field: "platform_status",
      kind: "unknown-contract-value",
      valueType: "string",
    });
    expect(detail.detail.valueHash).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(detail.detail)).not.toContain("provider-secret-value");
    const body = JSON.stringify(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("provider-secret-value");
    window.removeEventListener(frontendTelemetryEvent, listener);
  });

  it("dispatches one redacted event without console or raw diagnostics", () => {
    const listener = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.addEventListener(frontendTelemetryEvent, listener);

    reportFrontendError(new Error("backend detail should stay out of the UI"), "test-boundary");

    expect(errorSpy).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(detail.detail).toMatchObject({
      field: "test-boundary",
      kind: "frontend-error",
      valueType: "Error",
    });
    expect(JSON.stringify(detail.detail)).not.toContain("backend detail");
    const fetchSpy = vi.mocked(globalThis.fetch);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchSpy.mock.calls[0]?.[1]?.body)).not.toContain("backend detail");
    window.removeEventListener(frontendTelemetryEvent, listener);
  });

  it("does not touch browser globals during server rendering", () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(() => reportFrontendTelemetry({ kind: "api-error", status: 500 })).not.toThrow();
    vi.stubGlobal("window", originalWindow);
  });
});
