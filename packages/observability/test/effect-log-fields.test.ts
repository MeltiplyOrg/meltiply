import { describe, expect, it } from "vite-plus/test";

import { effectLogEntry } from "../src/effect-log-fields";

const defaults = { event: "effect_log", outcome: "success", retry_class: "none" };

describe("effectLogEntry", () => {
  it.each([
    ["one event name", ["loaded"], { ...defaults, event: "loaded" }],
    ["a bare string", "loaded", { ...defaults, event: "loaded" }],
    ["a second string", ["loaded", "ignored"], { ...defaults, event: "loaded" }],
    ["no message", [], defaults],
    ["a null and a number", [null, 7], defaults],
    ["a plain object", [{ job: "sync" }], { ...defaults, job: "sync" }],
  ])("%s", (_example, message, fields) => {
    expect(effectLogEntry(message, {}, "Info")).toEqual({ level: "info", fields });
  });

  it("an error with a code", () => {
    const error = Object.assign(new Error("timeout"), { code: "database_timeout" });

    expect(effectLogEntry(["database_failed", error], {}, "Error")).toEqual({
      level: "error",
      fields: {
        code: "database_timeout",
        error,
        error_code: "database_timeout",
        event: "database_failed",
        outcome: "failure",
        retry_class: "none",
      },
    });
  });

  it("a tagged value without a code", () => {
    const tagged = { _tag: "NotFoundError" };

    expect(effectLogEntry([tagged], {}, "Warn")).toEqual({
      level: "warn",
      fields: { ...defaults, _tag: "NotFoundError", error: tagged },
    });
  });

  it("annotations that set the outcome and retry class", () => {
    const annotations = { outcome: 503, provider: "threads", retry_class: "provider_backoff" };

    expect(effectLogEntry("sync", annotations, "Error")).toEqual({
      level: "error",
      fields: { event: "sync", ...annotations },
    });
  });

  it.each([
    ["All", "info"],
    ["Trace", "debug"],
    ["Debug", "debug"],
    ["Info", "info"],
    ["Warn", "warn"],
    ["None", "info"],
  ] as const)("the %s level", (logLevel, level) => {
    expect(effectLogEntry([], {}, logLevel)).toEqual({ level, fields: defaults });
  });

  it("the Fatal level", () => {
    expect(effectLogEntry([], {}, "Fatal")).toEqual({
      level: "error",
      fields: { ...defaults, outcome: "failure" },
    });
  });
});
