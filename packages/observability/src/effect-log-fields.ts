import type { LogLevel } from "effect";

import type { LogFields, RetryClass } from "./log";

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

export function effectLogEntry(
  message: unknown,
  annotations: Readonly<Record<string, unknown>>,
  logLevel: LogLevel.LogLevel,
): { level: "debug" | "error" | "info" | "warn"; fields: LogFields } {
  const extraFields: Record<string, unknown> = { ...annotations };
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
  return { level, fields };
}
