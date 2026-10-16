import { Cause, Effect, Exit, Option } from "effect";
import { configureLogSampling, errorDiagnostic, log } from "@meltiply/observability";
import type { AutomationEnv } from "../env";
import type { JobScope } from "./scope";
import {
  AmbiguousJobError,
  classifyJobError,
  RetryableJobError,
  TerminalJobError,
  unwrapJobError,
  type AutomationJobError,
} from "./job-errors";

/**
 * Outcome of running one job program at the automation boundary.
 */
export type JobOutcome = "processed" | "retry" | "rejected" | "ambiguous";

/**
 * Maps a finished Effect Exit to a boundary outcome plus logging diagnostics.
 *
 * Pure mapping shared by every entry point: success → processed,
 * RetryableJobError → retry, TerminalJobError → rejected, AmbiguousJobError →
 * ambiguous (reconciliation, never automatic retry). Defects retry with their
 * diagnostic; pure interruption retries as an interrupted delivery rather than an
 * unknown error. Kept in the pg-free boundary module so unit tests can pin mapping.
 *
 * @param exit - Finished Effect Exit from a job program.
 * @returns Boundary outcome plus an optional diagnostic for logging.
 */
export function exitToJobOutcome<A, E>(
  exit: Exit.Exit<A, E>,
): { diagnostic?: Record<string, unknown>; outcome: JobOutcome } {
  if (Exit.isSuccess(exit)) return { outcome: "processed" };
  if (Cause.hasDies(exit.cause)) {
    const defect = Cause.squash(exit.cause);
    return {
      diagnostic: {
        error_code: "queue_job_failed",
        ...errorDiagnostic(defect),
      },
      outcome: "retry",
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      diagnostic: {
        error_code: "queue_job_interrupted",
        ...errorDiagnostic(Cause.squash(exit.cause)),
      },
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
      outcome: "rejected",
    };
  }
  if (typed instanceof AmbiguousJobError) {
    return {
      diagnostic: { error_code: typed.code, ...errorDiagnostic(typed) },
      outcome: "ambiguous",
    };
  }
  // Preserve the original exception name and fingerprint in the error envelope.
  // The typed wrapper stores the original name in `cause`; unwrapJobError
  // restores that name/message so operators can group the underlying failure.
  return {
    diagnostic: {
      error_code: "queue_job_failed",
      ...errorDiagnostic(unwrapJobError(typed)),
    },
    outcome: "retry",
  };
}

/**
 * Runs one Effect job program to its Exit without providing layers.
 *
 * Thin await point kept beside the mapping so the only `Effect.run*` call in
 * automation queue/scheduled/workflow handling lives in the boundary. Layer
 * provision happens in the caller (production wires live layers; tests wire
 * test layers), so this module never imports `pg`-backed factories.
 *
 * @param program - Effect program with layers already provided by the caller.
 * @returns Finished Effect Exit for exitToJobOutcome.
 */
export function runJobProgram<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(program);
}

/**
 * Recovers the original thrown value from a finished program's Cause.
 *
 * Restores the pre-migration error shape for rethrow and errorDiagnostic
 * grouping: when the first failure on the cause is an Error (typically a
 * classified AutomationJobError wrapper), unwrapJobError rebuilds an Error
 * carrying the original name/message; non-Error failures and pure defects
 * fall back to Cause.squash. Used by the scheduled handler's failure log and
 * runDirectProgram's RPC rejection so callers observe the same error identity
 * the Promise-based implementation threw.
 *
 * @param cause - Failure Cause from a finished job program Exit.
 * @returns The unwrapped original Error, or the squashed cause value.
 */
export function recoverJobErrorCause(cause: Cause.Cause<unknown>): unknown {
  const recovered = Cause.findErrorOption(cause);
  return Option.isSome(recovered) && recovered.value instanceof Error
    ? unwrapJobError(recovered.value as AutomationJobError)
    : Cause.squash(cause);
}

/**
 * Queue backoff delay mirroring the existing queue handler schedule
 * (`min(3600s, 15s * 2^attempts)`) so Effect-run jobs redeliver on the same
 * cadence the database retry path uses.
 *
 * @param attempts - Cloudflare delivery attempt count.
 * @returns Delay in seconds bounded to [15, 3600].
 */
export function queueBackoffDelaySeconds(attempts: number): number {
  return Math.min(3_600, 15 * 2 ** Math.max(0, attempts));
}

/**
 * Configures log sampling for one automation invocation. Thin wrapper kept at
 * the boundary so handler modules share one sampling entry point.
 *
 * @param env - Automation worker environment bindings.
 */
export function configureJobLogging(env: AutomationEnv): void {
  configureLogSampling(env.LOG_SAMPLE_RATE);
}

/**
 * Emits the unified outcome log for one finished job program.
 *
 * @param scope - Isolated job scope the program ran in.
 * @param outcome - Boundary outcome from exitToJobOutcome.
 * @param fields - Event/job/queue correlation for the log record.
 */
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
