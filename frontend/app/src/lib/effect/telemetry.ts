import { Context, Effect, Layer } from "effect";

import {
  reportFrontendApiError,
  reportFrontendError,
  reportFrontendTelemetry,
  reportUnknownContractValue,
  type FrontendTelemetryDetail,
} from "../frontend-telemetry";

/**
 * Service shape for frontend telemetry reporting.
 * Reporters are fire-and-forget `Effect.sync` wrappers over the redacted
 * telemetry adapter in `lib/frontend-telemetry.ts`; they never fail and never
 * expose raw payloads.
 */
export interface FrontendTelemetryServiceShape {
  readonly reportApiError: (input: {
    code: string;
    requestId: string | null;
    retryable: boolean;
    status: number;
  }) => Effect.Effect<void, never, never>;
  readonly reportError: (error: unknown, context: string) => Effect.Effect<void, never, never>;
  readonly reportTelemetry: (detail: FrontendTelemetryDetail) => Effect.Effect<void, never, never>;
  readonly reportUnknownContractValue: (
    field: string,
    value: unknown,
  ) => Effect.Effect<void, never, never>;
}

/**
 * Service tag for emitting sanitized frontend telemetry events.
 *
 * Wraps the `lib/frontend-telemetry.ts` transport adapter (window CustomEvent
 * plus keepalive `POST /__frontend-telemetry`) so Effect programs report
 * failures through the same redaction pipeline as the rest of the app.
 */
export class FrontendTelemetryService extends Context.Service<
  FrontendTelemetryService,
  FrontendTelemetryServiceShape
>()("FrontendTelemetryService") {}

/**
 * Production layer delegating to the `lib/frontend-telemetry.ts` adapter.
 */
export const FrontendTelemetryServiceLive: Layer.Layer<FrontendTelemetryService, never, never> =
  Layer.succeed(FrontendTelemetryService, {
    reportApiError: (input) => Effect.sync(() => reportFrontendApiError(input)),
    reportError: (error, context) => Effect.sync(() => reportFrontendError(error, context)),
    reportTelemetry: (detail) => Effect.sync(() => reportFrontendTelemetry(detail)),
    reportUnknownContractValue: (field, value) =>
      Effect.sync(() => reportUnknownContractValue(field, value)),
  });
