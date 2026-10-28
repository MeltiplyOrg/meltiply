// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  DeviceAuthorizationError,
  normalizeDeviceUserCode,
  verifyDeviceAuthorization,
} from "./device-authorization";

/**
 * Builds a JSON HTTP response for the fake auth transport.
 *
 * @param body - JSON-serializable response body.
 * @param status - HTTP status code.
 * @param headers - Additional response headers such as `Retry-After`.
 * @returns Response object observed by the device-authorization client.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

/**
 * Installs one fetch implementation and exposes the calls it received.
 *
 * @param implementation - Response factory for each request URL.
 * @returns The fetch mock and a mutable request log.
 */
function installFetch(
  implementation: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const requests: { init: RequestInit | undefined; url: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ init, url });
    return implementation(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

/**
 * Reads a request body recorded by the fetch mock as a JSON object.
 *
 * @param init - Recorded request init.
 * @returns Parsed JSON body.
 */
function jsonBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("device authorization code normalization", () => {
  it("accepts the code exactly as a terminal displays it", () => {
    expect(normalizeDeviceUserCode(" ABCD-2345 ")).toBe("ABCD2345");
    expect(normalizeDeviceUserCode("abcd 2345")).toBe("ABCD2345");
    expect(normalizeDeviceUserCode("")).toBe("");
  });
});

describe("device authorization transport", () => {
  it("verifies a prefilled code through the cookie-authenticated auth endpoint", async () => {
    const { requests } = installFetch(() =>
      jsonResponse({
        client_id: "melti-cli",
        scope: "",
        status: "pending",
        user_code: "ABCD2345",
      }),
    );

    const review = await verifyDeviceAuthorization("ABCD2345");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8787/api/auth/device?user_code=ABCD2345");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.credentials).toBe("include");
    expect(review).toEqual({
      client_id: "melti-cli",
      scope: "",
      status: "pending",
      user_code: "ABCD2345",
    });
  });

  it("keeps the device code out of the URL and sends it only in the approval body", async () => {
    const { requests } = installFetch(() => jsonResponse({ success: true }));

    await approveDeviceAuthorization("ABCD2345");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://localhost:8787/api/auth/device/approve");
    expect(requests[0]?.url).not.toContain("ABCD2345");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.credentials).toBe("include");
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(jsonBody(requests[0]?.init)).toEqual({ userCode: "ABCD2345" });
  });

  it("denies the request by user code without granting anything", async () => {
    const { requests } = installFetch(() => jsonResponse({ success: true }));

    await denyDeviceAuthorization("ABCD2345");

    expect(requests[0]?.url).toBe("http://localhost:8787/api/auth/device/deny");
    expect(jsonBody(requests[0]?.init)).toEqual({ userCode: "ABCD2345" });
  });

  it("surfaces the plugin's RFC-style error code and description", async () => {
    installFetch(() =>
      jsonResponse({ error: "expired_token", error_description: "User code has expired" }, 400),
    );

    await expect(verifyDeviceAuthorization("ABCD2345")).rejects.toMatchObject({
      code: "expired_token",
      description: "User code has expired",
      status: 400,
    });
  });

  it("surfaces a distributed rate-limit response with its Retry-After hint", async () => {
    installFetch(() =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            details: [],
            issues: [],
            message: "Too many authentication attempts. Retry later.",
            request_id: "req-1",
            retryable: true,
          },
        },
        429,
        { "Retry-After": "12" },
      ),
    );

    await expect(approveDeviceAuthorization("ABCD2345")).rejects.toMatchObject({
      code: "rate_limited",
      description: "Too many authentication attempts. Retry later.",
      retryAfterSeconds: 12,
      status: 429,
    });
  });

  it("rejects an unexpected success body instead of claiming consent", async () => {
    installFetch(() => jsonResponse({ success: false }));

    await expect(approveDeviceAuthorization("ABCD2345")).rejects.toBeInstanceOf(
      DeviceAuthorizationError,
    );
  });

  it("rejects an unreadable verification status", async () => {
    installFetch(() => jsonResponse({ status: "maybe", user_code: "ABCD2345" }));

    await expect(verifyDeviceAuthorization("ABCD2345")).rejects.toMatchObject({
      code: "unknown",
    });
  });
});
