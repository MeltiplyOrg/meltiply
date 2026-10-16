import { describe, expect, it } from "vite-plus/test";

/**
 * Runtime contract for `ProviderHttpClient` as executed on the Workers runtime.
 *
 * The provider unit tests inject a stub fetch and run on Node/undici, which
 * accepts `redirect: "error"`. The Workers runtime implements only "follow" and
 * "manual" and throws `TypeError: Invalid redirect value` for "error" — before a
 * socket is opened, so every provider call failed as a retryable
 * `provider_http_request_failed` while all unit tests stayed green. This test
 * runs inside workerd and pins the runtime fact that caused it; the paired
 * assertions in `packages/providers/test/http.test.ts` pin that the client sends
 * `redirect: "manual"` and denies 3xx responses explicitly.
 *
 * No network is touched: the runtime rejects the option synchronously.
 */
describe("provider HTTP runtime contract", () => {
  it("rejects redirect: 'error' before any socket is opened", async () => {
    await expect(fetch("https://127.0.0.1:9/", { redirect: "error" })).rejects.toThrow(
      /Invalid redirect value/,
    );
  });
});
