import { createRequestId, createTraceId, log } from "@meltiply/observability";

interface Env {
  API?: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  VERSION?: string;
}

const telemetryPath = "/__frontend-telemetry";
const maximumTelemetryBodyBytes = 4096;
const telemetryKinds: Record<string, true> = {
  "api-error": true,
  "frontend-error": true,
  "unknown-contract-value": true,
};

type TelemetryPayload = {
  code?: unknown;
  configurationKey?: unknown;
  configurationSource?: unknown;
  configurationState?: unknown;
  diagnosticCode?: unknown;
  field?: unknown;
  kind?: unknown;
  retryable?: unknown;
  status?: unknown;
  valueHash?: unknown;
  valueType?: unknown;
};

/**
 * Generates a fallback 500 Internal Server Error plain-text HTTP response.
 *
 * @returns 500 Response instance.
 */
function genericErrorResponse(): Response {
  return new Response("An error has occurred.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status: 500,
  });
}

/**
 * Generates a fallback 502 Bad Gateway plain-text HTTP response for API proxy failures.
 *
 * @returns 502 Response instance.
 */
function apiUnavailableResponse(): Response {
  return new Response("The API is unavailable.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status: 502,
  });
}

/**
 * Generates an empty HTTP response with the specified client error status code.
 *
 * @param status 400, 403, 405, or 413 error status code.
 * @returns Empty Response with the designated status.
 */
function invalidTelemetryResponse(status: 400 | 403 | 405 | 413): Response {
  return new Response(null, { status });
}

/**
 * Sanitizes arbitrary string input to alphanumeric, underscore, dot, and hyphen characters, capped at 64 characters.
 *
 * @param value Candidate string value.
 * @returns Sanitized string or `undefined` if empty/non-string.
 */
function safeField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

/**
 * Validates whether an input represents a valid HTTP status code (100–599 integer).
 *
 * @param value Candidate status value.
 * @returns Integer status code or `undefined` if invalid.
 */
function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * Validates whether an input is a valid hexadecimal hash string (8–64 hex chars), returning lowercase.
 *
 * @param value Candidate hash string.
 * @returns Normalized lowercase hash string or `undefined` if invalid.
 */
function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8,64}$/i.test(value)
    ? value.slice(0, 64).toLowerCase()
    : undefined;
}

/**
 * Validates whether an input is a valid SCREAMING_SNAKE_CASE configuration key name.
 *
 * @param value Candidate configuration key.
 * @returns Validated key name or `undefined` if invalid.
 */
function safeConfigurationKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}

/**
 * Verifies that the incoming request's `Origin` header matches the target worker origin, preventing CSRF.
 *
 * @param request Inbound HTTP request.
 * @param url Parsed target URL.
 * @returns `true` if same-origin.
 */
function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

/**
 * Reports whether a request path belongs to the bearer-authenticated public API.
 * Only these paths must have the Better Auth session cookie stripped before
 * proxying, so the API Worker never receives it.
 *
 * @param pathname Request URL pathname.
 * @returns `true` when the path is `/api/v1` or below.
 */
function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/**
 * Removes Better Auth session cookies from a `Cookie` header value, preserving
 * any other cookies (such as a Cloudflare Access session) that the edge needs.
 *
 * @param cookieHeader Raw `Cookie` header value or null.
 * @returns Filtered cookie string, or null when no cookies remain.
 */
function stripBetterAuthCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part.length === 0) return false;
      const name = part.split("=", 1)[0]?.trim() ?? "";
      return !/^(?:__Secure-|__Host-)?better-auth\.session_token$/.test(name);
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * Proxies an `/api/*` request to the Meltiply API Worker, keeping the browser
 * strictly same-origin so the HttpOnly Better Auth session cookie flows without
 * CORS. A defined `API_ORIGIN` (local development and preview builds) is used
 * first; deployed environments omit it and route through the `API` service
 * binding instead. Method, headers, and body are preserved, and the original
 * `Origin` header is forwarded untouched so the API's own origin checks still
 * apply. `/api/v1` requests carry their Better Auth cookies only as far as this
 * Worker: `isPublicApiPath` scopes the stripping so `/api/auth` keeps its session.
 *
 * @param request Inbound HTTP request targeting `/api/*`.
 * @param env Worker environment bindings (`API_ORIGIN` local upstream or `API` service binding).
 * @param url Parsed inbound request URL.
 * @returns The API Worker's response; the caller maps a missing upstream to 502.
 */
async function proxyApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = new Headers(request.headers);
  if (isPublicApiPath(url.pathname)) {
    const stripped = stripBetterAuthCookies(headers.get("Cookie"));
    if (stripped === null) {
      headers.delete("Cookie");
    } else {
      headers.set("Cookie", stripped);
    }
  }

  const init: RequestInit = {
    body: request.body,
    headers,
    method: request.method,
    redirect: "manual",
    ...(request.body ? { duplex: "half" } : {}),
  };

  // A local API origin wins over a deployed service binding: local development
  // and preview builds define API_ORIGIN for the Wrangler API process, while
  // deployed environments never define it and route through `API` instead.
  // Checking the binding first made a built preview call the not-running
  // `meltiply-api` service, so every session request failed with 503.
  if (env.API_ORIGIN) {
    const target = new URL(`${url.pathname}${url.search}`, env.API_ORIGIN);
    return fetch(new Request(target, init));
  }
  if (env.API) {
    return env.API.fetch(new Request(request.url, init));
  }
  throw new Error("API upstream is not configured");
}

/**
 * Builds standard structured logging context with request ID, trace ID, service name, and environment.
 *
 * @param env Worker environment bindings.
 * @param requestId Request trace identifier.
 * @param traceId Distributed trace identifier.
 * @returns Structured log context object.
 */
function telemetryContext(env: Env, requestId: string, traceId: string) {
  return {
    environment: safeField(env.ENVIRONMENT) ?? "unknown",
    request_id: requestId,
    service: "frontend",
    trace_id: traceId,
    version: safeField(env.VERSION) ?? "unknown",
  };
}

/**
 * Safely streams the request body up to 4096 bytes, returning 413 if the payload exceeds limits.
 *
 * @param request Inbound HTTP request.
 * @returns Decoded text body, 413 status indicator if oversized, or null on stream error.
 */
async function readTelemetryBody(request: Request): Promise<string | 413 | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumTelemetryBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The request is already over the limit; preserve the 413 result.
        }
        return 413;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Validates, deserializes, sanitizes, and logs client-side telemetry events forwarded from the frontend SPA.
 *
 * @param request Inbound POST request containing telemetry JSON.
 * @param env Worker environment bindings.
 * @returns 204 No Content on success, or 400/413 error response.
 */
async function handleTelemetry(request: Request, env: Env): Promise<Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return invalidTelemetryResponse(400);
    if (Number(contentLength) > maximumTelemetryBodyBytes) {
      return invalidTelemetryResponse(413);
    }
  }

  const body = await readTelemetryBody(request);
  if (body === 413) return invalidTelemetryResponse(413);
  if (body === null) return invalidTelemetryResponse(400);

  let payload: TelemetryPayload;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidTelemetryResponse(400);
    }
    payload = parsed as TelemetryPayload;
  } catch {
    return invalidTelemetryResponse(400);
  }

  if (typeof payload.kind !== "string" || telemetryKinds[payload.kind] !== true) {
    return invalidTelemetryResponse(400);
  }
  if (
    (payload.code !== undefined &&
      (typeof payload.code !== "string" ||
        payload.code.length === 0 ||
        payload.code.length > 128)) ||
    (payload.configurationKey !== undefined &&
      safeConfigurationKey(payload.configurationKey) === undefined) ||
    (payload.configurationSource !== undefined &&
      (typeof payload.configurationSource !== "string" ||
        payload.configurationSource.length === 0 ||
        payload.configurationSource.length > 64)) ||
    (payload.configurationState !== undefined &&
      (typeof payload.configurationState !== "string" ||
        payload.configurationState.length === 0 ||
        payload.configurationState.length > 64)) ||
    (payload.diagnosticCode !== undefined &&
      (typeof payload.diagnosticCode !== "string" ||
        payload.diagnosticCode.length === 0 ||
        payload.diagnosticCode.length > 64)) ||
    (payload.field !== undefined &&
      (typeof payload.field !== "string" ||
        payload.field.length === 0 ||
        payload.field.length > 128)) ||
    (payload.valueType !== undefined &&
      (typeof payload.valueType !== "string" ||
        payload.valueType.length === 0 ||
        payload.valueType.length > 64)) ||
    (payload.retryable !== undefined && typeof payload.retryable !== "boolean") ||
    (payload.status !== undefined && safeStatus(payload.status) === undefined) ||
    (payload.valueHash !== undefined && safeHash(payload.valueHash) === undefined)
  ) {
    return invalidTelemetryResponse(400);
  }

  const requestId = createRequestId();
  const traceId = createTraceId();
  const retryClass = payload.retryable === true ? "client_retry" : "none";
  const errorCode = safeField(payload.code) ?? payload.kind.replace(/-/g, "_");
  const status = safeStatus(payload.status);
  const field = safeField(payload.field);
  const hash = safeHash(payload.valueHash);
  const type = safeField(payload.valueType);
  const configurationKey = safeConfigurationKey(payload.configurationKey);
  const configurationSource = safeField(payload.configurationSource);
  const configurationState = safeField(payload.configurationState);
  const diagnosticCode = safeField(payload.diagnosticCode);
  const fields = {
    error_code: errorCode,
    event: "frontend_client_error",
    outcome: "error",
    retry_class: retryClass as "client_retry" | "none",
    ...(status !== undefined ? { status } : {}),
    ...(field ? { field } : {}),
    ...(hash ? { hash } : {}),
    ...(type ? { type } : {}),
    ...(configurationKey ? { configuration_key: configurationKey } : {}),
    ...(configurationSource ? { configuration_source: configurationSource } : {}),
    ...(configurationState ? { configuration_state: configurationState } : {}),
    ...(diagnosticCode ? { diagnostic_code: diagnosticCode } : {}),
  };
  log("error", telemetryContext(env, requestId, traceId), fields);
  return new Response(null, { status: 204 });
}

export default {
  /**
   * Primary entry point for the Cloudflare Worker fronting frontend static assets.
   * Routes `/api/*` to the API Worker (service binding in deployed environments,
   * `API_ORIGIN` fallback locally), handles `/health` checks and
   * `/__frontend-telemetry` reporting, and serves static assets via `env.ASSETS`.
   *
   * @param request Inbound HTTP request.
   * @param env Worker environment bindings containing ASSETS and API bindings.
   * @returns HTTP Response for the client.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await proxyApiRequest(request, env, url);
      } catch {
        const requestId = createRequestId();
        const traceId = createTraceId();
        log("error", telemetryContext(env, requestId, traceId), {
          error_code: "api_proxy_failed",
          event: "frontend_api_proxy",
          outcome: "error",
          retry_class: "client_retry",
        });
        return apiUnavailableResponse();
      }
    }
    if (url.pathname === "/health") {
      return Response.json({ service: "meltiply-frontend", status: "ok" });
    }
    if (url.pathname === telemetryPath) {
      if (request.method !== "POST") return invalidTelemetryResponse(405);
      if (!sameOrigin(request, url)) return invalidTelemetryResponse(403);
      const contentType = request.headers.get("Content-Type");
      if (!contentType || contentType.split(";", 1)[0].trim() !== "application/json") {
        return invalidTelemetryResponse(400);
      }
      return handleTelemetry(request, env);
    }
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      const requestId = createRequestId();
      const traceId = createTraceId();
      log("error", telemetryContext(env, requestId, traceId), {
        error_code: "asset_fetch_failed",
        event: "frontend_asset_fetch",
        outcome: "error",
        retry_class: "none",
      });
      return genericErrorResponse();
    }
  },
};
