import type { Context } from "hono";

import { sha256Hex } from "./crypto";
import type { ApiWorkerEnvironment } from "./env";

const weakEtagPrefixPattern = /^W\//;

export function idempotencyHeaders(replayed: boolean): Record<string, string> {
  return replayed ? { "Idempotency-Replayed": "true" } : {};
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Request-ID", requestId);
  return new Response(JSON.stringify(body), {
    headers: responseHeaders,
    status,
  });
}

export function noContentResponse(requestId: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("X-Request-ID", requestId);
  return new Response(null, {
    headers: responseHeaders,
    status: 204,
  });
}

function entityTagMatches(header: string | undefined, current: string): boolean {
  return (
    header?.split(",").some((candidate) => {
      const value = candidate.trim();
      return value === "*" || value.replace(weakEtagPrefixPattern, "") === current;
    }) ?? false
  );
}

export async function conditionalJsonResponse(
  c: Context<ApiWorkerEnvironment>,
  body: unknown,
): Promise<Response> {
  const etag = `"${await sha256Hex(JSON.stringify(body))}"`;
  const requestId = c.get("requestId");
  if (entityTagMatches(c.req.header("If-None-Match"), etag)) {
    return new Response(null, {
      headers: { ETag: etag, "X-Request-ID": requestId },
      status: 304,
    });
  }
  return jsonResponse(body, 200, requestId, { ETag: etag });
}

export function errorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  details: readonly {
    actual?: number;
    code: string;
    constraint?: string;
    field?: string | null;
    limit?: number;
    message: string;
  }[] = [],
  headers?: HeadersInit,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        details,
        issues: details.map((detail) => ({
          actual: detail.actual,
          constraint: detail.constraint ?? detail.code,
          field: detail.field ?? "",
          limit: detail.limit,
          message: detail.message,
        })),
        message,
        request_id: requestId,
        retryable: status === 429 || status >= 500,
      },
    },
    status,
    requestId,
    headers,
  );
}
