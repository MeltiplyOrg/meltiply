import type { Context as HonoContext } from "hono";
import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import {
  DomainError,
  RequestContext,
  makeRequestContext,
  type DomainErrorCode,
  type RequestContextData,
} from "@meltiply/domain";
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
import { errorResponse, jsonResponse } from "../responses";
type Schemas = components["schemas"];

export interface RunWorkerEffectOptions {
  readonly headers?: HeadersInit;
  readonly status?: number;
}

interface IssueLike {
  readonly actual?: unknown;
  readonly code?: string;
  readonly constraint?: string;
  readonly field?: string | null;
  readonly limit?: number | string;
  readonly message: string;
}

interface TaggedErrorShape {
  readonly _tag?: string;
  readonly cause?: unknown;
  readonly code?: string;
  readonly details?: readonly IssueLike[];
  readonly issues?: readonly IssueLike[];
  readonly message?: string;
  readonly retryAfterSeconds?: number;
  readonly status?: number;
}

/**
 * HTTP status mapping for transport-agnostic domain failures.
 *
 * Maps Effect-typed DomainError failures to their canonical status envelope
 * (`active_organization_required` → 403, `service_unavailable` → 503).
 */
const DOMAIN_ERROR_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  active_organization_required: 403,
  service_unavailable: 503,
};

interface ResolvedFailure {
  readonly code: string;
  readonly details: readonly Schemas["ErrorDetail"][];
  readonly message: string;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;
}

/**
 * Resolves one typed Effect failure into canonical HTTP status, error code, and client-safe message.
 *
 * Implements the API Worker error sanitization contract:
 * 1. `CoreApiError` failures always preserve explicit client-facing messages and status codes.
 * 2. `DomainError` instances map status via `DOMAIN_ERROR_STATUS` and preserve their message.
 * 3. `ProviderAdapterError` rate limits surface 429 with retry-after and provider messages, while 5xx
 *    upstream provider failures are sanitized to "An unexpected error occurred." under 502 status.
 * 4. Tagged domain Effect errors (`Data.TaggedError` shapes) sanitize all 5xx messages (status >= 500,
 *    such as `DatabaseError` 500 or `StorageUnavailableError` 503) to prevent sensitive internal detail leakage,
 *    while preserving client-actionable 4xx messages (< 500).
 * 5. Unknown or unshaped values fall back to 500 internal_error with the generic sanitization message.
 *
 * @param error - Typed failure value extracted from the Effect exit cause.
 * @returns Resolved canonical failure envelope with status, error code, client message, details, and optional Retry-After.
 */
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
  if (error instanceof DomainError) {
    return {
      code: error.code,
      details: [],
      message: error.message,
      retryAfterSeconds: undefined,
      status: DOMAIN_ERROR_STATUS[error.code] ?? 500,
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
      details: normalizeErrorDetails(shaped),
      message,
      retryAfterSeconds: shaped.retryAfterSeconds,
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

/**
 * Converts one loose validation descriptor into a canonical OpenAPI ErrorDetail record.
 *
 * Domain ValidationError entries (ValidationIssue) carry no mandatory `code` and allow
 * string `limit` / arbitrary `actual` values, while the OpenAPI ErrorDetail schema
 * requires `code` and numeric bounds. Missing codes fall back to the constraint name,
 * then to "invalid"; non-numeric bounds are dropped rather than forwarded verbatim.
 *
 * @param issue - Single validation descriptor from `details` or `issues`.
 * @returns Canonical ErrorDetail record, e.g. `{code: "invalid", ...}` for `{message: "Required"}`.
 */
function toCanonicalDetail(issue: IssueLike): Schemas["ErrorDetail"] {
  return {
    actual: typeof issue.actual === "number" ? issue.actual : undefined,
    code: issue.code ?? issue.constraint ?? "invalid",
    constraint: issue.constraint,
    field: issue.field ?? null,
    limit: typeof issue.limit === "number" ? issue.limit : undefined,
    message: issue.message,
  };
}

/**
 * Normalizes validation issues or detailed error descriptors into canonical OpenAPI ErrorDetail records.
 *
 * Translates domain ValidationError entries from either `details` or `issues` (both
 * ValidationIssue-shaped) into the standard details schema expected by errorResponse.
 * Both sources are mapped through the same conversion so contract-required fields
 * (`code`, numeric bounds) are always present regardless of which field is populated.
 *
 * @param error - The tagged error shape extracted from the Effect exit cause.
 * @returns An array of normalized error detail items.
 */
function normalizeErrorDetails(error: TaggedErrorShape): readonly Schemas["ErrorDetail"][] {
  if (error.details && error.details.length > 0) {
    return error.details.map(toCanonicalDetail);
  }
  if (error.issues && error.issues.length > 0) {
    return error.issues.map(toCanonicalDetail);
  }
  return [];
}

/**
 * Safely extracts the Cloudflare ExecutionContext from a Hono context without throwing if absent.
 *
 * Hono's `c.executionCtx` getter throws an error when no execution context is bound
 * (such as in unit tests or synthetic requests). This helper safely returns undefined instead.
 *
 * @param c - Hono context instance.
 * @returns ExecutionContext with waitUntil if present on the context, otherwise undefined.
 */
function getExecutionCtx(c: HonoContext):
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

/**
 * Per-request execution scope built fresh for every HTTP request.
 */
interface RequestScope {
  readonly executionCtx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
  readonly logContext: LogContext;
  readonly requestId: string;
  readonly runtimeLayer: Layer.Layer<RequestContext>;
  readonly signal: AbortSignal | undefined;
  readonly spanPromises: Promise<void>[];
}

/**
 * Builds an isolated per-request scope from the Hono context.
 *
 * Derives fresh correlation IDs, tenant-bound RequestContext data, the client AbortSignal,
 * and logger/tracer layers on every call so auth claims and trace state never leak across
 * requests, even when the Worker isolate is reused. Span exports register with
 * executionCtx.waitUntil to avoid delaying the client response.
 *
 * @param c - Active Hono context for the current HTTP request.
 * @returns Isolated request scope with layers and logging context.
 */
function requestScope(c: HonoContext): RequestScope {
  const requestId =
    (c.get?.("requestId") as string | undefined) ??
    c.req?.header?.("X-Request-ID") ??
    crypto.randomUUID();
  const traceId =
    (c.get?.("traceId") as string | undefined) ?? c.req?.header?.("traceparent") ?? requestId;
  const actor = c.get?.("actor") as ResolvedActor | undefined;
  const tenantId = actor?.workspace.id;

  const requestContextData: RequestContextData = makeRequestContext({
    requestId,
    session: actor?.claims as unknown as Record<string, unknown> | undefined,
    tenantId,
    traceId,
  });

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
      // In environments where executionCtx is unavailable or read-only
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

/**
 * Provides request layers, refuses already-aborted client requests before any
 * synchronous program work, passes active client cancellation to Effect, drains
 * tracer span exports when waitUntil is unavailable (test harnesses), and returns
 * the raw Exit for response mapping.
 *
 * @param scope - Isolated per-request scope from requestScope().
 * @param effect - Effect program statically constrained to require at most RequestContext.
 * @returns Raw Effect Exit distinguishing success, typed failure, and defect.
 */
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
  // In runtimes lacking executionCtx.waitUntil (e.g. test harnesses), await pending span exports
  if (!scope.executionCtx?.waitUntil && scope.spanPromises.length > 0) {
    await Promise.allSettled(scope.spanPromises);
  }
  return exit;
}

/**
 * Maps a failed Effect Exit cause into the canonical OpenAPI error envelope.
 *
 * Inspects for defects first so unhandled crashes/finalizers always take the 500
 * internal_error path; typed recoverable failures resolve through resolveFailure()
 * (CoreApiError/DomainError/ProviderAdapterError/validation shapes) preserving
 * status codes, error codes, details, and Retry-After headers. Pure request
 * interruption is recorded distinctly and returns 499/503 only after typed errors
 * and defects have been ruled out. 5xx outcomes are logged with diagnostics; 4xx
 * outcomes stay quiet for client errors.
 *
 * @param cause - Failure cause from the Effect exit.
 * @param requestId - Correlation ID for the error envelope.
 * @param logContext - Structured logging context for the request.
 * @param baseHeaders - Optional base headers (e.g. route success headers) to preserve.
 * @param signal - Incoming request signal used to distinguish client from server interruption.
 * @returns Fetch API Response for the resolved failure.
 */
function failureToResponse(
  cause: Cause.Cause<unknown>,
  requestId: string,
  logContext: LogContext,
  baseHeaders?: HeadersInit,
  signal?: AbortSignal,
): Response {
  // 1. Inspect for unexpected defects first. Any cause containing a defect must take the 500 internal error path.
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

  // 2. Handle typed recoverable domain errors
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

  // 3. Pure cancellation is neither a typed domain failure nor a defect. A request
  // signal identifies client disconnects; other interruption sources are unavailable.
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

  // 4. A non-empty cause without typed errors, defects, or a pure interruption
  // is an unclassified runtime failure.
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

/**
 * Approved execution boundary adapter that runs an Effect program within a Cloudflare/Hono handler.
 *
 * Extracts request correlation and authentication context from the incoming Hono context,
 * provides isolated request-scoped dependencies (RequestContext, logger, and tracer),
 * registers background span export promises with Cloudflare's executionCtx.waitUntil,
 * inspects for defects first to ensure unhandled crashes/finalizers take the 500 error path,
 * and deterministically translates Effect Exit outcomes into OpenAPI-compliant JSON or ErrorEnvelope responses.
 *
 * @param c - Active Hono context for the current HTTP request.
 * @param effect - Effect program to execute, statically constrained to require at most RequestContext.
 * @param options - Optional custom HTTP status code and response headers.
 * @returns Promise resolving to a Fetch API Response conforming to OpenAPI contracts.
 */
export async function runWorkerEffect<A, E>(
  c: HonoContext,
  effect: Effect.Effect<A, E, RequestContext>,
  options?: RunWorkerEffectOptions,
): Promise<Response> {
  const scope = requestScope(c);
  const exit = await runRequestExit(scope, effect);

  if (Exit.isSuccess(exit)) {
    return jsonResponse(exit.value, options?.status ?? 200, scope.requestId, options?.headers);
  }

  return failureToResponse(
    exit.cause,
    scope.requestId,
    scope.logContext,
    options?.headers,
    scope.signal,
  );
}

/**
 * Approved execution boundary for route handlers that shape their own Response.
 *
 * Shares the isolated request scope, span handling, and centralized typed-failure
 * mapping of runWorkerEffect, but passes through the program's Response verbatim
 * on success. Lets migrated routes keep exact status codes and headers (201/202/204,
 * ETag, Idempotency-Replayed, redirects) while moving failure mapping into one place.
 *
 * @param c - Active Hono context for the current HTTP request.
 * @param effect - Effect program resolving to a shaped Fetch Response.
 * @returns Program Response on success, canonical error envelope on failure.
 */
export async function runRouteEffect<E>(
  c: HonoContext,
  effect: Effect.Effect<Response, E, RequestContext>,
): Promise<Response> {
  const scope = requestScope(c);
  const exit = await runRequestExit(scope, effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  return failureToResponse(exit.cause, scope.requestId, scope.logContext, undefined, scope.signal);
}
