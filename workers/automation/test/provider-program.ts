import { Effect } from "effect";
import {
  createProviderServiceLive,
  type ProviderRegistry,
  type ProviderService,
} from "@meltiply/providers";

/**
 * Executes a provider program at the test boundary using the supplied registry.
 * Evaluates fixtures once and preserves the same normalized outcome contract
 * exercised by production job programs without keeping Promise wrappers in source.
 */
export function runProviderProgram<A, E, Args extends [ProviderRegistry, ...unknown[]]>(
  program: (...args: Args) => Effect.Effect<A, E, ProviderService>,
  ...args: Args
): Promise<A> {
  return Effect.runPromise(Effect.provide(program(...args), createProviderServiceLive(args[0])));
}
