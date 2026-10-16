import { Exit, Layer, Option, Tracer } from "effect";

import { exportOtlpSpan, redact, type LogContext, type OtlpSpanInput } from "./index";

export type OtlpSpanExporter = (env: { ENVIRONMENT: string }, span: OtlpSpanInput) => Promise<void>;

export interface EffectTracerOptions {
  readonly exporter?: OtlpSpanExporter;
  readonly onExportPromise?: (promise: Promise<void>) => void;
}

/**
 * Creates an Effect Tracer implementation that forwards completed native spans to Meltiply's OTLP exporter.
 *
 * Wraps span lifecycle completion to translate Effect span timing, status, attributes, and correlation IDs
 * into canonical OtlpSpanInput records sent to Tempo for distributed tracing. Sanitizes attributes via
 * recursive redaction, respects the span.sampled decision so unsampled spans are omitted, and forwards
 * export promises to an optional callback for Worker execution context registration (waitUntil).
 *
 * @param context - Execution environment and correlation context for the tracer instance.
 * @param optionsOrExporter - Optional configuration object or exporter function override.
 * @returns Configured Tracer instance ready for runtime composition.
 */
export function createEffectTracer(
  context: LogContext,
  optionsOrExporter?: EffectTracerOptions | OtlpSpanExporter,
): Tracer.Tracer {
  const options: EffectTracerOptions =
    typeof optionsOrExporter === "function"
      ? { exporter: optionsOrExporter }
      : (optionsOrExporter ?? {});
  const exporter = options.exporter ?? exportOtlpSpan;
  const onExportPromise = options.onExportPromise;

  return Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions);
      const originalEnd = span.end.bind(span);

      span.end = function (endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
        originalEnd(endTime, exit);

        // Respect Effect sampling decision: omit unsampled spans (e.g. via MinimumTraceLevel or sampled: false)
        if (span.sampled === false) {
          return;
        }

        const startTimeMs = Number(spanOptions.startTime / 1_000_000n);
        const endTimeMs = Number(endTime / 1_000_000n);
        const isError = Exit.isFailure(exit);

        const attributesRecord: Record<string, unknown> = {};
        for (const [key, val] of span.attributes.entries()) {
          attributesRecord[key] = val;
        }

        const parentSpanId = Option.isSome(spanOptions.parent)
          ? spanOptions.parent.value.spanId
          : undefined;

        const otlpSpan: OtlpSpanInput = {
          attributes: (redact(attributesRecord) as Record<string, unknown>) ?? {},
          endTimeMs,
          name: spanOptions.name,
          parentSpanId,
          service: context.service,
          spanId: span.spanId,
          startTimeMs,
          status: isError ? "error" : "ok",
          traceId: span.traceId,
        };

        const exportPromise = exporter({ ENVIRONMENT: context.environment }, otlpSpan);
        if (onExportPromise) {
          onExportPromise(exportPromise);
        } else {
          void exportPromise;
        }
      };

      return span;
    },
  });
}

/**
 * Creates an Effect Layer configuring Meltiply distributed tracing and external parent span propagation.
 *
 * Registers the OTLP-backed Tracer and establishes the incoming request traceId and spanId as the ParentSpan.
 *
 * @param context - Request correlation context containing trace_id and request_id.
 * @param optionsOrExporter - Optional configuration object or span export function override.
 * @returns Layer providing Tracer and ParentSpan services.
 */
export function effectTracerLayer(
  context: LogContext,
  optionsOrExporter?: EffectTracerOptions | OtlpSpanExporter,
): Layer.Layer<never, never, never> {
  const tracer = createEffectTracer(context, optionsOrExporter);
  const parent = Tracer.externalSpan({
    spanId: context.request_id ?? "root-span",
    traceId: context.trace_id,
  });

  return Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Layer.succeed(Tracer.ParentSpan, parent),
  );
}
