import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import { effectLoggerLayer, type LogContext } from "../src";

// Every case logs with `environment: "test"`, which makes the sink attempt a
// local Loki push. Stub the transport so the suite never performs real
// network I/O, and restore centrally so a failing assertion cannot leave
// `console.*`/`fetch` mocked for the cases after it.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Effect Observability Logger Integration", () => {
  it("routes Effect.log calls to Meltiply structured log with context and redaction", async () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const context: LogContext = {
      environment: "test",
      request_id: "req-999",
      service: "api-worker",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      yield* Effect.log("user_profile_loaded");
    }).pipe(Effect.provide(effectLoggerLayer(context)));

    await Effect.runPromise(program);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
    expect(logged.level).toBe("info");
    expect(logged.service).toBe("api-worker");
    expect(logged.request_id).toBe("req-999");
    expect(logged.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(logged.context.event).toBe("user_profile_loaded");

    consoleSpy.mockRestore();
  });

  it("handles error levels and redacts sensitive data in Effect logs", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const context: LogContext = {
      environment: "test",
      request_id: "req-error-1",
      service: "api-worker",
      trace_id: "trace-err-1",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      yield* Effect.logError("auth_failure").pipe(
        Effect.annotateLogs({ access_token: "provider-access-secret" }),
      );
    }).pipe(Effect.provide(effectLoggerLayer(context)));

    await Effect.runPromise(program);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = String(consoleSpy.mock.calls[0]?.[0]);
    const logged = JSON.parse(line);
    expect(logged.level).toBe("error");
    expect(logged.context.event).toBe("auth_failure");
    // The claim in this case's name is redaction, so the annotation carrying a
    // credential must reach the line masked rather than verbatim.
    expect(logged.context.access_token).toBe("[REDACTED]");
    expect(line).not.toContain("provider-access-secret");

    consoleSpy.mockRestore();
  });

  it("bridges Effect log annotations into structured telemetry fields", async () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const context: LogContext = {
      environment: "test",
      request_id: "req-ann-1",
      service: "automation-worker",
      trace_id: "trace-ann-1",
      version: "1.0.0",
    };

    const program = Effect.gen(function* () {
      yield* Effect.log("provider_sync_completed").pipe(
        Effect.annotateLogs({
          error_code: "none",
          job: "sync_job_42",
          provider: "threads",
          retry_class: "provider_backoff",
        }),
      );
    }).pipe(Effect.provide(effectLoggerLayer(context)));

    await Effect.runPromise(program);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
    expect(logged.context.provider).toBe("threads");
    expect(logged.context.job).toBe("sync_job_42");
    expect(logged.context.retry_class).toBe("provider_backoff");
    expect(logged.context.error_code).toBe("none");

    consoleSpy.mockRestore();
  });

  it("bridges Error objects and attaches error diagnostics and error codes", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const context: LogContext = {
      environment: "test",
      request_id: "req-err-diag",
      service: "api-worker",
      trace_id: "trace-err-diag",
      version: "1.0.0",
    };

    const error = Object.assign(new Error("Connection timeout"), {
      // The case name promises the code is bridged; without a code on the
      // thrown value the `error_code` branch is never reached.
      code: "database_timeout",
    });
    error.name = "DatabaseTimeoutError";

    const program = Effect.gen(function* () {
      yield* Effect.logError("database_failed", error);
    }).pipe(Effect.provide(effectLoggerLayer(context)));

    await Effect.runPromise(program);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
    expect(logged.level).toBe("error");
    expect(logged.context.event).toBe("database_failed");
    expect(logged.context.error_code).toBe("database_timeout");
    expect(logged.context.outcome).toBe("failure");
    expect(logged.error.name).toBe("DatabaseTimeoutError");
    expect(logged.error.message).toBe("Connection timeout");
    expect(logged.error.stack).toContain("DatabaseTimeoutError: Connection timeout");

    consoleSpy.mockRestore();
  });
});
