import {
  elapsedMilliseconds,
  errorDiagnostic,
  log,
  type LogContext,
  type RetryClass,
} from "@meltiply/observability";
import type { Context } from "hono";

import type { ApiWorkerEnvironment } from "./env";

export interface BackgroundContinuationOperation<T = unknown> {
  errorCode: string;
  errorRetryClass?: RetryClass;
  event: string;
  onSuccess?: (result: T) => Record<string, unknown> | void;
  perform: () => Promise<T>;
}

/**
 * Executes an asynchronous background operation on the request's execution continuation (`waitUntil`).
 *
 * Attaches non-blocking work (such as eager outbox relay or demand-driven comment synchronization)
 * to `ctx.waitUntil`, ensuring rejection handling is in place before attachment to avoid uncaught
 * promise failures in the Cloudflare Workers runtime. Safely falls back to detached execution when
 * invoked without an active execution context (e.g. unit tests or direct invocations).
 *
 * @param c - Hono request context providing execution context and structured log metadata.
 * @param operation - Operation definition containing execution closure, event name, error code, and callbacks.
 */
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

  try {
    c.executionCtx.waitUntil(handled);
  } catch {
    // No execution context (unit tests, direct app invocation): the work
    // still runs, it just is not tied to a background continuation.
    void handled;
  }
}
