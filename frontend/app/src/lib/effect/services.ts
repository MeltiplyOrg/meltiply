import { Effect, type Scope } from "effect";

import { ApiClientService, ApiClientServiceLive } from "./api-client";
import { runQueryEffect, type RunQueryEffectOptions } from "./runtime";
import { WorkspaceService, type SessionScope } from "./session-scope";

export type FrontendServices = ApiClientService | WorkspaceService;

export function runFrontendEffect<A, E>(
  scope: SessionScope,
  program: Effect.Effect<A, E, FrontendServices | Scope.Scope>,
  options?: RunQueryEffectOptions,
): Promise<A> {
  return runQueryEffect(
    Effect.provideService(Effect.provide(program, ApiClientServiceLive), WorkspaceService, {
      workspaceId: scope.workspaceId,
    }),
    options,
  );
}
