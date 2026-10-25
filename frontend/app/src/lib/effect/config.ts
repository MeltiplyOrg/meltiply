import { Context, Effect, Layer } from "effect";

import { getPublicEnv, isDevMode, type PublicEnv } from "../env";

/**
 * Service shape exposing validated public frontend configuration.
 * Values are read through `Effect`s so configuration resolution stays lazy and
 * participates in the Effect runtime rather than executing at import time.
 */
export interface PublicConfigServiceShape {
  readonly publicEnv: Effect.Effect<PublicEnv, never, never>;
  readonly apiBaseUrl: Effect.Effect<string, never, never>;
  readonly devMode: Effect.Effect<boolean, never, never>;
}

/**
 * Service tag for public frontend configuration (API origin, dev mode).
 *
 * This is the Effect-facing view over `lib/env.ts`, the only module permitted
 * to read `import.meta.env`. Invalid `APP_URL` configuration surfaces as a
 * defect at resolution time, matching the existing `getPublicEnv` throw.
 */
export class PublicConfigService extends Context.Service<
  PublicConfigService,
  PublicConfigServiceShape
>()("PublicConfigService") {}

/**
 * Production layer resolving public configuration from `import.meta.env`
 * through the `lib/env.ts` config adapter.
 */
export const PublicConfigServiceLive: Layer.Layer<PublicConfigService, never, never> =
  Layer.succeed(PublicConfigService, {
    publicEnv: Effect.sync(() => getPublicEnv()),
    apiBaseUrl: Effect.sync(() => getPublicEnv().APP_URL),
    devMode: Effect.sync(() => isDevMode()),
  });

/**
 * Feature availability flags derived from public configuration.
 * Each flag is an `Effect` so availability is evaluated when consumed, keeping
 * overrides testable through `PublicConfigService` substitution.
 */
export interface FeatureAvailabilityServiceShape {
  readonly devToolingEnabled: Effect.Effect<boolean, never, never>;
}

/**
 * Service tag for frontend feature availability decisions.
 *
 * Centralizes "is this capability configured" checks so UI surfaces read one
 * honest availability source instead of re-deriving configuration state ad hoc.
 */
export class FeatureAvailabilityService extends Context.Service<
  FeatureAvailabilityService,
  FeatureAvailabilityServiceShape
>()("FeatureAvailabilityService") {}

/**
 * Production layer deriving feature availability from `PublicConfigService`.
 * The dependency is provided internally so consumers can supply this layer
 * standalone without wiring the config layer separately.
 */
export const FeatureAvailabilityServiceLive: Layer.Layer<FeatureAvailabilityService, never, never> =
  Layer.effect(
    FeatureAvailabilityService,
    Effect.gen(function* () {
      const config = yield* PublicConfigService;
      return {
        devToolingEnabled: config.devMode,
      };
    }),
  ).pipe(Layer.provide(PublicConfigServiceLive));
