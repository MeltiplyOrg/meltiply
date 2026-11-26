import { Cause, Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  createReportingServiceLive,
  diagnosticReportInput,
  extractProviderFailureClass,
  ReportingService,
  reportingConfiguration,
  type DiagnosticReportInput,
  type OperationCategory,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";
import { errorDiagnostic, log, type LogContext } from "@meltiply/observability";

import { runJobProgram } from "./effect/boundary";
import type { AutomationEnv } from "./env";

const topicOperations: readonly (readonly [string, OperationCategory])[] = [
  ["distribution.", "publish"],
  ["comment.reply.", "inbox"],
  ["channel.revocation.", "auth"],
  ["asset.", "assets"],
  ["provider.sync", "analytics"],
] as const;

const reportingDeliveryUnit = "improvement-reporting-delivery";

const reportingUsageUnit = "usage-reporting";

export function operationForTopic(topic: string | undefined): OperationCategory {
  if (!topic) return "other";
  for (const [prefix, operation] of topicOperations) {
    if (topic.startsWith(prefix)) return operation;
  }
  return "other";
}

export function operationForScheduledUnit(unit: string): OperationCategory {
  if (unit === reportingDeliveryUnit || unit === reportingUsageUnit) return "reporting";
  if (unit.startsWith("provider-sync") || unit === "account-analytics-sweep") return "analytics";
  if (unit === "reply-reconciliation") return "inbox";
  if (unit === "asset-maintenance") return "assets";
  if (unit === "distribution-sweep" || unit === "due-distribution-scan") return "publish";
  if (unit === "outbox-relay") return "queues";
  return "other";
}

export interface QueueDiagnosticContext {
  readonly provider?: string;
  readonly topic?: string;
  readonly outcome: "ambiguous" | "rejected" | "retry";
}

export function queueDiagnosticReport(
  cause: unknown,
  context: QueueDiagnosticContext,
): DiagnosticReportInput {
  const ambiguous = context.outcome === "ambiguous";
  const failureClass = ambiguous ? "ambiguous" : extractProviderFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    handled: true,
    operation: operationForTopic(context.topic),
    ...(context.provider === undefined
      ? {}
      : { platform: context.provider as DiagnosticReportInput["platform"] }),
  });
}

export function scheduledDiagnosticReport(cause: unknown, unit: string): DiagnosticReportInput {
  const failureClass = extractProviderFailureClass(cause);
  return diagnosticReportInput(cause, {
    category: failureClass ? "provider_failure" : "scheduled_job_failure",
    ...(failureClass ? { failureClass } : {}),
    handled: failureClass !== undefined,
    operation: operationForScheduledUnit(unit),
  });
}

export function workflowDiagnosticReport(
  cause: unknown,
  context: { readonly outcome: "ambiguous" | "rejected" | "retry"; readonly provider?: string },
): DiagnosticReportInput {
  const failureClass =
    context.outcome === "ambiguous" ? "ambiguous" : extractProviderFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    handled: true,
    operation: "inbox",
    ...(context.provider === undefined
      ? {}
      : { platform: context.provider as DiagnosticReportInput["platform"] }),
  });
}

export function recordDiagnostic(
  env: AutomationEnv,
  input: DiagnosticReportInput,
): Effect.Effect<boolean> {
  if (input.operation === "reporting") return Effect.succeed(false);
  const configuration = reportingConfiguration(env);
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
    transport: null,
  });
  return Effect.flatMap(ReportingService, (service) =>
    Effect.map(service.enqueueDiagnostic(input), (decision) => decision !== "skipped"),
  ).pipe(
    Effect.provide(layer),
    Effect.catchCause(() => Effect.succeed(false)),
  );
}

async function recordDiagnosticSafely(
  env: AutomationEnv,
  input: DiagnosticReportInput,
  context: LogContext,
): Promise<void> {
  let recorded = false;
  try {
    const exit = await runJobProgram(recordDiagnostic(env, input));
    if (Exit.isFailure(exit)) {
      throw Cause.squash(exit.cause);
    }
    recorded = exit.value;
  } catch (cause) {
    log("warn", context, {
      error_code: "diagnostic_report_failed",
      event: "diagnostic_report",
      outcome: "failed",
      ...errorDiagnostic(cause),
      retry_class: "none",
    });
    return;
  }
  log("debug", context, {
    event: "diagnostic_report",
    outcome: recorded ? "recorded" : "skipped",
    retry_class: "none",
  });
}

export function registerDiagnostic(
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  env: AutomationEnv,
  input: DiagnosticReportInput,
  context: LogContext,
): void {
  const work = recordDiagnosticSafely(env, input, context);
  try {
    executionCtx?.waitUntil(work);
  } catch {
    void work;
  }
}
