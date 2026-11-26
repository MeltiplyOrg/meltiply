import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ProviderAdapterError } from "../src/failures";
import {
  ProviderHttpClient,
  type ProviderHttpClientOptions,
  type ProviderHttpRequest,
} from "../src/http";
import type { ProviderRequestContext } from "../src/types";

const ORIGIN = "https://api.provider.example";
const newContext = (patch: Partial<ProviderRequestContext> = {}): ProviderRequestContext => ({
  operationId: "operation-1",
  requestId: "request-1",
  ...patch,
});

function setup(
  answer: typeof fetch = () => Promise.resolve(Response.json({ ok: 1 })),
  patch: Partial<ProviderHttpClientOptions> = {},
) {
  const requests: [string, RequestInit | undefined][] = [];
  const client = new ProviderHttpClient({
    allowedOrigins: [ORIGIN],
    fetch: (input, init) => {
      requests.push([String(input), init]);
      return answer(input, init);
    },
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    ...patch,
  });
  return { client, requests };
}

const answering = (response: Response) => () => Promise.resolve(response);
const get = (patch: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest => ({
  method: "GET",
  url: `${ORIGIN}/items`,
  ...patch,
});

async function failureOf(attempt: Promise<unknown>) {
  const error = await attempt.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof ProviderAdapterError)) return error;
  const { classification, code, retryable, retryAfterSeconds } = error.failure;
  return {
    classification,
    code,
    retryable,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

const failed = (classification: string, code: string, retryable: boolean) => ({
  classification,
  code,
  retryable,
});
const malformedRead = failed("transient", "provider_http_malformed_response", true);

const hanging: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

const stalledBody: typeof fetch = (_input, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );

const chunked = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );

beforeAll(async () => {
  await setup().client.request(newContext(), get());
});

describe("ProviderHttpClient", () => {
  describe("constructor", () => {
    it.each([
      ["no origin", []],
      ["a repeated origin", [ORIGIN, ORIGIN]],
    ])("%s", (_example, allowedOrigins) => {
      expect(() => new ProviderHttpClient({ allowedOrigins })).toThrow(
        new TypeError("provider HTTP client requires unique allowed origins"),
      );
    });

    it.each([
      ["an http origin", "http://a.example"],
      ["an origin with a path", "https://a.example/v1"],
      ["an origin with a trailing slash", "https://a.example/"],
      ["an origin with credentials", "https://u:p@a.example"],
    ])("%s", (_example, value) => {
      expect(() => new ProviderHttpClient({ allowedOrigins: [value] })).toThrow(
        new TypeError("provider origin must be a canonical HTTPS origin"),
      );
    });

    it.each([
      ["no response bytes", { maximumResponseBytes: 0 }, "maximumResponseBytes"],
      ["response bytes over 1 MiB", { maximumResponseBytes: 1_048_577 }, "maximumResponseBytes"],
      ["no timeout", { timeoutMilliseconds: 0 }, "timeoutMilliseconds"],
      ["a timeout over two minutes", { timeoutMilliseconds: 120_001 }, "timeoutMilliseconds"],
    ])("%s", (_example, patch, name) => {
      expect(() => new ProviderHttpClient({ allowedOrigins: [ORIGIN], ...patch })).toThrow(name);
    });
  });

  describe("request", () => {
    it("a JSON read", async () => {
      const { client, requests } = setup(
        answering(Response.json({ id: 1 }, { headers: { "X-Next-Cursor": "c2" } })),
      );

      const response = await client.request(newContext(), get());

      expect([response.status, response.body, response.headers.get("X-Next-Cursor")]).toEqual([
        200,
        { id: 1 },
        "c2",
      ]);
      expect(requests).toEqual([
        [
          `${ORIGIN}/items`,
          {
            cache: "no-store",
            headers: new Headers({ Accept: "application/json" }),
            method: "GET",
            redirect: "manual",
            signal: expect.any(AbortSignal),
          },
        ],
      ]);
    });

    it("a write with a body and its own Accept header", async () => {
      const { client, requests } = setup();

      await client.request(
        newContext(),
        get({ method: "POST", body: "payload", headers: { Accept: "text/plain" } }),
      );

      expect(requests).toEqual([
        [
          `${ORIGIN}/items`,
          expect.objectContaining({
            body: "payload",
            headers: new Headers({ Accept: "text/plain" }),
            method: "POST",
          }),
        ],
      ]);
    });

    it("a fetch that needs the global receiver", async () => {
      const bound = function (this: unknown) {
        return this === globalThis
          ? Promise.resolve(Response.json({ ok: 1 }))
          : Promise.reject(new TypeError("Illegal invocation"));
      };
      const client = new ProviderHttpClient({ allowedOrigins: [ORIGIN], fetch: bound });

      expect((await client.request(newContext(), get())).body).toEqual({ ok: 1 });
    });

    it.each([
      ["another origin", "https://evil.example/x"],
      ["an http URL", "http://api.provider.example/x"],
      ["a username", "https://u@api.provider.example/x"],
      ["a password", "https://:p@api.provider.example/x"],
      ["a fragment", `${ORIGIN}/x#a`],
    ])("%s is refused before any request", async (_example, url) => {
      const { client, requests } = setup();

      await expect(client.request(newContext(), get({ url }))).rejects.toThrow(
        new TypeError("provider request URL is outside the allowed origins"),
      );
      expect(requests).toEqual([]);
    });

    it.each([
      ["eleven accepted statuses", Array.from({ length: 11 }, (_, i) => 400 + i)],
      ["a repeated accepted status", [404, 404]],
      ["an accepted status under 200", [199]],
      ["an accepted status over 599", [600]],
    ])("%s", async (_example, acceptedStatuses) => {
      const { client } = setup();

      await expect(client.request(newContext(), get({ acceptedStatuses }))).rejects.toThrow(
        new TypeError("provider accepted statuses are invalid"),
      );
    });

    it("a redirect", async () => {
      const { client } = setup(
        answering(new Response(null, { status: 302, headers: { Location: "https://evil" } })),
      );

      expect(await failureOf(client.request(newContext(), get()))).toEqual(
        failed("deterministic", "provider_http_redirect", false),
      );
    });

    it.each([
      ["an accepted redirect status", 308],
      ["an accepted error status", 404],
    ])("%s", async (_example, status) => {
      const { client } = setup(answering(new Response(null, { status })));

      const response = await client.request(
        newContext(),
        get({ acceptedStatuses: [status], responseType: "empty" }),
      );

      expect([response.status, response.body]).toEqual([status, undefined]);
    });

    it.each([
      ["a 400", 400, "deterministic", false],
      ["a 401", 401, "auth", false],
      ["a 500", 500, "transient", true],
    ])("%s", async (_example, status, classification, retryable) => {
      const { client } = setup(answering(Response.json({}, { status })));

      expect(await failureOf(client.request(newContext(), get()))).toEqual(
        failed(classification, `provider_http_${status}`, retryable),
      );
    });

    it.each([
      ["a delay in seconds", "30", 30],
      ["a delay as a date", "Sun, 19 Jul 2026 00:01:00 GMT", 60],
      ["a fractional delay", "1.5", 2],
    ])("a rate limit with %s", async (_example, retryAfter, retryAfterSeconds) => {
      const { client } = setup(
        answering(new Response(null, { status: 429, headers: { "Retry-After": retryAfter } })),
      );

      expect(await failureOf(client.request(newContext(), get()))).toEqual({
        ...failed("rate_limit", "provider_http_429", true),
        retryAfterSeconds,
      });
    });

    it.each([
      ["over a day", "86401"],
      ["in the past", "Sat, 18 Jul 2026 00:00:00 GMT"],
      ["that is not a delay", "soon"],
    ])("a rate limit with a delay %s", async (_example, retryAfter) => {
      const { client } = setup(
        answering(new Response(null, { status: 429, headers: { "Retry-After": retryAfter } })),
      );

      expect(await failureOf(client.request(newContext(), get()))).toEqual(
        failed("rate_limit", "provider_http_429", true),
      );
    });

    it("an error carries only the method, origin and status", async () => {
      const { client } = setup(
        answering(Response.json({ secret: "must-not-leak" }, { status: 400 })),
      );
      const classifyErrorBody = () => ({ code: "provider_denied" });

      const error = await client
        .request(newContext(), get({ classifyErrorBody }))
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        request: { method: "GET", origin: ORIGIN, status_code: 400 },
      });
      expect(JSON.stringify(error)).not.toContain("must-not-leak");
    });

    it.each([
      ["a refused answer", 503],
      ["a redirect", 302],
    ])("%s has its body stream cancelled", async (_example, status) => {
      let cancelled = 0;
      const body = new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      });
      const { client } = setup(answering(new Response(body, { status })));

      await failureOf(client.request(newContext(), get()));

      expect(cancelled).toEqual(1);
    });

    it("rate-limit headers of a refused answer", async () => {
      const { client } = setup(
        answering(Response.json({}, { headers: { "x-ratelimit-reset": "20" }, status: 429 })),
        { platform: "tiktok" },
      );
      const context = newContext();

      await failureOf(client.request(context, get()));

      expect(context.metadata).toEqual({
        rateLimitBudget: { percentUsed: null, remaining: null, resetsInSeconds: 20 },
      });
    });

    it("an error body refines the classification", async () => {
      const { client } = setup(answering(Response.json({ reason: "quota" }, { status: 400 })));
      const classifyErrorBody = (status: number, body: unknown) => ({
        code: `seen_${status}_${JSON.stringify(body)}`.replace(/[^a-z0-9_]/g, ""),
        quotaExceeded: true,
      });

      expect(await failureOf(client.request(newContext(), get({ classifyErrorBody })))).toEqual(
        failed("quota", "seen_400_reasonquota", false),
      );
    });

    it.each([
      ["no error body", new Response(null, { status: 400 })],
      ["an error body that is not JSON", new Response("<html>", { status: 400 })],
    ])("%s reaches the classifier as nothing", async (_example, response) => {
      const { client } = setup(answering(response));
      const seen: unknown[] = [];

      await failureOf(
        client.request(
          newContext(),
          get({
            classifyErrorBody: (_status, body) => {
              seen.push(body);
              return undefined;
            },
          }),
        ),
      );

      expect(seen).toEqual([undefined]);
    });

    it("a classifier that throws", async () => {
      const { client } = setup(answering(Response.json({}, { status: 400 })));
      const classifyErrorBody = () => {
        throw new Error("boom");
      };

      expect(await failureOf(client.request(newContext(), get({ classifyErrorBody })))).toEqual(
        failed("deterministic", "provider_http_400", false),
      );
    });

    it.each([
      ["an ignored body", "empty", Response.json({ a: 1 })],
      ["an allowed empty body", "json_or_empty", new Response(null, { status: 200 })],
    ] as const)("%s", async (_example, responseType, response) => {
      const { client } = setup(answering(response));

      expect((await client.request(newContext(), get({ responseType }))).body).toEqual(undefined);
    });

    it.each([
      ["an empty body", new Response(null, { status: 200 })],
      ["a body that is not declared JSON", new Response("{}", { status: 200 })],
      [
        "a body that is not valid JSON",
        new Response("{", { headers: { "Content-Type": "application/json" } }),
      ],
      [
        "a declared length over the maximum",
        Response.json({}, { headers: { "Content-Length": "999999" } }),
      ],
      ["streamed chunks over the maximum", chunked('{"a":"', "x".repeat(20), '"}')],
    ])("%s", async (_example, response) => {
      const { client } = setup(answering(response), { maximumResponseBytes: 16 });

      expect(await failureOf(client.request(newContext(), get()))).toEqual(malformedRead);
    });

    it("a malformed answer to a write", async () => {
      const { client } = setup(answering(new Response("{}", { status: 200 })));
      const write = get({ method: "POST", sideEffectPossible: true });

      expect(await failureOf(client.request(newContext(), write))).toEqual(
        failed("ambiguous", "provider_http_malformed_response", false),
      );
    });

    it("invalid JSON keeps no response bytes in its cause", async () => {
      const { client } = setup(
        answering(new Response("secret", { headers: { "Content-Type": "application/json" } })),
      );

      await expect(client.request(newContext(), get())).rejects.toMatchObject({
        cause: new SyntaxError("Provider response is not valid JSON"),
      });
    });

    it("a body split into several chunks", async () => {
      const { client } = setup(answering(chunked('{"a":', '"', "x".repeat(40), '"}')));

      expect((await client.request(newContext(), get())).body).toEqual({ a: "x".repeat(40) });
    });

    it.each([
      ["kept as text when asked", true, "9007199254740993"],
      ["rounded by default", false, 9007199254740992],
    ])("a large integer is %s", async (_example, preserveLargeIntegers, id) => {
      const { client } = setup(
        answering(
          new Response('{"id":9007199254740993}', {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const response = await client.request(newContext(), get({ preserveLargeIntegers }));

      expect(response.body).toEqual({ id });
    });

    it("a network failure", async () => {
      const { client } = setup(() => Promise.reject(new TypeError("socket")));

      expect(await failureOf(client.request(newContext(), get()))).toEqual(
        failed("transient", "provider_http_request_failed", true),
      );
    });

    it.each([
      ["a read", false, "timeout", true],
      ["a possible write", true, "ambiguous", false],
    ])("%s that never answers", async (_example, sideEffectPossible, classification, retryable) => {
      const { client } = setup(hanging, { timeoutMilliseconds: 1 });

      expect(await failureOf(client.request(newContext(), get({ sideEffectPossible })))).toEqual(
        failed(classification, "provider_http_timeout", retryable),
      );
    });

    it("a body that stalls past the timeout", async () => {
      const { client } = setup(stalledBody, { timeoutMilliseconds: 1 });

      expect(await failureOf(client.request(newContext(), get()))).toEqual(
        failed("timeout", "provider_http_timeout", true),
      );
    });

    it("a caller that already aborted", async () => {
      const { client } = setup((_input, init) => Promise.reject(init?.signal?.reason));
      const context = newContext({ signal: AbortSignal.abort() });

      expect(await failureOf(client.request(context, get()))).toEqual(
        failed("timeout", "provider_http_timeout", true),
      );
    });

    it("rate-limit headers of the configured platform", async () => {
      const { client } = setup(
        answering(Response.json({}, { headers: { "x-ratelimit-remaining": "3" } })),
        { platform: "tiktok" },
      );
      const context = newContext();

      await client.request(context, get());

      expect(context.metadata).toEqual({
        rateLimitBudget: { percentUsed: null, remaining: 3, resetsInSeconds: null },
      });
    });

    it("rate-limit headers without a configured platform", async () => {
      const { client } = setup(
        answering(Response.json({}, { headers: { "x-ratelimit-remaining": "3" } })),
      );
      const context = newContext({ metadata: {} });

      await client.request(context, get());

      expect(context.metadata).toEqual(undefined);
    });
  });

  describe("requestEffect", () => {
    it("a JSON read", async () => {
      const { client } = setup();

      const response = await Effect.runPromise(client.requestEffect(newContext(), get()));

      expect(response.body).toEqual({ ok: 1 });
    });

    it("a refused request", async () => {
      const { client } = setup(answering(Response.json({}, { status: 401 })));

      const attempt = Effect.runPromise(client.requestEffect(newContext(), get()));

      expect(await failureOf(attempt)).toEqual(failed("auth", "provider_http_401", false));
    });
  });
});
