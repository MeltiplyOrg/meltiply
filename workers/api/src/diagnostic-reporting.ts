import { createRequestId, createTraceId, errorDiagnostic, log } from "@meltiply/observability";
import {
  diagnosticReportInput,
  extractProviderFailureClass,
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
import { reportingLayer } from "./reporting-layer";

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
  ["/api/v1/publishing-preferences", "publish"],
  ["/api/v1/posts", "publish"],
  ["/api/v1/distributions", "publish"],
  ["/api/v1/calendar", "publish"],
  ["/api/v1/brand-profiles", "publish"],
  ["/api/v1/flows", "other"],
];

export function operationForPath(path: string): OperationCategory {
  for (const [prefix, operation] of operationPrefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return operation;
  }
  return "other";
}

function failureValue(cause: Cause.Cause<unknown>): unknown {
  if (Cause.hasInterruptsOnly(cause)) return undefined;
  if (Cause.hasDies(cause)) {
    const defect = Cause.findDie(cause);
    return Result.isSuccess(defect) ? defect.success.defect : Cause.squash(cause);
  }
  const typed = Cause.findErrorOption(cause);
  return Option.isSome(typed) ? typed.value : Cause.squash(cause);
}

export function apiBoundaryReport(cause: unknown, path: string): DiagnosticReportInput {
  const failureClass = extractProviderFailureClass(cause);
  return diagnosticReportInput(cause, {
    ...(failureClass ? { category: "provider_failure" as const, failureClass } : {}),
    operation: operationForPath(path),
  });
}

function scheduleDiagnostic(c: Context<ApiWorkerEnvironment>, input: DiagnosticReportInput): void {
  if (input.operation === "reporting") return;
  runBackgroundContinuation<{ accepted: boolean; decision: string }>(c, {
    errorCode: "diagnostic_report_failed",
    event: "diagnostic_invocation_failure",
    perform: () =>
      Effect.runPromise(
        Effect.flatMap(ReportingService, (service: ReportingServiceShape) =>
          Effect.gen(function* () {
            const decision = yield* service.enqueueDiagnostic(input);
            if (decision === "skipped") return { accepted: false, decision };
            yield* service.deliverPending({ limit: REPORTING_MAX_DELIVERY_BATCH });
            return { accepted: true, decision };
          }),
        ).pipe(Effect.provide(reportingLayer(c.env))),
      ),
    onSuccess: (result) => ({
      diagnostic_accepted: result.accepted,
      retry_class: "none" as const,
    }),
  });
}

export function scheduleInvocationFailureDiagnostic(
  c: Context<ApiWorkerEnvironment>,
  cause: Cause.Cause<unknown>,
  status: number,
): void {
  const path = c.req?.path ?? "";
  if (!path.startsWith("/api/v1/")) return;
  const failure = failureValue(cause);
  if (failure === undefined) return;
  const provider = extractProviderFailureClass(failure) !== undefined;
  if (status < 500 && !provider) return;
  try {
    scheduleDiagnostic(c, apiBoundaryReport(failure, path));
  } catch (reportingCause) {
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
