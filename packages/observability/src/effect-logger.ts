import { Logger, type Layer } from "effect";
import { CurrentLogAnnotations } from "effect/References";

import { effectLogEntry } from "./effect-log-fields";
import { log, type LogContext } from "./log";

/**
 * Routes `Effect.log*` through `log`. The first string message becomes the event; object messages
 * merge into the fields, and an Error or tagged value also becomes the line's `error`.
 */
export function effectLoggerLayer(context: LogContext): Layer.Layer<never> {
  return Logger.layer([
    Logger.make(({ fiber, logLevel, message }) => {
      const { level, fields } = effectLogEntry(
        message,
        fiber.getRef(CurrentLogAnnotations),
        logLevel,
      );
      log(level, context, fields);
    }),
  ]);
}
