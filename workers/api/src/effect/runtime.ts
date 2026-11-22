import type { Context } from "hono";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { RequestContext, type RequestContextData } from "@meltiply/domain";
import {
  errorDiagnostic,
  effectLoggerLayer,
  effectTracerLayer,
  log,
  type LogContext,
} from "@meltiply/observability";
import type { ResolvedActor } from "../actor-resolution";
import { ProviderAdapterError } from "@meltiply/providers";
import type { components } from "@meltiply/contracts/schema";

import { CoreApiError } from "../core-types";
import { scheduleInvocationFailureDiagnostic } from "../diagnostic-reporting";
import type { ApiWorkerEnvironment } from "../env";
import { errorResponse, jsonResponse } from "../responses";
type Schemas = components["schemas"];

export interface RunWorkerEffectOptions {
  readonly headers?: HeadersInit;
  readonly status?: number;
}

interface TaggedErrorShape {
  readonly _tag?: string;
  readonly cause?: unknown;
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}

interface ResolvedFailure {
  readonly code: string;
  readonly details: readonly Schemas["ErrorDetail"][];
  readonly message: string;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;
}

function resolveFailure(error: unknown): ResolvedFailure {
  if (error instanceof CoreApiError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
      status: error.status,
    };
  }
  if (error instanceof ProviderAdapterError) {
    const failure = error.failure;
    const isRateLimit = failure.classification === "rate_limit";
    const retryAfterSeconds =
      failure.retryAfterSeconds !== undefined && failure.retryable
        ? failure.retryAfterSeconds
        : undefined;
    return {
      code: failure.code,
      details: [],
      message: isRateLimit ? failure.message : "An unexpected error occurred.",
      retryAfterSeconds,
      status: isRateLimit ? 429 : 502,
    };
  }
  const shaped = error as TaggedErrorShape | null | undefined;
  if (
    shaped &&
    typeof shaped === "object" &&
    (shaped.status !== undefined || shaped.code !== undefined || shaped._tag !== undefined)
  ) {
    const status = shaped.status ?? 500;
    const message =
      status >= 500
        ? "An unexpected error occurred."
        : (shaped.message ?? "An unexpected error occurred.");
    return {
      code: shaped.code ?? "internal_error",
      details: [],
      message,
      retryAfterSeconds: undefined,
      status,
    };
  }
  return {
    code: "internal_error",
    details: [],
    message: "An unexpected error occurred.",
    retryAfterSeconds: undefined,
    status: 500,
  };
}

function getExecutionCtx(c: Context<ApiWorkerEnvironment>):
  | {
      waitUntil?: (promise: Promise<unknown>) => void;
    }
  | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

interface RequestScope {
  readonly executionCtx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
  readonly logContext: LogContext;
  readonly requestId: string;
  readonly runtimeLayer: Layer.Layer<RequestContext>;
  readonly signal: AbortSignal | undefined;
  readonly spanPromises: Promise<void>[];
}

function requestScope(c: Context<ApiWorkerEnvironment>): RequestScope {
  const requestId =
    (c.get?.("requestId") as string | undefined) ??
    c.req?.header?.("X-Request-ID") ??
    crypto.randomUUID();
  const traceId =
    (c.get?.("traceId") as string | undefined) ?? c.req?.header?.("traceparent") ?? requestId;
  const actor = c.get?.("actor") as ResolvedActor | undefined;
  const tenantId = actor?.workspace.id;

  const requestContextData: RequestContextData = {
    requestId,
    session: actor?.claims ?? null,
    tenantId,
    traceId,
  };

  const workerEnv = c.env as { ENVIRONMENT?: string; VERSION?: string } | undefined;
  const logContext: LogContext = {
    environment: workerEnv?.ENVIRONMENT ?? "local",
    request_id: requestId,
    route: c.req?.path ?? "/",
    service: "api",
    trace_id: traceId,
    version: workerEnv?.VERSION ?? "1.0.0",
  };

  const executionCtx = getExecutionCtx(c);
  const signal = c.req?.raw?.signal;
  const spanPromises: Promise<void>[] = [];
  const onExportPromise = (promise: Promise<void>) => {
    spanPromises.push(promise);
    try {
      executionCtx?.waitUntil?.(promise);
    } catch {
      return;
    }
  };

  const runtimeLayer = Layer.mergeAll(
    Layer.succeed(RequestContext, requestContextData),
    effectLoggerLayer(logContext),
    effectTracerLayer(logContext, { onExportPromise }),
  );

  return {
    executionCtx,
    logContext,
    requestId,
    runtimeLayer,
    signal,
    spanPromises,
  };
}

async function runRequestExit<A, E>(
  scope: RequestScope,
  effect: Effect.Effect<A, E, RequestContext>,
): Promise<Exit.Exit<A, E>> {
  if (scope.signal?.aborted) {
    return Exit.interrupt();
  }
  const exit = await Effect.runPromiseExit(Effect.provide(effect, scope.runtimeLayer), {
    signal: scope.signal,
  });
  if (!scope.executionCtx?.waitUntil && scope.spanPromises.length > 0) {
    await Promise.allSettled(scope.spanPromises);
  }
  return exit;
}

function failureToResponse(
  cause: Cause.Cause<unknown>,
  requestId: string,
  logContext: LogContext,
  baseHeaders?: HeadersInit,
  signal?: AbortSignal,
): Response {
  if (Cause.hasDies(cause)) {
    const dieResult = Cause.findDie(cause);
    const defect = Result.isSuccess(dieResult) ? dieResult.success.defect : Cause.squash(cause);

    log("error", logContext, {
      error_code: "internal_error",
      event: "request_failed",
      outcome: "internal_error",
      retry_class: "client_retry",
      ...errorDiagnostic(defect),
    });

    return errorResponse(
      requestId,
      500,
      "internal_error",
      "An unexpected error occurred.",
      [],
      baseHeaders,
    );
  }

  const maybeError = Cause.findErrorOption(cause);
  if (Option.isSome(maybeError)) {
    const resolved = resolveFailure(maybeError.value);
    const headers = new Headers(baseHeaders);

    if (resolved.retryAfterSeconds !== undefined) {
      headers.set("Retry-After", String(resolved.retryAfterSeconds));
    }

    if (resolved.status >= 500) {
      const shaped = maybeError.value as TaggedErrorShape;
      const diagnosticTarget = shaped?.cause ?? maybeError.value;
      log("error", logContext, {
        error_code: resolved.code,
        event: "request_failed",
        outcome: resolved.code,
        retry_class: "client_retry",
        ...errorDiagnostic(diagnosticTarget),
      });
    }

    return errorResponse(
      requestId,
      resolved.status,
      resolved.code,
      resolved.message,
      resolved.details,
      headers,
    );
  }

  if (Cause.hasInterruptsOnly(cause)) {
    const clientAborted = signal?.aborted ?? false;
    const status = clientAborted ? 499 : 503;
    const code = clientAborted ? "client_aborted" : "service_unavailable";
    log("info", logContext, {
      error_code: code,
      event: "request_interrupted",
      outcome: code,
      retry_class: "none",
    });
    return errorResponse(
      requestId,
      status,
      code,
      clientAborted
        ? "The client disconnected before the request completed."
        : "The request was interrupted before completion.",
      [],
      baseHeaders,
    );
  }

  const defect = Cause.squash(cause);
  log("error", logContext, {
    error_code: "internal_error",
    event: "request_failed",
    outcome: "internal_error",
    retry_class: "client_retry",
    ...errorDiagnostic(defect),
  });

  return errorResponse(
    requestId,
    500,
    "internal_error",
    "An unexpected error occurred.",
    [],
    baseHeaders,
  );
}

export async function runWorkerEffect<A, E>(
  c: Context<ApiWorkerEnvironment>,
  effect: Effect.Effect<A, E, RequestContext>,
  options?: RunWorkerEffectOptions,
): Promise<Response> {
  const scope = requestScope(c);
  const exit = await runRequestExit(scope, effect);

  if (Exit.isSuccess(exit)) {
    return jsonResponse(exit.value, options?.status ?? 200, scope.requestId, options?.headers);
  }

  const response = failureToResponse(
    exit.cause,
    scope.requestId,
    scope.logContext,
    options?.headers,
    scope.signal,
  );
  scheduleInvocationFailureDiagnostic(c, exit.cause, response.status);
  return response;
}

export async function runRouteEffect<E>(
  c: Context<ApiWorkerEnvironment>,
  effect: Effect.Effect<Response, E, RequestContext>,
): Promise<Response> {
  const scope = requestScope(c);
  const exit = await runRequestExit(scope, effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const response = failureToResponse(
    exit.cause,
    scope.requestId,
    scope.logContext,
    undefined,
    scope.signal,
  );
  scheduleInvocationFailureDiagnostic(c, exit.cause, response.status);
  return response;
}
