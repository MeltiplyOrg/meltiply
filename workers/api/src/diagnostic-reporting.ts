import { createRequestId, createTraceId, errorDiagnostic, log } from "@meltiply/observability";
import { ProviderAdapterError } from "@meltiply/providers";
import {
  diagnosticReportInput,
  isProviderFailureClass,
  REPORTING_MAX_DELIVERY_BATCH,
  ReportingService,
  type DiagnosticReportInput,
  type OperationCategory,
  type ReportingServiceShape,
} from "@meltiply/reporting";
import { Cause, Effect, Option, Result } from "effect";
import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";
import type { ApiWorkerEnvironment } from "./env";
import { reportingLayer, type ReportingDependencies } from "./reporting-layer";

// Optional reporting observes authenticated invocation failures after the HTTP
// outcome is fixed. Consent and payload minimization remain in the shared service.

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

/** Maps a local API path to a fixed operation group; unmatched paths become `other`. */
export function operationForPath(path: string): OperationCategory {
  for (const [prefix, operation] of operationPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return operation;
  }
  return "other";
}

/** Prefers defects over typed errors; pure interruption is not reportable. */
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

/** Separates classified Provider conditions from defects without retaining runtime messages. */
export function apiBoundaryReport(cause: unknown, path: string): DiagnosticReportInput {
  const failureClass = providerFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    operation: operationForPath(path),
  });
}

/** Enqueues and drains on the request continuation, after its HTTP outcome is fixed. */
function scheduleDiagnostic(
  c: Context<ApiWorkerEnvironment>,
  input: DiagnosticReportInput,
  dependencies: ReportingDependencies,
  event: string,
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
        ).pipe(Effect.provide(reportingLayer(c.env, dependencies))),
      ),
    onSuccess: (result) => ({
      diagnostic_accepted: result.accepted,
      retry_class: "none" as const,
    }),
  });
}

/** Observes authenticated API failures; client mistakes and reporting's own failures are excluded. */
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
