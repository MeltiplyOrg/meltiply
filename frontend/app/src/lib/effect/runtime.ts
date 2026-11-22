import { Cause, Effect, Exit, Option, Result, type Scope } from "effect";

export interface RunQueryEffectOptions {
  readonly signal?: AbortSignal;
}

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

  if (Cause.hasDies(exit.cause)) {
    const dieResult = Cause.findDie(exit.cause);
    const defect = Result.isSuccess(dieResult)
      ? dieResult.success.defect
      : Cause.squash(exit.cause);
    throw defect;
  }

  if (Cause.hasInterrupts(exit.cause)) {
    throw options?.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  const maybeError = Cause.findErrorOption(exit.cause);
  if (Option.isSome(maybeError)) {
    throw maybeError.value;
  }

  throw Cause.squash(exit.cause);
}
