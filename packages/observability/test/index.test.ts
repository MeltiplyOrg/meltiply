import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  configureLogSampling,
  createRequestId,
  createTraceId,
  elapsedMilliseconds,
  errorDiagnostic,
  exportOtlpSpan,
  log,
  redact,
} from "../src";

afterEach(() => {
  vi.restoreAllMocks();
  configureLogSampling(undefined);
});

describe("observability safety", () => {
  it("preserves valid request IDs and replaces invalid values", () => {
    expect(createRequestId("request-valid-1")).toBe("request-valid-1");
    expect(createRequestId("bad id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("redacts nested tokens, authorization, email, and signed URL queries", () => {
    expect(
      redact({
        authorization: "Bearer secret",
        nested: {
          email: "person@example.test",
          source: "https://r2.example.test/object?X-Amz-Signature=secret",
        },
        safe: "visible",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: {
        email: "[REDACTED]",
        source: "https://r2.example.test/object?[REDACTED]",
      },
      safe: "visible",
    });
  });

  it("extracts valid W3C trace IDs and falls back to a normalized request ID", () => {
    expect(
      createTraceId(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "request-fallback-1",
      ),
    ).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(createTraceId("invalid", "request-fallback-1")).toBe("request-fallback-1");
    expect(
      createTraceId(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "request-fallback-1",
      ),
    ).toBe("request-fallback-1");
  });

  it("reports non-negative operation latency with two-decimal precision", () => {
    expect(elapsedMilliseconds(10, 12.345)).toBe(2.35);
    expect(elapsedMilliseconds(12, 10)).toBe(0);
    expect(elapsedMilliseconds(Number.NaN, 10)).toBe(0);
  });

  it("fingerprints exceptions in a bounded envelope without retaining credentials", () => {
    const first = errorDiagnostic(
      new TypeError("token=private-value at https://internal.test/path?code=abc"),
    );
    const second = errorDiagnostic(
      new TypeError("token=private-value at https://internal.test/path?code=abc"),
    );
    const different = errorDiagnostic(new TypeError("different failure"));

    expect(first.error).toMatchObject({
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      message: "token=[REDACTED] at https://internal.test/path?[REDACTED]",
      name: "TypeError",
    });
    expect(first.error.stack).toBeDefined();
    expect(second.error.fingerprint).toBe(first.error.fingerprint);
    expect(different.error.fingerprint).not.toBe(first.error.fingerprint);
    expect(JSON.stringify(first)).not.toContain("private-value");
    expect(JSON.stringify(first)).not.toContain("code=abc");
    expect(errorDiagnostic("private primitive").error.name).toBe("UnknownError");
  });

  // Logs must preserve transport evidence across cause chains without exposing
  // credential-bearing messages, URL credentials, or recursive thrown payloads.
  it("retains sanitized nested error evidence in the emitted JSON line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cause = new TypeError(
      `access_token=${"private-token".repeat(40)} at https://user:private-password@graph.facebook.com/token?code=private-code`,
    );
    const error = new Error("OAuth failed", { cause });
    Object.defineProperty(cause, "cause", { value: error });
    log(
      "warn",
      {
        environment: "staging",
        service: "api",
        trace_id: "trace-cause",
        request_id: "request-cause",
        user_id: "user-cause",
        version: "test",
      },
      {
        event: "oauth_exchange_failed",
        outcome: "provider_error",
        retry_class: "none",
        message: "Facebook OAuth exchange failed",
        ...errorDiagnostic(error),
      },
    );
    const line = String(warn.mock.calls[0]?.[0]);
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      trace_id: "trace-cause",
      request_id: "request-cause",
      user_id: "user-cause",
      message: "Facebook OAuth exchange failed",
      context: { event: "oauth_exchange_failed", outcome: "provider_error" },
      error: {
        name: "Error",
        message: "OAuth failed",
        cause: {
          name: "TypeError",
          message: "access_token=[REDACTED] at https://graph.facebook.com/token?[REDACTED]",
          cause: { name: "CircularCause" },
        },
      },
    });
    expect(record.error.cause.stack).toContain("TypeError:");
    expect(line).not.toMatch(/private-token|private-password|private-code/);
    expect(line).not.toContain("\n");
  });

  // Arbitrary provider throws must not break logging when getters are unreadable.
  it("serializes thrown objects and unreadable error properties without losing other evidence", () => {
    const failure: Record<string, unknown> = {
      _tag: "ProviderError",
      token: "private",
      code: "private-authorization-code",
      state: "private-oauth-state",
      responseBody: { data: "private-provider-response" },
    };
    failure.self = failure;
    const diagnostic = errorDiagnostic(failure);
    expect(diagnostic.error).toMatchObject({
      name: "ProviderError",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private/);
    expect(errorDiagnostic(new Error("failed", { cause: failure })).error.cause).toMatchObject({
      name: "ProviderError",
    });
    const error = new Error("useful failure");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("unreadable");
      },
    });
    expect(errorDiagnostic(error).error).toMatchObject({
      name: "Error",
      message: "useful failure",
    });
    expect(errorDiagnostic(error).error.stack).toBeUndefined();
  });

  // Deep Error chains must be bounded without exposing the opaque tail payload.
  it("bounds exception cause chains", () => {
    let cause: unknown = { marker: "deep-private-detail" };
    for (let index = 0; index < 20; index++) {
      cause = new Error("transport", { cause });
    }
    const serialized = JSON.stringify(errorDiagnostic(cause));
    expect(serialized).not.toContain("deep-private-detail");
    expect(serialized).toMatch(/Truncated/);
  });

  it("uses the safe default and clamps configured sampling rates", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const context = {
      environment: "staging",
      service: "api",
      trace_id: "trace-rate",
      version: "test",
    };
    const fields = {
      event: "sampling",
      outcome: 200,
      retry_class: "none" as const,
    };
    configureLogSampling(undefined);

    log("info", context, fields);
    expect(info).toHaveBeenCalledOnce();

    configureLogSampling(0);
    log("info", context, fields);
    log("debug", context, fields);
    expect(info).toHaveBeenCalledOnce();
    expect(debug).not.toHaveBeenCalled();

    configureLogSampling("invalid");
    log("info", context, fields);
    expect(info).toHaveBeenCalledTimes(2);
    configureLogSampling("1");
    log("debug", context, fields);
    expect(debug).toHaveBeenCalledOnce();

    configureLogSampling(-1);
    log("info", context, fields);
    expect(info).toHaveBeenCalledTimes(2);

    configureLogSampling(2);
    log("info", context, fields);
    expect(info).toHaveBeenCalledTimes(3);
  });

  it("samples debug and info deterministically by trace ID", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fields = {
      event: "sampling",
      outcome: 200,
      retry_class: "none" as const,
    };
    configureLogSampling(0.5);

    const kept = {
      environment: "staging",
      service: "api",
      trace_id: "trace-deterministic",
      version: "test",
    };
    const dropped = { ...kept, trace_id: "trace-dropped" };

    log("info", kept, fields);
    log("info", kept, fields);
    log("debug", kept, fields);
    log("info", dropped, fields);

    expect(info).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledOnce();
  });

  it("always emits warnings and errors at a zero sampling rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureLogSampling(0);
    const context = {
      environment: "staging",
      service: "api",
      trace_id: "trace-never-dropped",
      version: "test",
    };
    const fields = {
      event: "sampling",
      outcome: "failed",
      retry_class: "none" as const,
    };

    log("warn", context, fields);
    log("error", context, fields);

    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it("emits indexed structured fields with the shared correlation contract", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    log(
      "info",
      {
        environment: "test",
        job_id: "job-1",
        request_id: "request-1",
        service: "automation",
        trace_id: "trace-1",
        version: "test-version",
      },
      {
        authorization: "Bearer secret",
        event: "job_completed",
        job: "asset_processing",
        latency_ms: 12.34,
        outcome: "processed",
        retry_class: "none",
      },
    );

    expect(info).toHaveBeenCalledOnce();
    const line = info.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    const record = JSON.parse(String(line));
    expect(record).toMatchObject({
      environment: "test",
      job_id: "job-1",
      level: "info",
      message: "job completed",
      request_id: "request-1",
      service: "automation",
      trace_id: "trace-1",
      version: "test-version",
      context: {
        authorization: "[REDACTED]",
        event: "job_completed",
        job: "asset_processing",
        latency_ms: 12.34,
        outcome: "processed",
        retry_class: "none",
      },
    });
    expect(String(line)).not.toContain("Bearer secret");
  });

  it("ships local structured logs to Loki best-effort", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    log(
      "info",
      {
        environment: "local",
        service: "api",
        trace_id: "trace-local-1",
        version: "test",
      },
      {
        event: "http_request",
        outcome: 200,
        retry_class: "none",
        route: "/api/v1/health",
      },
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:3100/loki/api/v1/push");
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.streams[0].stream).toMatchObject({
      environment: "local",
      job: "meltiply-worker",
      service: "api",
    });

    fetchMock.mockClear();
    log(
      "info",
      {
        environment: "staging",
        service: "api",
        trace_id: "trace-staging-1",
        version: "test",
      },
      {
        event: "http_request",
        outcome: 200,
        retry_class: "none",
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves valid 16-hex span IDs in exportOtlpSpan without re-hashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await exportOtlpSpan(
      { ENVIRONMENT: "test" },
      {
        endTimeMs: 1000,
        name: "test-span",
        parentSpanId: "0123456789abcdef",
        service: "api",
        spanId: "fedcba9876543210",
        startTimeMs: 500,
        status: "ok",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.spanId).toBe("fedcba9876543210");
    expect(span.parentSpanId).toBe("0123456789abcdef");
  });

  it("redacts sensitive attributes and signed URLs in exportOtlpSpan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await exportOtlpSpan(
      { ENVIRONMENT: "test" },
      {
        attributes: {
          authorization: "Bearer x",
          media_url: "https://bucket.r2.cloudflarestorage.com/video.mp4?X-Amz-Signature=x",
          normal_key: "safe_value",
          password: "x",
          token: "x",
        },
        endTimeMs: 1000,
        name: "test-redaction-span",
        service: "api",
        startTimeMs: 500,
        status: "ok",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    const attributesMap = Object.fromEntries(
      span.attributes.map((attr: { key: string; value: { stringValue?: string } }) => [
        attr.key,
        attr.value.stringValue,
      ]),
    );

    expect(attributesMap["authorization"]).toBe("[REDACTED]");
    expect(attributesMap["password"]).toBe("[REDACTED]");
    expect(attributesMap["token"]).toBe("[REDACTED]");
    expect(attributesMap["media_url"]).toBe(
      "https://bucket.r2.cloudflarestorage.com/video.mp4?[REDACTED]",
    );
    expect(attributesMap["normal_key"]).toBe("safe_value");
  });
});
