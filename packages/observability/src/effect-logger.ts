import { Logger, type Layer } from "effect";
import { CurrentLogAnnotations } from "effect/References";

import { errorDiagnostic, log, type LogContext, type LogFields, type RetryClass } from "./index";

/**
 * Maps an Effect v4 log level name to Meltiply's canonical log level string.
 *
 * @param level - Effect log level label (e.g. "Debug", "Info", "Warn", "Error").
 * @returns Bounded log severity ("debug" | "info" | "warn" | "error").
 */
function toMeltiplyLevel(level: unknown): "debug" | "error" | "info" | "warn" {
  const normalized = typeof level === "string" ? level.toLowerCase() : "";
  if (normalized.includes("err") || normalized.includes("fatal")) return "error";
  if (normalized.includes("warn")) return "warn";
  if (normalized.includes("debug") || normalized.includes("trace")) return "debug";
  return "info";
}

/**
 * Creates an Effect Logger implementation that pipes Effect log events to Meltiply structured logging.
 *
 * Translates Effect messages, annotations, and error diagnostics into standardized Meltiply `LogFields`,
 * enforcing redaction and preserving trace, request, job, provider, and error correlation without creating
 * a parallel telemetry sink.
 *
 * @param context - Execution environment and correlation context for the logger instance.
 * @returns Configured Effect Logger instance ready for runtime composition.
 */
export function createEffectLogger(context: LogContext): Logger.Logger<unknown, void> {
  return Logger.make(({ fiber, logLevel, message }) => {
    const level = toMeltiplyLevel(logLevel);
    let event = "effect_log";
    const extraFields: Record<string, unknown> = {};

    const annotations = fiber?.getRef?.(CurrentLogAnnotations);
    if (annotations && typeof annotations === "object") {
      Object.assign(extraFields, annotations);
    }

    const inspectItem = (item: unknown) => {
      if (item instanceof Error) {
        Object.assign(extraFields, errorDiagnostic(item));
        if ("code" in item && typeof item.code === "string") {
          extraFields.error_code = item.code;
        }
      } else if (item && typeof item === "object" && "_tag" in item) {
        Object.assign(extraFields, errorDiagnostic(item));
        if ("code" in item && typeof (item as { code?: unknown }).code === "string") {
          extraFields.error_code = (item as { code: string }).code;
        }
      }
    };

    if (Array.isArray(message)) {
      for (const item of message) {
        if (typeof item === "string" && event === "effect_log") {
          event = item;
        } else if (item && typeof item === "object") {
          inspectItem(item);
          Object.assign(extraFields, item);
        }
      }
    } else if (typeof message === "string") {
      event = message;
    } else if (message && typeof message === "object") {
      inspectItem(message);
      Object.assign(extraFields, message);
    }

    const fields: LogFields = {
      event,
      outcome:
        (extraFields.outcome as number | string | undefined) ??
        (level === "error" ? "failure" : "success"),
      retry_class: (extraFields.retry_class as RetryClass | undefined) ?? "none",
      ...extraFields,
    };

    log(level, context, fields);
  });
}

/**
 * Creates an Effect Layer that configures Meltiply structured logging for all child operations.
 *
 * Replaces the default Effect console logger with Meltiply's JSON logger, ensuring all
 * `Effect.log*` calls carry request, trace, and service context matching backend conventions.
 *
 * @param context - Execution environment and correlation identifiers for the request or task.
 * @returns Layer providing the configured logger to the surrounding runtime.
 */
export function effectLoggerLayer(context: LogContext): Layer.Layer<never, never, never> {
  return Logger.layer([createEffectLogger(context)]);
}
