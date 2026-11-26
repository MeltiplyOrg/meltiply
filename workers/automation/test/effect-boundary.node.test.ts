import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AmbiguousJobError,
  classifyJobError,
  exitToJobOutcome,
  jobScope,
  queueBackoffDelaySeconds,
  RetryableJobError,
  runJobProgram,
  TerminalJobError,
} from "../src/effect/index";
import { makeJobContext } from "../src/effect/job-context";
import { unwrapJobError } from "../src/effect/job-errors";
import { JobInProgressError } from "../src/job-lease";

function scope() {
  return jobScope(
    { ENVIRONMENT: "test", VERSION: "1" },
    makeJobContext({ jobId: "job-1", source: "queue", traceId: "trace-1" }),
  );
}

describe("automation Effect boundary mapping", () => {
  it("maps success to processed", async () => {
    const exit = await runJobProgram(Effect.provide(Effect.succeed("ok"), scope().runtimeLayer));
    expect(exitToJobOutcome(exit)).toEqual({ outcome: "processed" });
  });

  it("maps retryable failures to retry with the queue backoff code", async () => {
    const exit = await runJobProgram(
      Effect.provide(Effect.fail(new RetryableJobError({ message: "boom" })), scope().runtimeLayer),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("retry");
    expect(mapped.diagnostic?.error_code).toEqual("queue_job_failed");
  });

  it("preserves the original throw's error type in retry diagnostics", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.tryPromise({
          catch: (cause) => classifyJobError(cause),
          try: () => Promise.reject(new Error("transient failure")),
        }),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("retry");
    expect(mapped.diagnostic?.error).toMatchObject({ name: "Error" });
  });

  it("keeps the JobInProgressError name through classification and unwrap", () => {
    const classified = classifyJobError(new JobInProgressError());
    expect(classified).toBeInstanceOf(RetryableJobError);
    expect(classified).toMatchObject({ cause: "JobInProgressError" });
    const unwrapped = unwrapJobError(classified);
    expect(unwrapped).toBeInstanceOf(Error);
    expect(unwrapped.name).toEqual("JobInProgressError");
  });

  it("emits the original lease-conflict type in retry diagnostics", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.tryPromise({
          catch: (cause) => classifyJobError(cause),
          try: () => Promise.reject(new JobInProgressError()),
        }),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("retry");
    expect(mapped.diagnostic?.error_code).toEqual("queue_job_failed");
    expect(mapped.diagnostic?.error).toMatchObject({ name: "JobInProgressError" });
  });

  it("maps terminal failures to rejected for ack-and-surface handling", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.fail(
          new TerminalJobError({
            cause: "TypeError",
            code: "unknown_message_type",
            message: "unsupported queue message",
          }),
        ),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("rejected");
    expect(mapped.diagnostic?.error_code).toEqual("unknown_message_type");
  });

  it("never maps ambiguous provider outcomes to automatic retry", async () => {
    const exit = await runJobProgram(
      Effect.provide(
        Effect.fail(
          new AmbiguousJobError({
            code: "provider_call_failed",
            message: "side effect may have committed",
          }),
        ),
        scope().runtimeLayer,
      ),
    );
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("ambiguous");
  });

  it("classifies ambiguous provider throws as ambiguous, not retryable", () => {
    const thrown = Object.assign(new Error("timeout during publish"), {
      failure: { classification: "ambiguous", code: "provider_timeout" },
    });
    expect(classifyJobError(thrown)).toBeInstanceOf(AmbiguousJobError);
  });

  it("maps unexpected defects to retry", async () => {
    const exit = await runJobProgram(
      Effect.provide(Effect.die(new Error("unexpected defect")), scope().runtimeLayer),
    );
    expect(exitToJobOutcome(exit).outcome).toEqual("retry");
  });

  it("retries pure interruption with a cancellation diagnostic", async () => {
    const exit = await runJobProgram(Effect.interrupt);
    const mapped = exitToJobOutcome(exit);
    expect(mapped.outcome).toEqual("retry");
    expect(mapped.diagnostic?.error_code).toEqual("queue_job_interrupted");
    expect(mapped.diagnostic?.error).toMatchObject({ name: "Error" });
  });

  it.each([
    { attempt: 0, expected: 15 },
    { attempt: 1, expected: 30 },
    { attempt: 2, expected: 60 },
    { attempt: 100, expected: 3_600 },
  ])(
    "maintains queue backoff of $expected seconds for attempt $attempt",
    ({ attempt, expected }) => {
      expect(queueBackoffDelaySeconds(attempt)).toEqual(expected);
    },
  );
});
