import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderAdapterError, ProviderHttpClient } from "../src";
import type { ProviderRequestContext } from "../src/types";

const context = { operationId: "operation-1", requestId: "request-1" };

function client(
  implementation: typeof fetch,
  patch: Partial<ConstructorParameters<typeof ProviderHttpClient>[0]> = {},
) {
  return new ProviderHttpClient({
    allowedOrigins: ["https://api.provider.example"],
    fetch: implementation,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    timeoutMilliseconds: 100,
    ...patch,
  });
}

function json(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, init);
}

describe("ProviderHttpClient", () => {
  // Workers fetch rejects a client instance as its receiver; model that native
  // constraint to ensure valid provider responses remain reachable at runtime.
  it("supports a fetch implementation requiring the global receiver", async () => {
    const fetcher: typeof fetch = function (this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(json({ account_id: "facebook-page-1" }));
    };
    const response = await client(fetcher).request<{ account_id: string }>(context, {
      method: "GET",
      url: "https://api.provider.example/account",
    });
    expect(response.body).toEqual({ account_id: "facebook-page-1" });
  });

  it("accepts bounded JSON and preserves headers needed for pagination", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ items: [{ id: "item-1" }] }, { headers: { "X-Next-Cursor": "cursor-2" } }),
    );
    const response = await client(fetcher).request<{
      items: { id: string }[];
    }>(context, {
      headers: { Authorization: "Bearer provider-secret" },
      method: "GET",
      url: "https://api.provider.example/items?cursor=cursor-1",
    });

    expect(response.body).toEqual({ items: [{ id: "item-1" }] });
    expect(response.headers.get("X-Next-Cursor")).toBe("cursor-2");
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://api.provider.example/items?cursor=cursor-1"),
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
        redirect: "manual",
      }),
    );
  });

  it("records extracted rate-limit metadata for success and error responses", async () => {
    const extractor = vi.fn((headers: Headers) => {
      const remaining = headers.get("X-RateLimit-Remaining");
      return remaining === null
        ? null
        : {
            percentUsed: null,
            remaining: Number(remaining),
            resetsInSeconds: 20,
          };
    });
    const requestContext: ProviderRequestContext = { ...context };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: true }, { headers: { "X-RateLimit-Remaining": "12" } }))
      .mockResolvedValueOnce(json({}, { headers: { "X-RateLimit-Remaining": "0" }, status: 429 }))
      .mockResolvedValueOnce(json({ ok: true }));
    const provider = client(fetcher, { rateLimitBudget: extractor });

    await provider.request(requestContext, {
      method: "GET",
      url: "https://api.provider.example/status",
    });
    expect(requestContext.metadata).toEqual({
      rateLimitBudget: {
        percentUsed: null,
        remaining: 12,
        resetsInSeconds: 20,
      },
    });

    await expect(
      provider.request(requestContext, {
        method: "POST",
        sideEffectPossible: true,
        url: "https://api.provider.example/publish",
      }),
    ).rejects.toMatchObject({ failure: { classification: "rate_limit" } });
    expect(requestContext.metadata).toEqual({
      rateLimitBudget: { percentUsed: null, remaining: 0, resetsInSeconds: 20 },
    });

    await provider.request(requestContext, {
      method: "GET",
      url: "https://api.provider.example/status",
    });
    expect(requestContext.metadata).toBeUndefined();
    expect(extractor).toHaveBeenCalledTimes(3);
  });

  it("accepts an explicitly allowed empty protocol status", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { headers: { Range: "bytes=0-99" }, status: 308 }),
    );
    const response = await client(fetcher).request<undefined>(context, {
      acceptedStatuses: [308],
      method: "PUT",
      responseType: "json_or_empty",
      url: "https://api.provider.example/resumable-session",
    });

    expect(response).toMatchObject({ body: undefined, status: 308 });
    expect(response.headers.get("Range")).toBe("bytes=0-99");
    await expect(
      client(fetcher).request(context, {
        acceptedStatuses: [308, 308],
        method: "PUT",
        url: "https://api.provider.example/resumable-session",
      }),
    ).rejects.toThrow("accepted statuses are invalid");
  });

  it.each([
    [400, undefined, "deterministic", false],
    [401, undefined, "auth", false],
    [429, "30", "rate_limit", true],
    [503, undefined, "transient", true],
  ] as const)(
    "classifies HTTP %i without provider payload leakage",
    async (status, retryAfter, classification, retryable) => {
      const response = json(
        {
          access_token: "must-not-leak",
          error: "https://provider.example/private",
        },
        {
          headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
          status,
        },
      );
      const operation = client(async () => response).request(context, {
        method: "POST",
        sideEffectPossible: true,
        url: "https://api.provider.example/publish",
      });

      const error = await operation.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderAdapterError);
      expect(error).toMatchObject({
        failure: {
          classification,
          retryable,
          ...(retryAfter ? { retryAfterSeconds: 30 } : {}),
        },
      });
      expect(JSON.stringify(error)).not.toMatch(/must-not-leak|private/);
    },
  );

  it("cancels rejected response streams without changing classification", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"busy"}'));
        },
      }),
      { status: 503 },
    );

    await expect(
      client(async () => response).request(context, {
        method: "GET",
        url: "https://api.provider.example/status",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "transient", retryable: true },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("denies provider redirects instead of following them to an unapproved host", async () => {
    const cancel = vi.fn();
    const redirect = new Response(
      new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode("secret-elsewhere"));
        },
      }),
      { status: 302, headers: { Location: "https://attacker.example/take" } },
    );
    const read = client(async () => redirect).request(context, {
      method: "GET",
      url: "https://api.provider.example/status",
    });
    const write = client(async () => redirect).request(context, {
      method: "POST",
      sideEffectPossible: true,
      url: "https://api.provider.example/publish",
    });

    // The Workers runtime has no redirect: "error" mode, so denial is explicit.
    // A redirect is a deterministic provider fault and never a retryable read.
    await expect(read).rejects.toMatchObject({
      failure: {
        classification: "deterministic",
        code: "provider_http_redirect",
        retryable: false,
      },
    });
    await expect(write).rejects.toMatchObject({
      failure: { code: "provider_http_redirect" },
    });
    expect(cancel).toHaveBeenCalled();
  });

  // Native JSON.parse errors can embed response bytes; internal diagnostics
  // retain the failure kind and request status, never that provider payload.
  it("does not retain malformed provider response bytes in exception diagnostics", async () => {
    const transport = client(
      async () =>
        new Response("private-provider-payload", {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const error = await transport
      .request(context, {
        method: "GET",
        url: "https://api.provider.example/status",
      })
      .catch((cause: unknown) => cause);
    if (!(error instanceof ProviderAdapterError) || !(error.cause instanceof SyntaxError)) {
      throw new Error("Expected a classified JSON parsing failure");
    }
    expect(error.failure.code).toBe("provider_http_malformed_response");
    expect(error.request).toMatchObject({
      method: "GET",
      origin: "https://api.provider.example",
      status_code: 200,
    });
    expect(`${error.cause.message}\n${error.cause.stack}`).not.toContain(
      "private-provider-payload",
    );
  });

  it("treats malformed success as transient for reads and ambiguous for writes", async () => {
    const malformed = () =>
      Promise.resolve(
        new Response("access_token=secret", {
          headers: { "Content-Type": "application/json" },
        }),
      );
    const read = client(malformed).request(context, {
      method: "GET",
      url: "https://api.provider.example/status",
    });
    const write = client(malformed).request(context, {
      method: "POST",
      sideEffectPossible: true,
      url: "https://api.provider.example/publish",
    });

    await expect(read).rejects.toMatchObject({
      failure: { classification: "transient", retryable: true },
    });
    await expect(write).rejects.toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
    });
  });

  it("bounds streamed responses before parsing", async () => {
    const operation = client(
      async () =>
        new Response(new TextEncoder().encode('{"secret":"too-large"}'), {
          headers: { "Content-Type": "application/json" },
        }),
      { maximumResponseBytes: 8 },
    ).request(context, {
      method: "GET",
      url: "https://api.provider.example/items",
    });

    await expect(operation).rejects.toMatchObject({
      failure: { classification: "transient", retryable: true },
    });
  });

  it("times out stalled reads and treats possible writes as ambiguous", async () => {
    const stalled: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new TypeError("test fetch requires an abort signal");
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    await expect(
      client(stalled, { timeoutMilliseconds: 5 }).request(context, {
        method: "GET",
        url: "https://api.provider.example/status",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "timeout", retryable: true },
    });
    await expect(
      client(stalled, { timeoutMilliseconds: 5 }).request(context, {
        method: "POST",
        sideEffectPossible: true,
        url: "https://api.provider.example/publish",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
    });
  });

  it("keeps the timeout active while streaming the response body", async () => {
    const slowBody: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new TypeError("test fetch requires an abort signal");
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    await expect(
      client(slowBody, { timeoutMilliseconds: 5 }).request(context, {
        method: "GET",
        url: "https://api.provider.example/slow-body",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "timeout", retryable: true },
    });
  });

  it("rejects untrusted, credentialed, and non-HTTPS URLs before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = client(fetcher);
    for (const url of [
      "https://attacker.example/items",
      "https://user:password@api.provider.example/items",
      "http://api.provider.example/items",
      "https://api.provider.example/items#fragment",
    ]) {
      await expect(provider.request(context, { method: "GET", url })).rejects.toThrow(
        "outside the allowed origins",
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refines error classification from a bounded parsed body without leaking it", async () => {
    const response = json(
      {
        error: {
          errors: [
            {
              message: "token=must-not-leak https://private.example/x",
              reason: "quotaExceeded",
            },
          ],
        },
      },
      { status: 403 },
    );
    const classifyErrorBody = vi.fn((status: number, body: unknown) => {
      expect(status).toBe(403);
      expect(body).toMatchObject({
        error: { errors: [{ reason: "quotaExceeded" }] },
      });
      return { code: "provider_quota_exceeded", quotaExceeded: true };
    });

    const error = await client(async () => response)
      .request(context, {
        classifyErrorBody,
        method: "POST",
        sideEffectPossible: true,
        url: "https://api.provider.example/publish",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error).toMatchObject({
      failure: {
        classification: "quota",
        code: "provider_quota_exceeded",
        retryable: false,
      },
    });
    expect(JSON.stringify(error)).not.toMatch(/must-not-leak|private\.example/);
    expect(classifyErrorBody).toHaveBeenCalledOnce();
  });

  it("keeps status classification when the error body is absent or unusable", async () => {
    const classifyErrorBody = vi.fn(() => undefined);
    await expect(
      client(async () => new Response("not json", { status: 403 })).request(context, {
        classifyErrorBody,
        method: "GET",
        url: "https://api.provider.example/status",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "auth", code: "provider_http_403" },
    });
    expect(classifyErrorBody).toHaveBeenCalledOnce();

    const throwing = vi.fn(() => {
      throw new Error("sanitizer bug");
    });
    await expect(
      client(async () => json({ error: "denied" }, { status: 403 })).request(context, {
        classifyErrorBody: throwing,
        method: "GET",
        url: "https://api.provider.example/status",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "auth", code: "provider_http_403" },
    });
  });
});
