import { Effect, Layer, type Scope } from "effect";

import { ApiClientService, ApiClientServiceLive } from "./api-client";
import {
  FeatureAvailabilityService,
  FeatureAvailabilityServiceLive,
  PublicConfigService,
  PublicConfigServiceLive,
} from "./config";
import { runQueryEffect, type RunQueryEffectOptions } from "./runtime";
import { FrontendTelemetryService, FrontendTelemetryServiceLive } from "./telemetry";
import { WorkspaceService, type SessionScope } from "./session-scope";

/**
 * Union of every frontend Effect service provided to programs run through
 * `runFrontendEffect`.
 */
export type FrontendServices =
  | ApiClientService
  | WorkspaceService
  | FeatureAvailabilityService
  | FrontendTelemetryService
  | PublicConfigService;

/**
 * Static frontend services shared by every query program.
 *
 * These services contain no user, workspace, or request state. Reusing their Layer
 * graph avoids rebuilding its composition per query while each execution still gets
 * a fresh fiber and receives its workspace directly at the boundary.
 */
const frontendStaticServicesLive = Layer.mergeAll(
  ApiClientServiceLive,
  FeatureAvailabilityServiceLive,
  FrontendTelemetryServiceLive,
  PublicConfigServiceLive,
);

/**
 * Runs a frontend Effect program against the production service layer through
 * the approved `runQueryEffect` boundary.
 *
 * This is the single entry point query and mutation hooks use to execute
 * service programs. Authentication is ambient — the API client sends the
 * instead the selected Workspace is provided directly per invocation, keeping each
 * request's tenancy isolated from other in-flight requests and out of module-global
 * state. The caller's AbortSignal is forwarded for cancellation, typed failures
 * (`ApiError`) surface as promise rejections, and defects propagate unmasked.
 *
 * @param scope Session scope for this invocation; `scope.workspaceId` selects
 *   the Workspace (null = personal workspace), `scope.isSignedIn` is used by
 *   callers to gate execution.
 * @param program Effect program requiring frontend services (and optionally `Scope`).
 * @param options Optional abort signal forwarded to the runtime boundary.
 * @returns Promise resolving to the program's success value.
 */
export function runFrontendEffect<A, E>(
  scope: SessionScope,
  program: Effect.Effect<A, E, FrontendServices | Scope.Scope>,
  options?: RunQueryEffectOptions,
): Promise<A> {
  return runQueryEffect(
    Effect.provideService(Effect.provide(program, frontendStaticServicesLive), WorkspaceService, {
      workspaceId: scope.workspaceId,
    }),
    options,
  );
}
