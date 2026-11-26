import { Logger, type Layer, type LogLevel } from "effect";
import { CurrentLogAnnotations } from "effect/References";

import { log, type LogContext, type LogFields, type RetryClass } from "./log";

const levels: Readonly<Record<LogLevel.LogLevel, "debug" | "error" | "info" | "warn">> = {
  All: "info",
  Debug: "debug",
  Error: "error",
  Fatal: "error",
  Info: "info",
  None: "info",
  Trace: "debug",
  Warn: "warn",
};

function isThrown(item: object): boolean {
  return item instanceof Error || "_tag" in item;
}

/**
 * Routes `Effect.log*` through `log`. The first string message becomes the event; object messages
 * merge into the fields, and an Error or tagged value also becomes the line's `error`.
 */
export function effectLoggerLayer(context: LogContext): Layer.Layer<never> {
  return Logger.layer([
    Logger.make(({ fiber, logLevel, message }) => {
      const extraFields: Record<string, unknown> = { ...fiber.getRef(CurrentLogAnnotations) };
      let event: string | undefined;
      for (const item of Array.isArray(message) ? message : [message]) {
        if (typeof item === "string") {
          event ??= item;
        } else if (item !== null && typeof item === "object") {
          Object.assign(extraFields, item);
          if (isThrown(item)) {
            extraFields.error = item;
            if ("code" in item && typeof item.code === "string") extraFields.error_code = item.code;
          }
        }
      }
      const level = levels[logLevel];
      const fields: LogFields = {
        event: event ?? "effect_log",
        outcome:
          (extraFields.outcome as number | string | undefined) ??
          (level === "error" ? "failure" : "success"),
        retry_class: (extraFields.retry_class as RetryClass | undefined) ?? "none",
        ...extraFields,
      };
      log(level, context, fields);
    }),
  ]);
}
