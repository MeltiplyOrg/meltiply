/**
 * Constructs a standard JSON HTTP Response with canonical content-type and tracing headers.
 *
 * Enforces `Content-Type: application/json; charset=utf-8` and propagates the `X-Request-ID`
 * correlation header required by all Meltiply API endpoints.
 *
 * @param body - Serializable JSON payload for the response body.
 * @param status - HTTP status code (e.g. 200, 201, 202).
 * @param requestId - Correlation ID for the request.
 * @param headers - Optional custom headers to merge into the response.
 * @returns Standard Fetch API Response object.
 */
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

/**
 * Builds the canonical contract-compliant error response envelope.
 *
 * Formats structured errors with code, message, request ID, and dual details/issues arrays.
 * Automatically marks 429 and 5xx status codes as retryable for client backoff strategies.
 *
 * @param requestId - Correlation ID for the failed request.
 * @param status - HTTP status code (e.g. 400, 401, 403, 404, 409, 422, 500, 503).
 * @param code - Machine-readable error code string (e.g. "invalid_request", "quota_exceeded").
 * @param message - Human-readable explanation of the error.
 * @param details - Optional list of detailed validation or constraint failures.
 * @param headers - Optional additional headers (e.g. Retry-After).
 * @returns JSON Response matching the OpenAPI ErrorResponse schema.
 */
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
