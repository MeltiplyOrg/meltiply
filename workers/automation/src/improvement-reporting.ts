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

/**
 * Scheduled best-effort delivery of already-sanitized improvement reports.
 *
 * This unit only drains the bounded pending queue written by producers. It never
 * computes a measurement, never queries a Provider and never touches domain work:
 * a PostHog outage, a disabled category or a missing destination leaves the
 * installation's publishing, queue acknowledgement, retry and DLQ behavior
 * exactly as it was.
 *
 * Policy is re-checked inside the module for every row, so a withdrawal or an
 * operator override between enqueue and send wins over the queued work. Rows that
 * outlive the seven-day window are discarded rather than delivered late.
 *
 * @param env - Automation Worker bindings for this invocation.
 * @returns One delivery pass's bounded summary; transport failures are values.
 */
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
    // A delivery pass can only fail on the database. That failure is classified
    // through the existing job-error mapper so the scheduled boundary keeps its
    // uniform retry semantics instead of inventing a second failure vocabulary.
    Effect.catch((cause) => Effect.fail(classifyJobError(cause))),
  );
}
