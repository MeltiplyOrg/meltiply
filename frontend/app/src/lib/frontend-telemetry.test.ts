import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { captureAuthJwt, clearAuthJwt } from "./auth-token";
import {
  frontendTelemetryEvent,
  installFrontendErrorLogging,
  reportFrontendApiError,
  reportFrontendError,
  reportFrontendTelemetry,
  reportUnknownContractValue,
} from "./frontend-telemetry";

let events: unknown[];
let requests: { url: unknown; body: unknown; authorization: string | null }[];

beforeEach(() => {
  events = [];
  requests = [];
  const page = new EventTarget();
  page.addEventListener(frontendTelemetryEvent, (event) => {
    events.push((event as CustomEvent).detail);
  });
  vi.stubGlobal("window", page);
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requests.push({
      url,
      body: JSON.parse(String(init.body)),
      authorization: new Headers(init.headers).get("authorization"),
    });
    return Promise.resolve(new Response(null));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthJwt();
});

const sent = (body: unknown, authorization: string | null = null) => ({
  url: "/__frontend-telemetry",
  body,
  authorization,
});

describe("reportFrontendTelemetry", () => {
  it("every field, with unsafe characters", () => {
    reportFrontendTelemetry({
      code: "provider/internal",
      configurationKey: "APP_URL",
      configurationSource: "vite public env",
      configurationState: "in valid",
      diagnosticCode: "api:url",
      field: "a b",
      kind: "frontend-error",
      requestId: "r".repeat(129),
      retryable: false,
      stack: "at x",
      status: 503,
      valueHash: "ABCDEF12",
      valueType: "Type Error",
    });
    const redacted = {
      kind: "frontend-error",
      code: "provider_internal",
      configurationKey: "APP_URL",
      configurationSource: "vite_public_env",
      configurationState: "in_valid",
      diagnosticCode: "api_url",
      field: "a_b",
      retryable: false,
      stack: "at x",
      status: 503,
      valueHash: "abcdef12",
      valueType: "Type_Error",
    };

    expect(events).toEqual([{ ...redacted, requestId: "r".repeat(128) }]);
    expect(requests).toEqual([sent(redacted)]);
  });

  it("a signed-in session", () => {
    captureAuthJwt(new Response(null, { headers: { "set-auth-jwt": "jwt-1" } }));

    reportFrontendTelemetry({ kind: "api-error" });

    expect(requests).toEqual([sent({ kind: "api-error" }, "Bearer jwt-1")]);
  });

  it.each([
    ["a secret-shaped configuration key", { configurationKey: "better_auth_secret_value" }],
    ["a status below 100", { status: 99 }],
    ["a status of 600", { status: 600 }],
    ["a fractional status", { status: 200.5 }],
    ["a hash that is not hexadecimal", { valueHash: "provider-secret" }],
  ])("%s is dropped", (_example, field) => {
    reportFrontendTelemetry({ kind: "api-error", ...field });

    expect(events).toEqual([{ kind: "api-error" }]);
  });

  it.each([100, 599])("a status of %i", (status) => {
    reportFrontendTelemetry({ kind: "api-error", status });

    expect(events).toEqual([{ kind: "api-error", status }]);
  });

  it("server rendering", () => {
    vi.stubGlobal("window", undefined);

    reportFrontendTelemetry({ kind: "api-error" });

    expect(requests).toEqual([]);
  });

  it.each([
    [
      "a fetch that throws",
      () => {
        throw new Error("blocked");
      },
    ],
    ["a fetch that rejects", () => Promise.reject(new Error("offline"))],
  ])("%s", (_example, send) => {
    vi.stubGlobal("fetch", send);

    reportFrontendTelemetry({ kind: "api-error" });

    expect(events).toEqual([{ kind: "api-error" }]);
  });
});

describe("reportFrontendError", () => {
  it("an error whose message names a person and whose stack has frames", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: Post 'Acme launch' failed for alpha@meltiply.local",
      "    at Composer (src/components/composer/composer.tsx:42:7)",
      "    at node:internal/process/task_queues:95:5",
    ].join("\n");

    reportFrontendError(error, "react-render");

    expect(requests).toEqual([
      sent({
        kind: "frontend-error",
        field: "react-render",
        stack:
          "    at Composer (src/components/composer/composer.tsx:42:7)\n    at node:internal/process/task_queues:95:5",
        valueHash: "c79493aa",
        valueType: "Error",
      }),
    ]);
  });

  it("an error whose stack has no frames", () => {
    const error = new Error("backend detail");
    error.stack = "Error: backend detail";

    reportFrontendError(error, "test-boundary");

    expect(events).toEqual([
      {
        kind: "frontend-error",
        field: "test-boundary",
        valueHash: "7a04e48c",
        valueType: "Error",
      },
    ]);
  });

  it("a thrown string", () => {
    reportFrontendError("plain rejection", "test-boundary");

    expect(events).toEqual([
      {
        kind: "frontend-error",
        field: "test-boundary",
        valueHash: "ebb27228",
        valueType: "UnknownError",
      },
    ]);
  });
});

describe("reportFrontendApiError", () => {
  it("an API failure", () => {
    reportFrontendApiError({
      code: "rate_limited",
      requestId: "req-1",
      retryable: true,
      status: 429,
    });

    expect(events).toEqual([
      {
        kind: "api-error",
        code: "rate_limited",
        requestId: "req-1",
        retryable: true,
        status: 429,
      },
    ]);
  });
});

describe("reportUnknownContractValue", () => {
  it.each([
    ["a string", "secret value", "string", { valueHash: "3e96d6a0" }],
    ["a null value", null, "null", {}],
    ["an array", ["a"], "array", {}],
    ["an empty string", "", "string", {}],
  ])("%s", (_example, value, valueType, hash) => {
    reportUnknownContractValue("platform status", value);

    expect(events).toEqual([
      { kind: "unknown-contract-value", field: "platform_status", valueType, ...hash },
    ]);
  });
});

describe("installFrontendErrorLogging", () => {
  it("a window error and an unhandled rejection after installing twice", () => {
    installFrontendErrorLogging();
    installFrontendErrorLogging();

    window.dispatchEvent(Object.assign(new Event("error"), { message: "window broke" }));
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "boom" }));

    expect(events).toEqual([
      {
        kind: "frontend-error",
        field: "window-error",
        valueHash: "5ced6d74",
        valueType: "UnknownError",
      },
      {
        kind: "frontend-error",
        field: "unhandled-rejection",
        valueHash: "c79493aa",
        valueType: "UnknownError",
      },
    ]);
  });
});
