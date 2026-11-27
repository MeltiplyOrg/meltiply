import {
  elapsedMilliseconds,
  errorDiagnostic,
  log,
  type LogContext,
  type RetryClass,
} from "@meltiply/observability";
import type { Context } from "hono";

import type { ApiWorkerEnvironment } from "./env";

interface BackgroundContinuationOperation<T = unknown> {
  errorCode: string;
  errorRetryClass?: RetryClass;
  event: string;
  onSuccess?: (result: T) => Record<string, unknown> | void;
  perform: () => Promise<T>;
}

export function scheduleBackgroundWork(
  c: Context<ApiWorkerEnvironment>,
  promise: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise;
  }
}

export function runBackgroundContinuation<T>(
  c: Context<ApiWorkerEnvironment>,
  operation: BackgroundContinuationOperation<T>,
): void {
  const startedAt = performance.now();
  const logContext: LogContext = {
    environment: c.env.ENVIRONMENT,
    request_id: c.get("requestId"),
    route: c.req.path,
    service: "api",
    trace_id: c.get("traceId"),
    version: c.env.VERSION,
  };

  const handled = Promise.resolve()
    .then(() => operation.perform())
    .then(
      (result) => {
        const custom = operation.onSuccess?.(result);
        const { retry_class, ...rest } = (custom ?? {}) as {
          retry_class?: RetryClass;
          [key: string]: unknown;
        };
        log("info", logContext, {
          event: operation.event,
          latency_ms: elapsedMilliseconds(startedAt),
          outcome: "ok",
          retry_class: retry_class ?? "none",
          ...rest,
        });
      },
      (cause) => {
        log("error", logContext, {
          error_code: operation.errorCode,
          event: operation.event,
          latency_ms: elapsedMilliseconds(startedAt),
          outcome: "failed",
          ...errorDiagnostic(cause),
          retry_class: operation.errorRetryClass ?? "platform_retry",
        });
      },
    );

  scheduleBackgroundWork(c, handled);
}
