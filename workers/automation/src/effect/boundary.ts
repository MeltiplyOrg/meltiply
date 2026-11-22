import { Cause, Effect, Exit, Option } from "effect";
import { configureLogSampling, errorDiagnostic, log } from "@meltiply/observability";
import type { AutomationEnv } from "../env";
import { nextDelaySeconds, QUEUE_RETRY_POLICY } from "../retry-policy";
import type { JobScope } from "./scope";
import {
  AmbiguousJobError,
  classifyJobError,
  RetryableJobError,
  TerminalJobError,
  unwrapJobError,
  type AutomationJobError,
} from "./job-errors";

export type JobOutcome = "processed" | "retry" | "rejected" | "ambiguous";

export function exitToJobOutcome<A, E>(
  exit: Exit.Exit<A, E>,
): {
  diagnostic?: Record<string, unknown>;
  failure?: unknown;
  outcome: JobOutcome;
} {
  if (Exit.isSuccess(exit)) return { outcome: "processed" };
  const failure = recoverJobErrorCause(exit.cause);
  if (Cause.hasDies(exit.cause)) {
    const defect = Cause.squash(exit.cause);
    return {
      diagnostic: {
        error_code: "queue_job_failed",
        ...errorDiagnostic(defect),
      },
      failure,
      outcome: "retry",
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      diagnostic: {
        error_code: "queue_job_interrupted",
        ...errorDiagnostic(Cause.squash(exit.cause)),
      },
      failure,
      outcome: "retry",
    };
  }
  const maybeError = Cause.findErrorOption(exit.cause);
  const original = Option.isSome(maybeError) ? maybeError.value : null;
  const typed: AutomationJobError =
    original instanceof Error
      ? classifyJobError(original)
      : new RetryableJobError({ message: "unknown job error" });
  if (typed instanceof TerminalJobError) {
    return {
      diagnostic: { error_code: typed.code, ...errorDiagnostic(typed) },
      failure,
      outcome: "rejected",
    };
  }
  if (typed instanceof AmbiguousJobError) {
    return {
      diagnostic: { error_code: typed.code, ...errorDiagnostic(typed) },
      failure,
      outcome: "ambiguous",
    };
  }
  return {
    diagnostic: {
      error_code: "queue_job_failed",
      ...errorDiagnostic(unwrapJobError(typed)),
    },
    failure,
    outcome: "retry",
  };
}

export function runJobProgram<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(program);
}

export function recoverJobErrorCause(cause: Cause.Cause<unknown>): unknown {
  const recovered = Cause.findErrorOption(cause);
  return Option.isSome(recovered) && recovered.value instanceof Error
    ? unwrapJobError(recovered.value as AutomationJobError)
    : Cause.squash(cause);
}

export function queueBackoffDelaySeconds(attempts: number): number {
  return (
    nextDelaySeconds(QUEUE_RETRY_POLICY, Math.max(0, attempts)) ?? QUEUE_RETRY_POLICY.maxSeconds
  );
}

export function configureJobLogging(env: AutomationEnv): void {
  configureLogSampling(env.LOG_SAMPLE_RATE);
}

export function logJobOutcome(
  scope: JobScope,
  outcome: JobOutcome,
  fields: {
    attempts?: number;
    diagnostic?: Record<string, unknown>;
    event: string;
    job: string;
    latencyMs: number;
    messageId?: string;
    queue?: string;
  },
): void {
  const level = outcome === "processed" ? "info" : outcome === "rejected" ? "warn" : "error";
  log(level, scope.logContext, {
    ...(fields.attempts !== undefined ? { attempts: fields.attempts } : {}),
    ...(fields.diagnostic ?? {}),
    event: fields.event,
    job: fields.job,
    latency_ms: fields.latencyMs,
    ...(fields.messageId ? { message_id: fields.messageId } : {}),
    outcome: outcome === "processed" ? "succeeded" : outcome,
    ...(fields.queue ? { queue: fields.queue } : {}),
    retry_class:
      outcome === "retry" ? "queue_backoff" : outcome === "ambiguous" ? "reconciliation" : "none",
  });
}
