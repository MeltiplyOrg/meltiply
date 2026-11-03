import { createRequestId, createTraceId, errorDiagnostic, log } from "@meltiply/observability";
import { ProviderAdapterError } from "@meltiply/providers";
import type { EffectTransactionClient } from "@meltiply/database";
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
import { Cause, Effect, Option, Result, type Layer } from "effect";
import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";
import { withSystemTransactionEffect } from "./database";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
// Type-only, so importing the route's seam never creates a runtime cycle back
// into the request boundary that calls this module.
import type { ReportingRouteDependencies } from "./reporting-routes";

/**
 * Diagnostic production for the API Worker's own failure boundaries.
 *
 * Two producers exist and only two:
 *
 * 1. The browser forwards an authenticated client exception to
 *    `POST /api/v1/installation/reporting/diagnostics`, and that route decides
 *    whether persisted consent permits transmission.
 * 2. An unexpected HTTP invocation failure observed by the approved Effect
 *    boundary is turned into the same approved report shape here.
 *
 * Both converge on the reporting module, which re-reads the persisted policy
 * before writing a pending row and again before each send. A missing choice, a
 * withdrawal, an operator override, an unreadable preference row or a missing
 * destination therefore produces no traffic and no error: the product keeps
 * working and only the installation-local log records the failure.
 *
 * Canonical operational observability is unchanged. The structured `log` call
 * that already describes the failure still runs; forwarding is additive and
 * best-effort, and a reporting failure can never change an HTTP status, a queue
 * acknowledgment, a retry decision or a DLQ outcome.
 */

/** Fixed operation grouping for one API path prefix, matched most specific first. */
const operationPrefixes: readonly (readonly [string, OperationCategory])[] = [
  ["/api/v1/installation/reporting", "reporting"],
  ["/api/v1/installation", "installation"],
  ["/api/v1/workspaces", "installation"],
  ["/api/v1/workspace-invitations", "installation"],
  ["/api/v1/users", "auth"],
  ["/api/v1/platforms", "auth"],
  ["/api/v1/oauth-selections", "auth"],
  ["/api/v1/analytics", "analytics"],
  ["/api/v1/inbox", "inbox"],
  ["/api/v1/assets", "assets"],
  ["/api/v1/asset-upload-sessions", "assets"],
  ["/api/v1/queues", "publish"],
  ["/api/v1/posts", "publish"],
  ["/api/v1/distributions", "publish"],
  ["/api/v1/calendar", "publish"],
  ["/api/v1/brand-profiles", "publish"],
  ["/api/v1/flows", "other"],
];

/**
 * Maps a request path to the maintainer's fixed operation grouping.
 *
 * The grouping is what a maintainer prioritizes by; the path itself never leaves
 * the installation. Anything unrecognized — the Better Auth surface, the
 * operator surface, an unmatched path — groups as `other`.
 *
 * @param path - Request pathname as the Worker observed it.
 * @returns Operation grouping for the diagnostic report.
 */
export function operationForPath(path: string): OperationCategory {
  for (const [prefix, operation] of operationPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return operation;
  }
  return "other";
}

/**
 * Selects the value that describes one failed invocation.
 *
 * A defect outranks a typed failure because an unhandled crash is the case worth
 * grouping; a typed failure is used when the cause carries one, and the squashed
 * cause is the last resort. Pure interruption is not a failure to report: a
 * client disconnect and a shutdown are not defects, and the timeout path already
 * logs them locally.
 *
 * @param cause - Failure cause from a finished Effect exit.
 * @returns The value to classify, or undefined for pure interruption.
 */
function failureValue(cause: Cause.Cause<unknown>): unknown {
  if (Cause.hasInterruptsOnly(cause)) return undefined;
  if (Cause.hasDies(cause)) {
    const defect = Cause.findDie(cause);
    return Result.isSuccess(defect) ? defect.success.defect : Cause.squash(cause);
  }
  const typed = Cause.findErrorOption(cause);
  return Option.isSome(typed) ? typed.value : Cause.squash(cause);
}

/** Canonical Provider class of an adapter failure, when the value carries one. */
function providerFailureClass(cause: unknown): DiagnosticReportInput["failureClass"] {
  if (!(cause instanceof ProviderAdapterError)) return undefined;
  const classification = cause.failure?.classification;
  return isProviderFailureClass(classification) ? classification : undefined;
}

/**
 * Builds the approved report for one failed HTTP invocation.
 *
 * An adapter failure that the boundary already classified is an expected
 * Provider condition: it reports as `provider_failure` with its canonical class,
 * so normal recoverable Provider behavior stays separate from application
 * defects. Everything else is an unexpected exception. The report never carries
 * the runtime message; the module keeps only allowlisted application frames.
 *
 * @param cause - Thrown value or squashed Effect cause at the boundary.
 * @param path - Request path, used only to derive the operation grouping.
 * @returns Report ready for `enqueueDiagnostic`.
 */
export function apiBoundaryReport(cause: unknown, path: string): DiagnosticReportInput {
  const failureClass = providerFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    operation: operationForPath(path),
  });
}

/**
 * Resolves the reporting layer for one invocation.
 *
 * The injected layer wins, matching the reporting route's seam, so a test or an
 * alternate transport changes delivery without touching a boundary. Otherwise the
 * layer is derived from the current bindings, so a changed operator override or
 * destination applies without an isolate restart.
 *
 * @param env - Current Worker bindings.
 * @param dependencies - Optional injected reporting layer.
 * @param client - Existing transaction client to reuse, when present.
 * @returns Layer providing `ReportingService` with `R = never`.
 */
function boundaryReportingLayer(
  env: ApiWorkerEnv,
  dependencies: ReportingRouteDependencies,
  client?: EffectTransactionClient,
): Layer.Layer<ReportingService, never, never> {
  const injected = dependencies.reportingServiceLayer;
  if (injected !== undefined && client === undefined) {
    return typeof injected === "function" ? injected(env) : injected;
  }
  const configuration = reportingConfiguration(env);
  const transaction: ReportingTransactionRunner = client
    ? (operation) => operation(client)
    : (operation) => withSystemTransactionEffect(env, (systemClient) => operation(systemClient));
  return createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    transaction,
    transport: configuration.destination
      ? createPostHogTransport({ destination: configuration.destination })
      : null,
  });
}

/**
 * Records one approved diagnostic and drains the bounded queue on the request's
 * background continuation.
 *
 * Both the durable write and the delivery attempt happen after the response is
 * decided: `runBackgroundContinuation` registers them with the invocation
 * lifecycle and converts any rejection into a local log line, so a PostHog outage
 * or an unwritable preference row cannot delay the response describing the
 * failure, change its status, or escape as an unhandled rejection.
 *
 * @param c - Hono request context carrying the execution context.
 * @param input - Approved diagnostic report.
 * @param dependencies - Optional injected reporting layer.
 * @param event - Local log event name for the continuation's own outcome.
 */
export function scheduleDiagnostic(
  c: Context<ApiWorkerEnvironment>,
  input: DiagnosticReportInput,
  dependencies: ReportingRouteDependencies = {},
  event = "diagnostic_report",
): void {
  // Reporting never reports itself: an ingestion or delivery failure inside the
  // reporting surface would otherwise recurse into another ingestion attempt.
  if (input.operation === "reporting") return;
  runBackgroundContinuation<{ accepted: boolean; decision: string }>(c, {
    errorCode: "diagnostic_report_failed",
    event,
    // The continuation is a Promise-facing boundary, so the Effect program runs
    // here exactly once, mirroring the delivery scheduler's adapter.
    perform: () =>
      Effect.runPromise(
        Effect.flatMap(ReportingService, (service: ReportingServiceShape) =>
          Effect.gen(function* () {
            const decision = yield* service.enqueueDiagnostic(input);
            if (decision === "skipped") return { accepted: false, decision };
            yield* service.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH });
            return { accepted: true, decision };
          }),
        ).pipe(Effect.provide(boundaryReportingLayer(c.env, dependencies))),
      ),
    onSuccess: (result) => ({
      diagnostic_accepted: result.accepted,
      retry_class: "none" as const,
    }),
  });
}

/**
 * Registers the diagnostic report for a finished-but-failed invocation.
 *
 * Called only from the approved request boundary after the response is already
 * mapped, so the original status, error code, details and retry headers cannot
 * change. Only the authenticated public API is a producer: the Better Auth and
 * operator surfaces sit outside the installation's reporting consent, and
 * pre-auth attempts are never forwarded.
 *
 * A 4xx outcome is a client mistake the route already reported honestly to the
 * caller, so it is not a defect to group. Expected Provider conditions are the
 * exception: their class is the countable diagnostic the maintainer asked for,
 * and they are exactly what must not be mixed into unexpected exceptions.
 *
 * @param c - Hono request context.
 * @param cause - Failure cause from the finished Effect exit.
 * @param status - Already-mapped HTTP status for the same failure.
 */
export function scheduleInvocationFailureDiagnostic(
  c: Context<ApiWorkerEnvironment>,
  cause: Cause.Cause<unknown>,
  status: number,
): void {
  const path = c.req?.path ?? "";
  if (!path.startsWith("/api/v1/")) return;
  const failure = failureValue(cause);
  if (failure === undefined) return;
  const provider = providerFailureClass(failure) !== undefined;
  if (status < 500 && !provider) return;
  try {
    scheduleDiagnostic(c, apiBoundaryReport(failure, path), {}, "diagnostic_invocation_failure");
  } catch (reportingCause) {
    // Never let the reporting seam replace the boundary's own outcome.
    log(
      "warn",
      {
        environment: c.env?.ENVIRONMENT ?? "unknown",
        request_id: c.get?.("requestId") ?? createRequestId(),
        route: path,
        service: "api",
        trace_id: c.get?.("traceId") ?? createTraceId(),
        version: c.env?.VERSION ?? "unknown",
      },
      {
        error_code: "diagnostic_report_unavailable",
        event: "diagnostic_report",
        outcome: "failed",
        ...errorDiagnostic(reportingCause),
        retry_class: "none",
      },
    );
  }
}
