import { Data } from "effect";

export class RetryableJobError extends Data.TaggedError("RetryableJobError")<{
  readonly attempt?: number;
  readonly cause?: string;
  readonly message: string;
}> {}

export class TerminalJobError extends Data.TaggedError("TerminalJobError")<{
  readonly cause?: string;
  readonly code: string;
  readonly message: string;
}> {}

export class AmbiguousJobError extends Data.TaggedError("AmbiguousJobError")<{
  readonly code: string;
  readonly message: string;
}> {}

export type AutomationJobError = RetryableJobError | TerminalJobError | AmbiguousJobError;

function ambiguousFailure(value: unknown): { code?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("failure" in value)) return undefined;
  const failure = value.failure;
  if (typeof failure !== "object" || failure === null) return undefined;
  if (!("classification" in failure)) return undefined;
  if (failure.classification !== "ambiguous") return undefined;
  if (!("code" in failure)) return {};
  return typeof failure.code === "string" ? { code: failure.code } : {};
}

export function classifyJobError(
  cause: unknown,
  fallbackCode = "queue_job_failed",
): AutomationJobError {
  if (
    cause instanceof RetryableJobError ||
    cause instanceof TerminalJobError ||
    cause instanceof AmbiguousJobError
  ) {
    return cause;
  }
  const ambiguous = ambiguousFailure(cause);
  if (ambiguous !== undefined) {
    return new AmbiguousJobError({
      code: ambiguous.code ?? fallbackCode,
      message: cause instanceof Error ? cause.message : "ambiguous provider outcome",
    });
  }
  if (cause instanceof Error) {
    return new RetryableJobError({
      cause: cause.name,
      message: cause.message,
    });
  }
  return new RetryableJobError({ message: "unknown job error" });
}

export function unwrapJobError(error: AutomationJobError): Error {
  if (
    error instanceof RetryableJobError &&
    error.cause !== undefined &&
    error.message !== "unknown job error"
  ) {
    return Object.assign(new Error(error.message), { name: error.cause });
  }
  return error;
}
