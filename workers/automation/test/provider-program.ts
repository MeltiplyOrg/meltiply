import { Effect } from "effect";
import {
  createProviderServiceLive,
  type ProviderRegistry,
  type ProviderService,
} from "@meltiply/providers";

export function runProviderProgram<A, E, Args extends [ProviderRegistry, ...unknown[]]>(
  program: (...args: Args) => Effect.Effect<A, E, ProviderService>,
  ...args: Args
): Promise<A> {
  return Effect.runPromise(Effect.provide(program(...args), createProviderServiceLive(args[0])));
}
