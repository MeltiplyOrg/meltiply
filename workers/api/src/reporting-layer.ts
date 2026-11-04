import { Effect, type Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createPostHogTransport,
  createReportingServiceLive,
  ReportingService,
  reportingConfiguration,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";
import type { ApiWorkerEnv } from "./env";

/** Invocation-scoped test/transport override; transactional consent writes stay live. */
export interface ReportingDependencies {
  reportingServiceLayer?:
    | Layer.Layer<ReportingService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<ReportingService, never, never>);
}

/** Reuses an existing transaction for consent/Audit atomicity; lazy DB loading keeps pg out of workerd isolates. */
export function reportingLayer(
  env: ApiWorkerEnv,
  dependencies: ReportingDependencies,
  client?: EffectTransactionClient,
): Layer.Layer<ReportingService, never, never> {
  const injected = dependencies.reportingServiceLayer;
  if (injected !== undefined && client === undefined) {
    return typeof injected === "function" ? injected(env) : injected;
  }
  const configuration = reportingConfiguration(env);
  const transaction: ReportingTransactionRunner = client
    ? (operation) => operation(client)
    : (operation) =>
        Effect.flatMap(
          Effect.promise(() => import("./database")),
          (module) =>
            module.withSystemTransactionEffect(env, (systemClient) => operation(systemClient)),
        );
  return createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
}
