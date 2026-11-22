import { Effect, type Scope } from "effect";

import { ApiClientService, ApiClientServiceLive } from "./api-client";
import { runQueryEffect, type RunQueryEffectOptions } from "./runtime";
import { WorkspaceService, type SessionScope } from "./session-scope";

/**
 * Union of frontend Effect services provided to programs run through
 * `runFrontendEffect`.
 */
export type FrontendServices = ApiClientService | WorkspaceService;

/**
 * Executes a frontend Effect program against the live API client layer and the
 * per-invocation Workspace selection through `runQueryEffect`.
 *
 * Authentication travels on the ambient bearer JWT stamped by `lib/api.ts`;
 * only the selected Workspace (`scope.workspaceId`, `null` for personal) is
 * provided per call so tenancy stays isolated across concurrent requests.
 *
 * @param scope Session scope selecting the Workspace (`null` = personal workspace).
 * @param program Effect program requiring `FrontendServices` (and optionally `Scope`).
 * @param options Optional abort signal forwarded to `runQueryEffect`.
 * @returns Promise resolving to the program's success value.
 */
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
