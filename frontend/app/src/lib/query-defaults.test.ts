import { describe, expect, it } from "vite-plus/test";

import { ApiError } from "./api";
import { pollingInterval, queryRetryDelay, shouldRetryQuery } from "./query-defaults";

function apiError(status: number, retryable: boolean, retryAfter?: string) {
  return new ApiError(
    new Response(null, {
      headers: retryAfter ? { "retry-after": retryAfter } : undefined,
      status,
    }),
    {
      error: {
        code: status === 401 ? "token_expired" : "dependency_unavailable",
        details: [],
        message: "Request failed",
        request_id: "req_test",
        retryable,
      },
    },
  );
}

describe("shared query defaults", () => {
  it("retries bounded transient failures but never authorization failures", () => {
    expect(shouldRetryQuery(0, new TypeError("offline"))).toBe(true);
    expect(shouldRetryQuery(1, apiError(503, true))).toBe(true);
    expect(shouldRetryQuery(2, apiError(503, true))).toBe(false);
    expect(shouldRetryQuery(0, apiError(401, true))).toBe(false);
    expect(shouldRetryQuery(0, apiError(403, true))).toBe(false);
    expect(shouldRetryQuery(0, apiError(400, false))).toBe(false);
  });

  it("honors Retry-After and caps exponential delay", () => {
    expect(queryRetryDelay(0, apiError(429, true, "12"))).toBe(12_000);
    expect(queryRetryDelay(10, new TypeError("offline"))).toBe(30_000);
  });

  it("polls only while an async contract state is active", () => {
    expect(pollingInterval({ status: "processing" })).toBe(10_000);
    expect(
      pollingInterval({
        comments: [{ reply_status: "queued" }],
      }),
    ).toBe(10_000);
    expect(
      pollingInterval({
        distributions: [{ status: "published" }],
      }),
    ).toBe(false);
  });
});
