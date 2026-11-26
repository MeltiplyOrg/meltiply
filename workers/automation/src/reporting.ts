import { Effect, type Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createPostHogTransport,
  createReportingServiceLive,
  reportingConfiguration,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  type DeliverySummary,
  type ReportingConfiguration,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";

import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

export function automationReportingLayer(
  env: AutomationEnv,
  options: {
    readonly configuration?: ReportingConfiguration;
    readonly withTransport?: boolean;
  } = {},
): {
  readonly configuration: ReportingConfiguration;
  readonly layer: Layer.Layer<ReportingService>;
} {
  const configuration = options.configuration ?? reportingConfiguration(env);
  // pg cannot evaluate at module load inside workerd unit-test isolates without a database binding.
  const transaction: ReportingTransactionRunner = (operation) =>
    Effect.flatMap(
      Effect.promise(() => import("./database")),
      (module) =>
        module.withSystemTransactionEffect(env, (client: EffectTransactionClient) =>
          operation(client),
        ),
    );
  const layer = createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport:
      options.withTransport && configuration.destination
        ? createPostHogTransport({ destination: configuration.destination })
        : null,
  });
  return { configuration, layer };
}

export function deliverImprovementReports(
  env: AutomationEnv,
): Effect.Effect<DeliverySummary, AutomationJobError> {
  const { layer } = automationReportingLayer(env, { withTransport: true });
  return Effect.flatMap(ReportingService, (reporting) =>
    reporting.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH }),
  ).pipe(
    Effect.provide(layer),
    Effect.catch((cause) => Effect.fail(classifyJobError(cause))),
  );
}
