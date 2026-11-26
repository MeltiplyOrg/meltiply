import { Exit, Layer, Option, Tracer } from "effect";

import type { LogContext } from "./log";
import { exportOtlpSpan, type OtlpSpanInput } from "./otlp";

export interface EffectTracerOptions {
  readonly exporter?: (env: { ENVIRONMENT: string }, span: OtlpSpanInput) => Promise<void>;
  readonly onExportPromise?: (promise: Promise<void>) => void;
}

/**
 * Provides a tracer that exports each completed sampled span (default: `exportOtlpSpan`, which only
 * runs in local/test) and makes the request's trace and request ID the parent span. Export promises
 * go to `onExportPromise` so the Worker can `waitUntil` them.
 */
export function effectTracerLayer(
  context: LogContext,
  options: EffectTracerOptions = {},
): Layer.Layer<never> {
  const exporter = options.exporter ?? exportOtlpSpan;
  const exports =
    options.exporter !== undefined ||
    context.environment === "local" ||
    context.environment === "test";
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions);
      if (!exports) return span;
      const end = span.end.bind(span);
      span.end = (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
        end(endTime, exit);
        if (span.sampled === false) return;
        const promise = exporter(
          { ENVIRONMENT: context.environment },
          {
            attributes: Object.fromEntries(span.attributes),
            endTimeMs: Number(endTime / 1_000_000n),
            name: spanOptions.name,
            parentSpanId: Option.isSome(spanOptions.parent)
              ? spanOptions.parent.value.spanId
              : undefined,
            service: context.service,
            spanId: span.spanId,
            startTimeMs: Number(spanOptions.startTime / 1_000_000n),
            status: Exit.isFailure(exit) ? "error" : "ok",
            traceId: span.traceId,
          },
        );
        options.onExportPromise?.(promise);
      };
      return span;
    },
  });
  const parent = Tracer.externalSpan({
    spanId: context.request_id ?? "root-span",
    traceId: context.trace_id,
  });
  return Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Layer.succeed(Tracer.ParentSpan, parent),
  );
}
