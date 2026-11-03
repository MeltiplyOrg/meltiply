import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { ProviderAdapterError } from "@meltiply/providers";
import {
  createPostHogTransport,
  createReportingServiceLive,
  diagnosticReportInput,
  isProviderFailureClass,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  reportingConfiguration,
  type DiagnosticReportInput,
  type OperationCategory,
  type ReportingServiceShape,
  type ReportingTransactionRunner,
} from "@meltiply/reporting";
import { errorDiagnostic, log, type LogContext } from "@meltiply/observability";

import type { AutomationEnv } from "./env";

/**
 * Diagnostic production for the Automation Worker's asynchronous boundaries.
 *
 * A queue message and a scheduled unit already classify their failure through
 * `exitToJobOutcome`/`classifyJobError`, and those decisions — `retry`,
 * `rejected`, `ambiguous` — are what the consumer acts on. That behavior is
 * untouched: reporting is a second, additive reader of the same classification.
 *
 * Three properties make the addition safe:
 *
 * - Nothing here can fail the caller. Recording absorbs every typed failure and
 *   every defect, so a PostHog or database problem cannot turn an ack into a
 *   retry, a retry into a DLQ entry, or a scheduled unit into a failed
 *   invocation.
 * - The policy is re-read by the reporting module before the row is written and
 *   again before each send, so an unconsented installation, a withdrawn category,
 *   an operator override or a missing destination produces no traffic at all.
 * - Nothing here can recurse. The reporting delivery unit never reports its own
 *   failure, and the capture transport returns failures as values.
 */

/** Operation grouping for one queue topic prefix. */
const topicOperations: readonly (readonly [string, OperationCategory])[] = [
  ["distribution.", "publish"],
  ["comment.reply.", "inbox"],
  ["channel.revocation.", "auth"],
  ["asset.", "assets"],
  ["provider.sync", "analytics"],
] as const;

/** The reporting delivery unit, which must never report its own failure. */
const reportingDeliveryUnit = "improvement-reporting-delivery";

/** The usage-summary producer, whose failures belong to the same operation grouping. */
const reportingUsageUnit = "usage-reporting";

/**
 * Maps a queue topic to the maintainer's fixed operation grouping.
 *
 * The topic itself never leaves the installation; only the grouping does.
 *
 * @param topic - Outbox topic from the message, when the body carries one.
 * @returns Operation grouping for the diagnostic report.
 */
export function operationForTopic(topic: string | undefined): OperationCategory {
  if (!topic) return "other";
  for (const [prefix, operation] of topicOperations) {
    if (topic.startsWith(prefix)) return operation;
  }
  return "other";
}

/**
 * Maps a scheduled unit name to its fixed operation grouping.
 *
 * @param unit - Scheduled unit name.
 * @returns Operation grouping for the diagnostic report.
 */
export function operationForScheduledUnit(unit: string): OperationCategory {
  if (unit === reportingDeliveryUnit || unit === reportingUsageUnit) return "reporting";
  if (unit.startsWith("provider-sync") || unit === "account-analytics-sweep") return "analytics";
  if (unit === "reply-reconciliation") return "inbox";
  if (unit === "asset-maintenance") return "assets";
  if (unit === "distribution-sweep" || unit === "due-distribution-scan") return "publish";
  if (unit === "outbox-relay") return "queues";
  return "other";
}

/** Canonical Provider class of an adapter failure, when the value carries one. */
function providerFailureClass(cause: unknown): DiagnosticReportInput["failureClass"] {
  if (!(cause instanceof ProviderAdapterError)) return undefined;
  const classification = cause.failure?.classification;
  return isProviderFailureClass(classification) ? classification : undefined;
}

/** Correlation facts a queue boundary already resolved for its log line. */
export interface QueueDiagnosticContext {
  /** Provider whose queue carried the message, when the queue is Provider-scoped. */
  readonly provider?: string;
  /** Outbox topic, when the body carried one. */
  readonly topic?: string;
  /**
   * Boundary outcome from `exitToJobOutcome`.
   *
   * `ambiguous` is an expected Provider condition — a write that may have
   * committed remotely — so it reports as a categorized Provider failure rather
   * than an unexpected exception. `rejected` is a terminal producer-contract
   * violation, which is a Meltiply defect.
   */
  readonly outcome: "ambiguous" | "rejected" | "retry";
}

/**
 * Builds the approved report for one failed queue message.
 *
 * The message id, correlation ids, organization id, Post and Channel identifiers
 * and the payload never enter the report. The per-hour logical identity keeps a
 * redelivered failure as one pending row.
 *
 * @param cause - Original thrown value recovered from the job Exit.
 * @param context - Provider, topic and boundary outcome already known.
 * @returns Report ready for `enqueueDiagnostic`.
 */
export function queueDiagnosticReport(
  cause: unknown,
  context: QueueDiagnosticContext,
): DiagnosticReportInput {
  const ambiguous = context.outcome === "ambiguous";
  const failureClass = ambiguous ? "ambiguous" : providerFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    // A queue message that reached a processor was accepted work: the failure is
    // classified by the existing mapper and the retry/DLQ decision owns it.
    handled: true,
    operation: operationForTopic(context.topic),
    ...(context.provider === undefined
      ? {}
      : { platform: context.provider as DiagnosticReportInput["platform"] }),
  });
}

/**
 * Builds the approved report for one failed scheduled unit.
 *
 * A scheduled failure is the maintenance tier failing, not an individual message:
 * the tier keeps running its sibling units and the maintainer sees the unit's
 * operation grouping. The unit name is not part of the payload; it survives only
 * in the local log line the scheduled loop already writes.
 *
 * @param cause - Original thrown value recovered from the unit's Exit.
 * @param unit - Scheduled unit name that failed.
 * @returns Report ready for `enqueueDiagnostic`.
 */
export function scheduledDiagnosticReport(cause: unknown, unit: string): DiagnosticReportInput {
  const failureClass = providerFailureClass(cause);
  return diagnosticReportInput(cause, {
    category: failureClass ? "provider_failure" : "scheduled_job_failure",
    ...(failureClass ? { failureClass } : {}),
    handled: failureClass !== undefined,
    operation: operationForScheduledUnit(unit),
  });
}

/**
 * Builds the approved report for one failed durable workflow step.
 *
 * The workflow's step boundary is the only place a later reply execution can
 * fail: enqueueing the workflow is covered by the queue producer, but the step
 * body runs afterwards in its own retry loop. Reporting here observes that
 * execution without touching its retry decision — the step still throws the same
 * cause, so the workflow's own backoff and DLQ path are unchanged.
 *
 * @param cause - Original thrown value recovered from the step's Exit.
 * @param context - Provider the reply belonged to and the step's boundary outcome.
 * @returns Report ready for `enqueueDiagnostic`.
 */
export function workflowDiagnosticReport(
  cause: unknown,
  context: { readonly outcome: "ambiguous" | "rejected" | "retry"; readonly provider?: string },
): DiagnosticReportInput {
  const failureClass = context.outcome === "ambiguous" ? "ambiguous" : providerFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    handled: true,
    operation: "inbox",
    ...(context.provider === undefined
      ? {}
      : { platform: context.provider as DiagnosticReportInput["platform"] }),
  });
}

/**
 * Records one approved diagnostic and drains the bounded pending queue.
 *
 * The Effect never fails: a typed failure and a defect both collapse to "nothing
 * was recorded", so no caller can observe a change in its own outcome. Delivery is
 * bounded to one batch so a scheduled pass or a queue message stays inside the
 * invocation budget.
 *
 * @param env - Automation Worker bindings for this invocation.
 * @param input - Approved diagnostic report.
 * @returns Whether a report was written and a delivery pass attempted.
 */
export function recordDiagnostic(
  env: AutomationEnv,
  input: DiagnosticReportInput,
): Effect.Effect<boolean> {
  // Reporting never reports its own failure: doing so would enqueue a diagnostic
  // from the very unit that drains diagnostics.
  if (input.operation === "reporting") return Effect.succeed(false);
  const configuration = reportingConfiguration(env);
  // Resolved lazily: this module is in the automation entry point's import graph,
  // and a static database import would evaluate `pg` in workerd unit isolates.
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
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
  return Effect.flatMap(ReportingService, (service: ReportingServiceShape) =>
    Effect.gen(function* () {
      const decision = yield* service.enqueueDiagnostic(input);
      if (decision === "skipped") return false;
      yield* service.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH });
      return true;
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.catchCause(() => Effect.succeed(false)),
  );
}

/**
 * Records one boundary failure without letting reporting affect the caller.
 *
 * Used where the caller is a Promise boundary — the queue consumer, the scheduled
 * loop — that has already decided the message's fate. The returned promise never
 * rejects, so awaiting it or handing it to the invocation lifecycle cannot change
 * an ack, a retry, a DLQ entry or the invocation's own thrown failure.
 *
 * @param env - Automation Worker bindings.
 * @param input - Approved diagnostic report.
 * @param context - Local log context for the reporting attempt's own outcome.
 */
async function recordDiagnosticSafely(
  env: AutomationEnv,
  input: DiagnosticReportInput,
  context: LogContext,
): Promise<void> {
  let recorded = false;
  try {
    recorded = await Effect.runPromise(recordDiagnostic(env, input));
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

/**
 * Registers one boundary failure's diagnostic on the invocation lifecycle.
 *
 * Deliberately not awaited: the queue consumer's ack, retry and DLQ decisions and
 * the scheduled loop's failure log are already made, and optional reporting must
 * never delay or reorder them. `waitUntil` keeps the write and the bounded
 * delivery attempt alive after the handler returns; runtimes without an execution
 * context (unit tests, direct invocation) still run it detached.
 *
 * @param executionCtx - Invocation lifecycle, when the runtime provides one.
 * @param env - Automation Worker bindings.
 * @param input - Approved diagnostic report.
 * @param context - Local log context for the reporting attempt's own outcome.
 */
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
