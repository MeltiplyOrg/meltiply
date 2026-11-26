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
        code: "dependency_unavailable",
        details: [],
        message: "Request failed",
        request_id: "req_test",
        retryable,
      },
    },
  );
}

describe("shouldRetryQuery", () => {
  it.each([
    ["a first network failure", 0, new TypeError("offline"), true],
    ["a second retryable response", 1, apiError(503, true), true],
    ["a third failure", 2, apiError(503, true), false],
    ["an unauthenticated response", 0, apiError(401, true), false],
    ["a forbidden response", 0, apiError(403, true), false],
    ["a response marked final", 0, apiError(400, false), false],
  ])("%s", (_example, failureCount, error, retry) => {
    expect(shouldRetryQuery(failureCount, error)).toEqual(retry);
  });
});

describe("queryRetryDelay", () => {
  it.each([
    ["a Retry-After header", 0, apiError(429, true, "12"), 12_000],
    ["a Retry-After over the cap", 0, apiError(429, true, "31"), 30_000],
    ["a response without Retry-After", 1, apiError(503, true), 2_000],
    ["a first network failure", 0, new TypeError("offline"), 1_000],
    ["the last delay under the cap", 4, new TypeError("offline"), 16_000],
    ["the first capped delay", 5, new TypeError("offline"), 30_000],
  ])("%s", (_example, attempt, error, delay) => {
    expect(queryRetryDelay(attempt, error)).toEqual(delay);
  });
});

describe("pollingInterval", () => {
  it.each([
    ["an upload that has not started", { status: "pending_upload" }],
    ["an uploading asset", { status: "uploading" }],
    ["a processing asset", { status: "processing" }],
    ["an asset being deleted", { status: "deleting" }],
    [
      "a queued distribution deep in a list",
      { posts: [{ distributions: [{ status: "queued" }] }] },
    ],
  ])("%s", (_example, data) => {
    expect(pollingInterval(data)).toEqual(10_000);
  });

  it.each([
    ["only settled states", { distributions: [{ status: "published" }] }],
    ["a status that is not text", { status: 1 }],
    ["no data", undefined],
    ["an empty list", []],
  ])("%s", (_example, data) => {
    expect(pollingInterval(data)).toEqual(false);
  });
});
