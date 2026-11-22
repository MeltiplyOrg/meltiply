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
