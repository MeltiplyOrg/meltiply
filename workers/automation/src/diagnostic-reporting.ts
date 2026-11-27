import { Cause, Effect, Exit } from "effect";
import {
  diagnosticReportInput,
  extractProviderFailureClass,
  ReportingService,
  type DiagnosticReportInput,
  type OperationCategory,
} from "@meltiply/reporting";
import { errorDiagnostic, log, type LogContext } from "@meltiply/observability";

import { runJobProgram } from "./effect/boundary";
import type { AutomationEnv } from "./env";
import { automationReportingLayer } from "./reporting";

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

function enqueueDiagnosticEffect(
  env: AutomationEnv,
  input: DiagnosticReportInput,
): Effect.Effect<boolean, unknown> {
  if (input.operation === "reporting") return Effect.succeed(false);
  const { layer } = automationReportingLayer(env);
  return Effect.flatMap(ReportingService, (service) =>
    Effect.map(service.enqueueDiagnostic(input), (decision) => decision !== "skipped"),
  ).pipe(Effect.provide(layer));
}

export function recordDiagnostic(
  env: AutomationEnv,
  input: DiagnosticReportInput,
): Effect.Effect<boolean> {
  return enqueueDiagnosticEffect(env, input).pipe(Effect.catchCause(() => Effect.succeed(false)));
}

async function recordDiagnosticSafely(
  env: AutomationEnv,
  input: DiagnosticReportInput,
  context: LogContext,
): Promise<void> {
  const exit = await runJobProgram(enqueueDiagnosticEffect(env, input));
  if (Exit.isFailure(exit)) {
    log("warn", context, {
      error_code: "diagnostic_report_failed",
      event: "diagnostic_report",
      outcome: "failed",
      ...errorDiagnostic(Cause.squash(exit.cause)),
      retry_class: "none",
    });
    return;
  }
  log("debug", context, {
    event: "diagnostic_report",
    outcome: exit.value ? "recorded" : "skipped",
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
