import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as api from "./api";
import { captureAuthJwt, clearAuthJwt } from "./auth-token";

const envelope = {
  code: "rate_limited",
  details: [{ code: "quota", message: "Try later" }],
  message: "Distribution quota exceeded",
  request_id: "req_test_123",
  retryable: true,
};

function summary(error: api.ApiError) {
  return {
    code: error.code,
    details: error.details,
    message: error.message,
    requestId: error.requestId,
    retryAfterSeconds: error.retryAfterSeconds,
    retryable: error.retryable,
    status: error.status,
  };
}

const fallback = (status: number, retryable: boolean) => ({
  code: "unknown_error",
  details: [],
  message: `Request failed with status ${status}`,
  requestId: null,
  retryAfterSeconds: null,
  retryable,
  status,
});

describe("ApiError", () => {
  it("the error envelope", () => {
    const response = new Response(null, { headers: { "retry-after": "17" }, status: 429 });

    expect(summary(new api.ApiError(response, { error: envelope }))).toEqual({
      code: "rate_limited",
      details: [{ code: "quota", message: "Try later" }],
      message: "Distribution quota exceeded",
      requestId: "req_test_123",
      retryAfterSeconds: 17,
      retryable: true,
      status: 429,
    });
  });

  it("an unknown payload with a request ID header", () => {
    const response = new Response(null, { headers: { "x-request-id": "req_header" }, status: 503 });

    expect(summary(new api.ApiError(response, { future_error: "new shape" }))).toEqual({
      ...fallback(503, true),
      requestId: "req_header",
    });
  });

  it.each([
    ["no payload", undefined],
    ["a null error", { error: null }],
    ["no code", { error: { ...envelope, code: undefined } }],
    ["no message", { error: { ...envelope, message: undefined } }],
    ["no request ID", { error: { ...envelope, request_id: undefined } }],
    ["no retry flag", { error: { ...envelope, retryable: undefined } }],
    ["details that are not a list", { error: { ...envelope, details: "x" } }],
  ])("%s", (_example, payload) => {
    expect(summary(new api.ApiError(new Response(null, { status: 499 }), payload))).toEqual(
      fallback(499, false),
    );
  });

  it("the first retryable status", () => {
    expect(new api.ApiError(new Response(null, { status: 500 }), null).retryable).toEqual(true);
  });

  it.each([
    ["no delay", {}, null],
    ["a delay of zero", { "retry-after": "0" }, 0],
    ["a date already past", { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, 0],
    ["a negative delay", { "retry-after": "-5" }, 0],
    ["text", { "retry-after": "soon" }, null],
  ])("%s before retrying", (_example, headers, seconds) => {
    const response = new Response(null, { headers, status: 429 });

    expect(new api.ApiError(response, null).retryAfterSeconds).toEqual(seconds);
  });
});

describe("API requests", () => {
  let requests: Record<string, string | null>[];
  let answer: (url: string) => Response;

  beforeAll(async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({})));
    await Effect.runPromise(api.getCurrentUser(null));
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    requests = [];
    answer = () => Response.json({ ok: true });
    vi.stubGlobal("fetch", (input: Request | string, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(init?.headers ?? request.headers);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: headers.get("authorization"),
        workspace: headers.get("x-workspace-id"),
        idempotency: headers.get("idempotency-key"),
        credentials: init?.credentials ?? request.credentials,
      });
      return Promise.resolve(answer(request.url));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthJwt();
  });

  const anonymous = {
    method: "GET",
    url: "http://localhost:8787/api/v1/posts",
    authorization: null,
    workspace: null,
    idempotency: null,
    credentials: "same-origin",
  };

  it("a successful read without a workspace", async () => {
    const body = await Effect.runPromise(api.listPosts(null));

    expect(body).toEqual({ ok: true });
    expect(requests).toEqual([anonymous]);
  });

  it("a blank workspace", async () => {
    await Effect.runPromise(api.listPosts("   "));

    expect(requests).toEqual([anonymous]);
  });

  it("a selected workspace after sign-in", async () => {
    captureAuthJwt(new Response(null, { headers: { "set-auth-jwt": "jwt-1" } }));

    await Effect.runPromise(api.listPosts("ws-123"));

    expect(requests).toEqual([
      { ...anonymous, authorization: "Bearer jwt-1", workspace: "ws-123" },
    ]);
  });

  it("a refused request", async () => {
    answer = () => Response.json({ error: envelope }, { status: 429 });

    const error = await Effect.runPromise(Effect.flip(api.listPosts(null)));

    expect(error.code).toEqual("rate_limited");
  });

  it("an OAuth start", async () => {
    await Effect.runPromise(api.startPlatformOAuth(null, "threads"));

    expect(requests.map(({ url }) => url)).toEqual([
      "http://localhost:8787/api/v1/platforms/threads/connect",
    ]);
  });

  it("a write with a supplied idempotency key", async () => {
    await Effect.runPromise(
      api.createPost(null, {} as Parameters<typeof api.createPost>[1], { idempotencyKey: "key-1" }),
    );

    expect(requests.map(({ idempotency }) => idempotency)).toEqual(["key-1"]);
  });

  it("a write without an idempotency key", async () => {
    await Effect.runPromise(api.createPost(null, {} as Parameters<typeof api.createPost>[1]));

    expect(requests.map(({ idempotency }) => idempotency)).toEqual([
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    ]);
  });

  const signed = "https://objects.example/original.png";

  it("an asset read through its signed URL", async () => {
    captureAuthJwt(new Response(null, { headers: { "set-auth-jwt": "jwt-1" } }));
    answer = (url) => (url === signed ? new Response("bytes") : Response.json({ url: signed }));

    const blob = await Effect.runPromise(api.getAssetBlob("ws-123", "asset-1"));

    expect(await blob.text()).toEqual("bytes");
    expect(requests[1]).toEqual({ ...anonymous, url: signed, credentials: "omit" });
  });

  it("a signed read that is refused", async () => {
    answer = (url) =>
      url === signed ? new Response(null, { status: 403 }) : Response.json({ url: signed });

    const error = await Effect.runPromise(Effect.flip(api.getAssetBlob(null, "asset-1")));

    expect(error.status).toEqual(403);
  });
});
