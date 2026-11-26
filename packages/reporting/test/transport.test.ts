import { describe, expect, it } from "vite-plus/test";

import { createPostHogTransport } from "../src/transport";

const destination = {
  captureUrl: "https://us.i.posthog.com/i/v0/e/",
  projectToken: "phc_acceptanceTokenValue123",
};

const usageEvent = {
  distinctId: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
  event: "meltiply_usage_daily",
  eventUuid: "9c2f1e88-1f77-4f4b-8f11-2a5b7c1d0e22",
  properties: { app_version: "1.0.0-target.0", schema_version: 1 },
  timestamp: "2026-01-02T00:00:00.000Z",
};

function setup(answer: (signal: AbortSignal) => Promise<Response>, timeoutMilliseconds?: number) {
  const requests: unknown[] = [];
  const transport = createPostHogTransport({
    destination,
    fetch: (url, init) => {
      requests.push({
        url,
        method: init?.method,
        headers: init?.headers,
        redirect: init?.redirect,
        body: JSON.parse(String(init?.body)),
      });
      return answer(init!.signal!);
    },
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
  return { transport, requests };
}

const status = (code: number) => () => Promise.resolve(new Response(null, { status: code }));

describe("createPostHogTransport", () => {
  describe("capture", () => {
    it("an accepted event", async () => {
      const { transport, requests } = setup(status(200));

      const result = await transport.capture(usageEvent);

      expect(result).toEqual({ ok: true });
      expect(requests).toEqual([
        {
          url: "https://us.i.posthog.com/i/v0/e/",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          redirect: "manual",
          body: {
            api_key: "phc_acceptanceTokenValue123",
            distinct_id: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
            event: "meltiply_usage_daily",
            properties: {
              app_version: "1.0.0-target.0",
              schema_version: 1,
              $geoip_disable: true,
              $process_person_profile: false,
            },
            timestamp: "2026-01-02T00:00:00.000Z",
            uuid: "9c2f1e88-1f77-4f4b-8f11-2a5b7c1d0e22",
          },
        },
      ]);
    });

    it.each([
      ["a redirect", 302, false],
      ["a rejected token", 401, false],
      ["a rate limit", 429, true],
      ["a server error", 500, true],
    ])("%s", async (_example, code, retryable) => {
      const { transport } = setup(status(code));

      expect(await transport.capture(usageEvent)).toEqual({
        errorCode: `capture_status_${code}`,
        ok: false,
        retryable,
      });
    });

    it("a destination that never answers", async () => {
      const { transport } = setup(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
        1,
      );

      expect(await transport.capture(usageEvent)).toEqual({
        errorCode: "capture_timeout",
        ok: false,
        retryable: true,
      });
    });

    it("a refused connection", async () => {
      const { transport } = setup(() => Promise.reject(new TypeError("fetch failed")));

      expect(await transport.capture(usageEvent)).toEqual({
        errorCode: "capture_transport_error",
        ok: false,
        retryable: true,
      });
    });
  });
});
