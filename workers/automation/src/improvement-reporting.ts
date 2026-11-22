import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createPostHogTransport,
  createReportingServiceLive,
  reportingConfiguration,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  type DeliverySummary,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";

import { withSystemTransactionEffect } from "./database";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

export function deliverImprovementReports(
  env: AutomationEnv,
): Effect.Effect<DeliverySummary, AutomationJobError> {
  const configuration = reportingConfiguration(env);
  const transaction: ReportingTransactionRunner = (operation) =>
    withSystemTransactionEffect(env, (client: EffectTransactionClient) => operation(client));
  const service = createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
  return Effect.flatMap(ReportingService, (reporting) =>
    reporting.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH }),
  ).pipe(
    Effect.provide(service),
    Effect.catch((cause) => Effect.fail(classifyJobError(cause))),
  );
}
