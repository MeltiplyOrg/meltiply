// @vitest-environment jsdom

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

const firstJwt = "session-jwt-1";
const refreshedJwt = "session-jwt-2";

function sessionResponse(jwt: string): Response {
  return new Response(
    JSON.stringify({
      session: { expiresAt: "2099-07-18T16:00:00.000Z", id: "session-1", userId: "user-1" },
      user: { email: "user@example.com", id: "user-1" },
    }),
    {
      headers: { "content-type": "application/json", "set-auth-jwt": jwt },
      status: 200,
    },
  );
}

function okJson(): Response {
  return new Response(JSON.stringify({}), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function credentialsAt(fetchMock: Mock, index: number): RequestCredentials | undefined {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  return init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
}

function headerAt(fetchMock: Mock, index: number, name: string): string | null {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers.get(name);
}

async function importClients() {
  vi.resetModules();
  const { authClient } = await import("./auth-client");
  const api = await import("./api");
  return { api, authClient };
}

describe("Better Auth JWT lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("stores the get-session JWT as the bearer credential for API requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse(firstJwt))
      .mockResolvedValue(okJson());
    vi.stubGlobal("fetch", fetchMock);
    const { api, authClient } = await importClients();

    const session = await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));

    expect(session?.user.email).toBe("user@example.com");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8787/api/auth/get-session");
    expect(credentialsAt(fetchMock, 0)).toBe("include");
    expect(headerAt(fetchMock, 1, "Authorization")).toBe(`Bearer ${firstJwt}`);
    expect(credentialsAt(fetchMock, 1)).toBe("same-origin");
  });

  it("forwards the refreshed JWT after a later session refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse(firstJwt))
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(sessionResponse(refreshedJwt))
      .mockResolvedValue(okJson());
    vi.stubGlobal("fetch", fetchMock);
    const { api, authClient } = await importClients();

    await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));
    await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));

    expect(headerAt(fetchMock, 1, "Authorization")).toBe(`Bearer ${firstJwt}`);
    expect(headerAt(fetchMock, 3, "Authorization")).toBe(`Bearer ${refreshedJwt}`);
    expect(credentialsAt(fetchMock, 3)).toBe("same-origin");
  });

  it("clears the bearer credential when sign-out fails server-side", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse(firstJwt))
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(okJson());
    vi.stubGlobal("fetch", fetchMock);
    const { api, authClient } = await importClients();

    await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));
    expect(headerAt(fetchMock, 1, "Authorization")).toBe(`Bearer ${firstJwt}`);

    await authClient.signOut().catch(() => undefined);
    await Effect.runPromise(api.getCurrentUser(null));

    expect(headerAt(fetchMock, 3, "Authorization")).toBeNull();
    expect(credentialsAt(fetchMock, 3)).toBe("same-origin");
  });

  it("clears the bearer credential when the sign-out request rejects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse(firstJwt))
      .mockResolvedValueOnce(okJson())
      .mockRejectedValueOnce(new TypeError("network failure"))
      .mockResolvedValue(okJson());
    vi.stubGlobal("fetch", fetchMock);
    const { api, authClient } = await importClients();

    await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));
    expect(headerAt(fetchMock, 1, "Authorization")).toBe(`Bearer ${firstJwt}`);

    await authClient.signOut().catch(() => undefined);
    await Effect.runPromise(api.getCurrentUser(null));

    expect(headerAt(fetchMock, 3, "Authorization")).toBeNull();
    expect(credentialsAt(fetchMock, 3)).toBe("same-origin");
  });

  it("never persists the bearer credential to Web Storage", async () => {
    const storageSpies = [
      vi.spyOn(Storage.prototype, "getItem"),
      vi.spyOn(Storage.prototype, "setItem"),
      vi.spyOn(Storage.prototype, "removeItem"),
      vi.spyOn(Storage.prototype, "clear"),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionResponse(firstJwt))
      .mockResolvedValueOnce(okJson())
      .mockResolvedValue(okJson());
    vi.stubGlobal("fetch", fetchMock);
    const { api, authClient } = await importClients();

    await authClient.getSession();
    await Effect.runPromise(api.getCurrentUser(null));
    await authClient.signOut().catch(() => undefined);
    await Effect.runPromise(api.getCurrentUser(null));

    expect(headerAt(fetchMock, 1, "Authorization")).toBe(`Bearer ${firstJwt}`);
    expect(headerAt(fetchMock, 3, "Authorization")).toBeNull();
    for (const spy of storageSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
