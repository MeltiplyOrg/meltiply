import { describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import { effectTracerLayer, type LogContext, type OtlpSpanInput } from "../src";

describe("Effect Observability Tracer Integration", () => {
  it("exports completed span with correlation context and timing", async () => {
    const exported: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exported.push(span);
    });

    const context: LogContext = {
      environment: "test",
      request_id: "span_parent_123",
      service: "api",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("load_user_identity", {
        attributes: { "tenant.id": "org_456" },
      })(Effect.succeed({ id: "u_1" }));
    }).pipe(Effect.provide(effectTracerLayer(context, mockExporter)));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ id: "u_1" });

    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]).toBeDefined();
    expect(exported[0]?.name).toBe("load_user_identity");
    expect(exported[0]?.service).toBe("api");
    expect(exported[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(exported[0]?.parentSpanId).toBe("span_parent_123");
    expect(exported[0]?.status).toBe("ok");
    expect(exported[0]?.attributes?.["tenant.id"]).toBe("org_456");
    expect(exported[0]?.endTimeMs).toBeGreaterThanOrEqual(exported[0]?.startTimeMs ?? 0);
  });

  it("exports span with error status when effect fails", async () => {
    const exported: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exported.push(span);
    });

    const context: LogContext = {
      environment: "test",
      request_id: "span_parent_err",
      service: "api",
      trace_id: "trace_err_456",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("database_query")(Effect.fail(new Error("Query failed")));
    }).pipe(Effect.provide(effectTracerLayer(context, mockExporter)));

    await expect(Effect.runPromise(program)).rejects.toThrow("Query failed");

    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]?.status).toBe("error");
    expect(exported[0]?.name).toBe("database_query");
  });

  it("omits export when span is unsampled via sampled: false", async () => {
    const mockExporter = vi.fn(async () => undefined);
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_unsampled",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("unsampled_span", { sampled: false })(Effect.succeed(42));
    }).pipe(Effect.provide(effectTracerLayer(context, mockExporter)));

    const result = await Effect.runPromise(program);
    expect(result).toBe(42);
    expect(mockExporter).not.toHaveBeenCalled();
  });

  it("omits export when MinimumTraceLevel suppresses spans to unsampled", async () => {
    const mockExporter = vi.fn(async () => undefined);
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_min_level",
      version: "1.0.0",
    };

    const { Layer, Tracer } = await import("effect");
    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("suppressed_span")(Effect.succeed("hidden"));
    }).pipe(
      Effect.provide(effectTracerLayer(context, mockExporter)),
      Effect.provide(Layer.succeed(Tracer.MinimumTraceLevel, "None")),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("hidden");
    expect(mockExporter).not.toHaveBeenCalled();
  });

  it("forwards export promise to onExportPromise callback", async () => {
    const promises: Promise<void>[] = [];
    const onExportPromise = vi.fn((p: Promise<void>) => {
      promises.push(p);
    });
    const mockExporter = vi.fn(async () => undefined);
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_promise_cb",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("tracked_span")(Effect.succeed("ok"));
    }).pipe(
      Effect.provide(
        effectTracerLayer(context, {
          exporter: mockExporter,
          onExportPromise,
        }),
      ),
    );

    await Effect.runPromise(program);
    expect(onExportPromise).toHaveBeenCalledTimes(1);
    expect(promises.length).toBe(1);
    await expect(promises[0]).resolves.toBeUndefined();
  });

  it("redacts sensitive attributes and signed URLs in Effect spans", async () => {
    const exported: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exported.push(span);
    });

    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_sensitive_span",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("upload_media_span", {
        attributes: {
          authorization: "Bearer x",
          media_url: "https://bucket.r2.cloudflarestorage.com/raw.mov?X-Amz-Signature=x",
          normal_attr: "public_value",
          password: "x",
          token: "x",
        },
      })(Effect.succeed("uploaded"));
    }).pipe(Effect.provide(effectTracerLayer(context, mockExporter)));

    const result = await Effect.runPromise(program);
    expect(result).toBe("uploaded");

    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]?.attributes?.["authorization"]).toBe("[REDACTED]");
    expect(exported[0]?.attributes?.["password"]).toBe("[REDACTED]");
    expect(exported[0]?.attributes?.["token"]).toBe("[REDACTED]");
    expect(exported[0]?.attributes?.["media_url"]).toBe(
      "https://bucket.r2.cloudflarestorage.com/raw.mov?[REDACTED]",
    );
    expect(exported[0]?.attributes?.["normal_attr"]).toBe("public_value");
  });
});
