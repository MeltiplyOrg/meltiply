import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { configureLogSampling, log, type LogContext } from "../src/log";

const context: LogContext = {
  environment: "staging",
  job_id: "job-1",
  request_id: "request-1",
  service: "automation",
  trace_id: "trace-1",
  user_id: "user-1",
  version: "test-version",
  workflow_id: "workflow-1",
};

const line = {
  context: { event: "job_completed", outcome: "processed", retry_class: "none" },
  environment: "staging",
  job_id: "job-1",
  level: "info",
  message: "job completed",
  request_id: "request-1",
  service: "automation",
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  trace_id: "trace-1",
  user_id: "user-1",
  version: "test-version",
  workflow_id: "workflow-1",
};

const fields = { event: "job_completed", outcome: "processed", retry_class: "none" } as const;

const levels = ["debug", "error", "info", "warn"] as const;
let written: [string, unknown][];
let shipped: [string, RequestInit][];

beforeAll(() => {
  const silenced = vi.spyOn(console, "debug").mockImplementation(() => {});
  log("debug", context, fields);
  silenced.mockRestore();
});

beforeEach(() => {
  written = [];
  shipped = [];
  for (const level of levels) {
    vi.spyOn(console, level).mockImplementation((text: string) => {
      written.push([level, JSON.parse(text)]);
    });
  }
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    shipped.push([url, init]);
    return Promise.reject(new TypeError("collector offline"));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureLogSampling(undefined);
});

describe("log", () => {
  it.each(levels)("a %s line", (level) => {
    log(level, context, fields);

    expect(written).toEqual([[level, { ...line, level }]]);
  });

  it("an explicit message carrying a credential, a route and an error", () => {
    const error = new TypeError("boom");
    error.stack = undefined;

    log(
      "error",
      { ...context, route: "/api/v1/health" },
      { ...fields, message: "token=secret failed", error, authorization: "Bearer x" },
    );

    expect(written).toEqual([
      [
        "error",
        {
          ...line,
          context: { ...line.context, authorization: "[REDACTED]", route: "/api/v1/health" },
          error: { fingerprint: "fc8529cc622ce842", message: "boom", name: "TypeError" },
          level: "error",
          message: "token=[REDACTED] failed",
        },
      ],
    ]);
  });

  it("an event of only underscores", () => {
    log("info", context, { ...fields, event: "___" });

    expect(written).toEqual([
      ["info", { ...line, context: { ...line.context, event: "___" }, message: "log event" }],
    ]);
  });

  it("info below the configured sampling rate", () => {
    configureLogSampling(0);

    log("info", context, fields);

    expect(written).toEqual([]);
  });

  it("a local line", () => {
    log("info", { ...context, environment: "local" }, fields);

    expect(written).toEqual([["info", { ...line, environment: "local" }]]);
    expect(shipped).toEqual([
      [
        "http://127.0.0.1:3100/loki/api/v1/push",
        {
          body: expect.stringContaining(
            '"stream":{"environment":"local","job":"meltiply-worker","level":"info","service":"automation"}',
          ),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
    ]);
  });

  it("a line outside the local environment", () => {
    log("info", context, fields);

    expect(shipped).toEqual([]);
  });
});
