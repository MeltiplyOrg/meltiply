import { Data } from "effect";

/**
 * Tagged error for transient automation failures that Cloudflare should
 * redeliver with exponential backoff (queue retry or workflow step retry).
 * Never used for poison messages: those fail with TerminalJobError instead.
 */
export class RetryableJobError extends Data.TaggedError("RetryableJobError")<{
  readonly attempt?: number;
  readonly cause?: string;
  readonly message: string;
}> {}

/**
 * Tagged error for permanent automation failures: corrupt queue payloads,
 * producer-contract violations, unrecoverable validation. The boundary acks
 * the message (or marks the outbox row dead) and surfaces diagnostics instead
 * of burning the retry budget before the DLQ receives the message.
 */
export class TerminalJobError extends Data.TaggedError("TerminalJobError")<{
  readonly cause?: string;
  readonly code: string;
  readonly message: string;
}> {}

/**
 * Tagged error for ambiguous provider-write outcomes where a side effect may
 * have committed remotely. Resolved by lookup/reconciliation, never by blind
 * automatic retry, so a duplicated remote post cannot be created.
 */
export class AmbiguousJobError extends Data.TaggedError("AmbiguousJobError")<{
  readonly code: string;
  readonly message: string;
}> {}

/**
 * Union of typed automation job failures carried on the Effect failure channel.
 */
export type AutomationJobError = RetryableJobError | TerminalJobError | AmbiguousJobError;

/**
 * Detects an ambiguous provider failure descriptor on a thrown value.
 *
 * Narrowing (not casting) keeps the read checked: only objects whose `failure`
 * member is itself an object with classification "ambiguous" qualify, so
 * unshaped throws fall through to generic paths. The code may be absent on
 * foreign throws, in which case the caller applies its fallback code.
 *
 * @param value - Unknown thrown value to inspect.
 * @returns Present marker with optional code, or undefined when not ambiguous.
 */
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

/**
 * Classifies an unknown queue-handler throw into a typed job error.
 *
 * Preserves explicit typed outcomes and ambiguous provider classifications.
 * All other throws remain retryable: an Error's class or message cannot prove
 * that a delivery is invalid. Payload guards must signal TerminalJobError.
 *
 * @param cause - Thrown value from a queue/scheduled/workflow unit of work.
 * @param fallbackCode - Diagnostic code recorded when cause carries no code.
 * @returns Typed AutomationJobError for the boundary to map to ack/retry/DLQ.
 */
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
    if (cause.name === "JobInProgressError") {
      return new RetryableJobError({
        cause: cause.name,
        message: cause.message,
      });
    }
    if (cause.name === "RetryableReplyError") {
      return new RetryableJobError({
        cause: cause.name,
        message: cause.message,
      });
    }
    return new RetryableJobError({
      cause: cause.name,
      message: cause.message,
    });
  }
  return new RetryableJobError({ message: "unknown job error" });
}

/**
 * Reconstructs the original thrown Error from a typed job error wrapper.
 *
 * classifyJobError records the original error's `name` in the wrapper's
 * `cause` field, but diagnostics such as errorDiagnostic read name/message
 * off the error itself — without unwrapping, retry logs group under
 * "RetryableJobError" instead of the true type. Rebuilding a plain Error
 * carrying the original name and message lets re-diagnosis emit the original
 * error.name and fingerprint. Wrappers that carry no original name, and the
 * "unknown job error" fallback (which wraps a non-Error throw), pass through
 * unchanged since there is nothing to restore.
 *
 * @param error - Typed AutomationJobError from classifyJobError or an Exit cause.
 * @returns Error with the original name/message, or `error` itself when it
 *   does not wrap a named original (already an Error for diagnostics).
 */
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
