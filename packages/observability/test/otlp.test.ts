import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { exportOtlpSpan } from "../src/otlp";
import { otlpTracePayload } from "../src/otlp-payload";

const span = {
  endTimeMs: 1000,
  name: "test-span",
  service: "api",
  startTimeMs: 500,
  status: "ok",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
} as const;

function collector(answer = () => Promise.resolve(new Response("ok"))) {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requests.push([url, init]);
    return answer();
  });
  return requests;
}

beforeAll(async () => {
  collector();
  await exportOtlpSpan({ ENVIRONMENT: "test" }, span);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportOtlpSpan", () => {
  it.each(["local", "test"])("a span in the %s environment", async (ENVIRONMENT) => {
    const requests = collector();

    await exportOtlpSpan({ ENVIRONMENT }, span);

    expect(requests).toEqual([
      [
        "http://127.0.0.1:4318/v1/traces",
        {
          body: JSON.stringify(otlpTracePayload(ENVIRONMENT, span)),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      ],
    ]);
  });

  it("a span in production", async () => {
    const requests = collector();

    await exportOtlpSpan({ ENVIRONMENT: "production" }, span);

    expect(requests).toEqual([]);
  });

  it("a collector that is down", async () => {
    collector(() => Promise.reject(new TypeError("offline")));

    await expect(exportOtlpSpan({ ENVIRONMENT: "test" }, span)).resolves.toEqual(undefined);
  });
});
