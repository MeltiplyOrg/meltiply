import type { Layer } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createPostHogTransport,
  createReportingServiceLive,
  type ReportingService,
  reportingConfiguration,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";
import { lazyWithSystemTransactionEffect } from "./database-module";
import type { ApiWorkerEnv } from "./env";

export interface ReportingDependencies {
  reportingServiceLayer?:
    | Layer.Layer<ReportingService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<ReportingService, never, never>);
}

export function reportingLayer(
  env: ApiWorkerEnv,
  dependencies: ReportingDependencies = {},
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
        lazyWithSystemTransactionEffect(env, (systemClient) => operation(systemClient));
  return createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
}
