import { createRequestId, createTraceId, log } from "@meltiply/observability";

const unsafeFieldCharactersPattern = /[^a-zA-Z0-9_.-]/g;
const hashPattern = /^[0-9a-f]{8,64}$/i;
const configurationKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const sessionCookiePattern = /^(?:__Secure-|__Host-)?better-auth\.session_token$/;
const integerPattern = /^\d+$/;

interface Env {
  API?: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  VERSION?: string;
}

const telemetryPath = "/__frontend-telemetry";
const maximumTelemetryBodyBytes = 4096;
const telemetryKinds = new Set(["api-error", "frontend-error", "unknown-contract-value"]);

type TelemetryPayload = {
  code?: unknown;
  configurationKey?: unknown;
  configurationSource?: unknown;
  configurationState?: unknown;
  diagnosticCode?: unknown;
  field?: unknown;
  kind?: unknown;
  retryable?: unknown;
  stack?: unknown;
  status?: unknown;
  valueHash?: unknown;
  valueType?: unknown;
};

const maximumRelayStackCharacters = 1_500;

const operationByField = new Map([
  ["auth-refresh", "auth"],
  ["auth-refresh-throttled", "auth"],
]);

function genericErrorResponse(): Response {
  return new Response("An error has occurred.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status: 500,
  });
}

function apiUnavailableResponse(): Response {
  return new Response("The API is unavailable.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    status: 502,
  });
}

function invalidTelemetryResponse(status: 400 | 403 | 405 | 413): Response {
  return new Response(null, { status });
}

function safeField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(unsafeFieldCharactersPattern, "_").slice(0, 64);
}

function invalidOptionalText(value: unknown, maximumLength: number): boolean {
  return (
    value !== undefined &&
    (typeof value !== "string" || value.length === 0 || value.length > maximumLength)
  );
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && hashPattern.test(value)
    ? value.slice(0, 64).toLowerCase()
    : undefined;
}

function safeConfigurationKey(value: unknown): string | undefined {
  return typeof value === "string" && configurationKeyPattern.test(value) ? value : undefined;
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

function relayAuthenticatedDiagnostic(
  payload: TelemetryPayload,
  request: Request,
  env: Env,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  context: FrontendTelemetryContext,
): void {
  if (payload.kind !== "frontend-error") return;
  if (safeField(payload.field) === "api-error") return;
  const authorization = request.headers.get("Authorization");
  if (!authorization || !/^Bearer \S+$/.test(authorization)) return;
  const stack =
    typeof payload.stack === "string" ? payload.stack.slice(0, maximumRelayStackCharacters) : "";
  const field = safeField(payload.field);
  const body = JSON.stringify({
    category: "client_exception",
    ...(stack ? { error_stack: stack } : {}),
    error_name: safeField(payload.valueType) ?? "Error",
    operation: (field && operationByField.get(field)) ?? "other",
  });
  const work = (async () => {
    try {
      const init: RequestInit = {
        body,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        method: "POST",
      };
      const response = env.API_ORIGIN
        ? await fetch(new URL("/api/v1/installation/reporting/diagnostics", env.API_ORIGIN), init)
        : env.API
          ? await env.API.fetch(
              new Request("http://frontend.local/api/v1/installation/reporting/diagnostics", init),
            )
          : undefined;
      await response?.body?.cancel().catch(() => {});
      log("debug", context, {
        diagnostic_relay: response ? response.status : "unavailable",
        event: "frontend_diagnostic_relay",
        outcome: "ok",
        retry_class: "none",
      });
    } catch {
      log("debug", context, {
        event: "frontend_diagnostic_relay",
        outcome: "failed",
        retry_class: "none",
      });
    }
  })();
  executionCtx?.waitUntil(work);
}

function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

function stripBetterAuthCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part.length === 0) return false;
      const name = part.split("=", 1)[0]?.trim() ?? "";
      return !sessionCookiePattern.test(name);
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

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

  if (env.API_ORIGIN) {
    const target = new URL(`${url.pathname}${url.search}`, env.API_ORIGIN);
    return fetch(new Request(target, init));
  }
  if (env.API) {
    return env.API.fetch(new Request(request.url, init));
  }
  throw new Error("API upstream is not configured");
}

export interface FrontendTelemetryContext {
  readonly environment: string;
  readonly request_id: string;
  readonly service: "frontend";
  readonly trace_id: string;
  readonly version: string;
}

function telemetryContext(env: Env, requestId: string, traceId: string): FrontendTelemetryContext {
  return {
    environment: safeField(env.ENVIRONMENT) ?? "unknown",
    request_id: requestId,
    service: "frontend",
    trace_id: traceId,
    version: safeField(env.VERSION) ?? "unknown",
  };
}

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
        await reader.cancel().catch(() => undefined);
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

async function handleTelemetry(
  request: Request,
  env: Env,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
): Promise<Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!integerPattern.test(contentLength)) return invalidTelemetryResponse(400);
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

  if (typeof payload.kind !== "string" || !telemetryKinds.has(payload.kind)) {
    return invalidTelemetryResponse(400);
  }
  if (
    invalidOptionalText(payload.code, 128) ||
    (payload.configurationKey !== undefined &&
      safeConfigurationKey(payload.configurationKey) === undefined) ||
    invalidOptionalText(payload.configurationSource, 64) ||
    invalidOptionalText(payload.configurationState, 64) ||
    invalidOptionalText(payload.diagnosticCode, 64) ||
    invalidOptionalText(payload.field, 128) ||
    invalidOptionalText(payload.valueType, 64) ||
    (payload.stack !== undefined &&
      (typeof payload.stack !== "string" || payload.stack.length > maximumRelayStackCharacters)) ||
    (payload.retryable !== undefined && typeof payload.retryable !== "boolean") ||
    (payload.status !== undefined && safeStatus(payload.status) === undefined) ||
    (payload.valueHash !== undefined && safeHash(payload.valueHash) === undefined)
  ) {
    return invalidTelemetryResponse(400);
  }

  const requestId = createRequestId();
  const traceId = createTraceId();
  const retryClass = payload.retryable === true ? "client_retry" : "none";
  const errorCode = safeField(payload.code) ?? payload.kind.replaceAll("-", "_");
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
  const logContext = telemetryContext(env, requestId, traceId);
  log("error", logContext, fields);
  relayAuthenticatedDiagnostic(payload, request, env, executionCtx, logContext);
  return new Response(null, { status: 204 });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
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
      return handleTelemetry(request, env, executionCtx);
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
