import { Effect } from "effect";
import { afterEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import * as api from "./api";

function requestAt(fetchMock: Mock, index: number): Request {
  const input = fetchMock.mock.calls[index]?.[0];
  return input instanceof Request ? input : new Request(String(input));
}

/**
 * Resolves the effective credentials mode of one recorded fetch call whether
 * the client forwarded a `Request` object or a URL plus init.
 */
function credentialsAt(fetchMock: Mock, index: number): RequestCredentials | undefined {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  return init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
}

/**
 * Resolves one header from a recorded fetch call, merging `Request` headers
 * with any `init.headers` override so assertions hold regardless of which side
 * of the call carries the header.
 */
function headerAt(fetchMock: Mock, index: number, name: string): string | null {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers.get(name);
}

describe("API URL helpers", () => {
  it("defaults to the local backend origin", () => {
    expect(api.apiUrl("/assets", {})).toBe("http://localhost:8787/api/v1/assets");
  });

  it("normalizes configured backend origins and paths", () => {
    const env = {
      API_BASE_URL: "https://api.example.com/",
    };

    expect(api.apiUrl("calendar", env)).toBe("https://api.example.com/api/v1/calendar");
  });

  it("does not double-prefix paths that already include the API version", () => {
    expect(api.apiUrl("/api/v1/assets", {})).toBe("http://localhost:8787/api/v1/assets");
  });

  it("normalizes paths missing a leading slash", () => {
    expect(api.apiUrl("distributions", {})).toBe("http://localhost:8787/api/v1/distributions");
  });

  it("rejects empty and whitespace-only paths", () => {
    expect(() => api.apiUrl("", {})).toThrow("API path is required");
    expect(() => api.apiUrl("   ", {})).toThrow("API path is required");
  });

  it("rejects absolute API paths so callers cannot bypass the configured backend", () => {
    expect(() => api.apiUrl("https://api.example.com/assets", {})).toThrow("relative API path");
  });
});

describe("generated API client adapters", () => {
  afterEach(() => {
    vi.doUnmock("@meltiply/contracts/client");
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves the normative error envelope, request ID, and retry delay", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            details: [{ code: "quota", message: "Try later" }],
            message: "Distribution quota exceeded",
            request_id: "req_test_123",
            retryable: true,
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "retry-after": "17",
          },
          status: 429,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await Effect.runPromise(api.listPosts(null)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(api.ApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      message: "Distribution quota exceeded",
      requestId: "req_test_123",
      retryAfterSeconds: 17,
      retryable: true,
      status: 429,
    });
    const request = requestAt(fetchMock, 0);
    expect(request.headers.get("Authorization")).toBeNull();
    expect(request.headers.get("X-Workspace-ID")).toBeNull();
    expect(credentialsAt(fetchMock, 0)).toBe("same-origin");
  });

  it("uses a safe fallback for malformed or future error payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ future_error: "new shape" }), {
        headers: { "content-type": "application/json", "x-request-id": "req_header" },
        status: 503,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await Effect.runPromise(api.getCurrentUser(null)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "unknown_error",
      requestId: "req_header",
      retryable: true,
      status: 503,
    });
  });

  it("requests an OAuth URL as authenticated JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ authorization_url: "https://provider.example/authorize" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(Effect.runPromise(api.startPlatformOAuth(null, "threads"))).resolves.toEqual({
      authorization_url: "https://provider.example/authorize",
    });
    const request = requestAt(fetchMock, 0);
    expect(request.url).toBe("http://localhost:8787/api/v1/platforms/threads/connect");
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.headers.get("Authorization")).toBeNull();
  });

  it("sends X-Workspace-ID only when a workspace is selected", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(api.listPosts("ws-123"));
    await Effect.runPromise(api.listPosts(null));
    await Effect.runPromise(api.listPosts("   "));

    expect(requestAt(fetchMock, 0).headers.get("X-Workspace-ID")).toBe("ws-123");
    expect(requestAt(fetchMock, 1).headers.get("X-Workspace-ID")).toBeNull();
    expect(requestAt(fetchMock, 2).headers.get("X-Workspace-ID")).toBeNull();
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(credentialsAt(fetchMock, index)).toBe("same-origin");
      expect(headerAt(fetchMock, index, "Authorization")).toBeNull();
    }
  });

  it("sends the session JWT as a bearer credential without cookies", async () => {
    const storageUrl = "https://objects.example/original.png";
    const originalBytes = new Uint8Array([0, 127, 255]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: { expiresAt: new Date().toISOString(), id: "session-1", userId: "user-1" },
            user: { email: "user@example.com", id: "user-1" },
          }),
          {
            headers: { "content-type": "application/json", "set-auth-jwt": "session-jwt-1" },
            status: 200,
          },
        ),
      )
      .mockImplementation((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/download-url"))
          return Promise.resolve(Response.json({ url: storageUrl }));
        if (url === storageUrl) return Promise.resolve(new Response(originalBytes));
        return Promise.resolve(Response.json({}));
      });
    vi.stubGlobal("fetch", fetchMock);

    // Fresh module instances so the module-local bearer token holder starts
    // empty; the get-session lifecycle response seeds it before the API calls.
    vi.resetModules();
    const { authClient } = await import("./auth-client");
    const isolatedApi = await import("./api");

    await authClient.getSession();
    await Effect.runPromise(isolatedApi.getCurrentUser(null));
    await Effect.runPromise(isolatedApi.listPosts("ws-123"));
    const blob = await Effect.runPromise(isolatedApi.getAssetBlob("ws-123", "asset-1"));
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(originalBytes);

    // The auth lifecycle request keeps the session cookie; API requests carry
    // only the bearer JWT and must not send cookies.
    expect(credentialsAt(fetchMock, 0)).toBe("include");
    expect(headerAt(fetchMock, 1, "Authorization")).toBe("Bearer session-jwt-1");
    expect(credentialsAt(fetchMock, 1)).toBe("same-origin");
    expect(headerAt(fetchMock, 2, "Authorization")).toBe("Bearer session-jwt-1");
    expect(headerAt(fetchMock, 2, "X-Workspace-ID")).toBe("ws-123");
    expect(credentialsAt(fetchMock, 2)).toBe("omit");
    expect(headerAt(fetchMock, 3, "Authorization")).toBe("Bearer session-jwt-1");
    expect(headerAt(fetchMock, 3, "X-Workspace-ID")).toBe("ws-123");
    expect(headerAt(fetchMock, 4, "Authorization")).toBeNull();
    expect(headerAt(fetchMock, 4, "X-Workspace-ID")).toBeNull();
    expect(credentialsAt(fetchMock, 4)).toBe("omit");
  });
});
