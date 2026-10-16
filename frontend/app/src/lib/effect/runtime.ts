import { Cause, Effect, Exit, Option, Result, type Scope } from "effect";

export interface RunQueryEffectOptions {
  readonly signal?: AbortSignal;
}

/**
 * Approved execution boundary adapter that runs an Effect program for React Query.
 *
 * Rejects pre-aborted signals before synchronous work can start, delegates active
 * cancellation to Effect's runner (which removes its listener on fiber completion),
 * and inspects defects before recoverable failures.
 *
 * @param effect - Effect computation to execute, optionally requiring Scope for resource management.
 * @param options - Optional query configuration including AbortSignal.
 * @returns Promise resolving to the effect outcome value or rejecting with the failure/abort error/defect.
 */
export async function runQueryEffect<A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
  options?: RunQueryEffectOptions,
): Promise<A> {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  const exit = await Effect.runPromiseExit(Effect.scoped(effect), {
    signal: options?.signal,
  });

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  // 1. Inspect for unexpected defects first. Any cause containing a defect must surface the defect.
  if (Cause.hasDies(exit.cause)) {
    const dieResult = Cause.findDie(exit.cause);
    const defect = Result.isSuccess(dieResult)
      ? dieResult.success.defect
      : Cause.squash(exit.cause);
    throw defect;
  }

  // 2. Handle interruption / cancellation
  if (Cause.hasInterrupts(exit.cause)) {
    throw options?.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  // 3. Handle typed recoverable errors
  const maybeError = Cause.findErrorOption(exit.cause);
  if (Option.isSome(maybeError)) {
    throw maybeError.value;
  }

  // 4. Handle unhandled defects
  throw Cause.squash(exit.cause);
}
