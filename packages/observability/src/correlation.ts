const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const traceparentPattern = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;

/** The incoming request ID when it is 8-128 safe characters, otherwise a fresh UUID. */
export function createRequestId(incoming?: string | null): string {
  const normalized = incoming?.trim();
  if (normalized && requestIdPattern.test(normalized)) {
    return normalized;
  }
  return crypto.randomUUID();
}

/** The W3C `traceparent` trace ID when valid and non-zero, otherwise `createRequestId(fallback)`. */
export function createTraceId(traceparent?: string | null, fallback?: string): string {
  const match = traceparentPattern.exec(traceparent?.trim() ?? "");
  const traceId = match?.[1];
  const parentId = match?.[2];
  if (
    traceId &&
    traceId !== "00000000000000000000000000000000" &&
    parentId &&
    parentId !== "0000000000000000"
  ) {
    return traceId.toLowerCase();
  }
  return createRequestId(fallback);
}

export function elapsedMilliseconds(startedAt: number, finishedAt = performance.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.round(Math.max(0, finishedAt - startedAt) * 100) / 100;
}
