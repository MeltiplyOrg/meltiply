import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Layer, Tracer } from "effect";

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
    }).pipe(Effect.provide(effectTracerLayer(context, { exporter: mockExporter })));

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
    }).pipe(Effect.provide(effectTracerLayer(context, { exporter: mockExporter })));

    await expect(Effect.runPromise(program)).rejects.toThrow("Query failed");

    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]?.status).toBe("error");
    expect(exported[0]?.name).toBe("database_query");
  });

  it("omits export when span is unsampled via sampled: false", async () => {
    const exported: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exported.push(span);
    });
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_unsampled",
      version: "1.0.0",
    };
    const layer = effectTracerLayer(context, { exporter: mockExporter });

    const unsampled = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.withSpan("unsampled_span", { sampled: false })(Effect.succeed(42));
      }).pipe(Effect.provide(layer)),
    );

    expect(unsampled).toBe(42);
    expect(mockExporter).not.toHaveBeenCalled();
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.withSpan("sampled_span")(Effect.succeed(43));
      }).pipe(Effect.provide(layer)),
    );
    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]?.name).toBe("sampled_span");
  });

  it("omits export when MinimumTraceLevel suppresses spans to unsampled", async () => {
    const exported: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exported.push(span);
    });
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace_min_level",
      version: "1.0.0",
    };

    const suppressed = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.withSpan("suppressed_span")(Effect.succeed("hidden"));
      }).pipe(
        Effect.provide(effectTracerLayer(context, { exporter: mockExporter })),
        Effect.provide(Layer.succeed(Tracer.MinimumTraceLevel, "None")),
      ),
    );

    expect(suppressed).toBe("hidden");
    expect(mockExporter).not.toHaveBeenCalled();
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.withSpan("suppressed_span")(Effect.succeed("hidden"));
      }).pipe(Effect.provide(effectTracerLayer(context, { exporter: mockExporter }))),
    );
    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exported[0]?.name).toBe("suppressed_span");
  });

  it("skips span translation outside local and test without an injected exporter", async () => {
    const onExportPromise = vi.fn();
    await Effect.runPromise(
      Effect.withSpan("production_span")(Effect.succeed("ok")).pipe(
        Effect.provide(
          effectTracerLayer(
            { environment: "production", service: "api", trace_id: "trace-prod", version: "1" },
            { onExportPromise },
          ),
        ),
      ),
    );
    expect(onExportPromise).not.toHaveBeenCalled();
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
});
