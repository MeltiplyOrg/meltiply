import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  measurePublicRoute,
  percentile,
  publicRouteBaselineOptions,
} from "./measure-public-routes.mjs";

describe("public route baseline", () => {
  it("uses nearest-rank percentiles", () => {
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
    assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  });

  it("validates the local measurement inputs", () => {
    assert.deepEqual(
      publicRouteBaselineOptions({
        MELTIPLY_API_BASE_URL: "https://api.example.test",
        MELTIPLY_ROUTE_BASELINE_SAMPLES: "25",
      }),
      { baseUrl: new URL("https://api.example.test"), samples: 25 },
    );
    assert.throws(
      () =>
        publicRouteBaselineOptions({
          MELTIPLY_API_BASE_URL: "file:///tmp/api",
        }),
      /must use http or https/,
    );
    assert.throws(
      () =>
        publicRouteBaselineOptions({
          MELTIPLY_ROUTE_BASELINE_SAMPLES: "0",
        }),
      /must be an integer between 1 and 10000/,
    );
  });

  it("records latency percentiles and sequential throughput after warmup", async () => {
    const times = [0, 1, 3, 4, 8, 10];
    let requests = 0;
    const report = await measurePublicRoute({
      baseUrl: new URL("http://127.0.0.1:8787"),
      fetchImplementation: async () => {
        requests += 1;
        return {
          arrayBuffer: async () => new ArrayBuffer(0),
          ok: true,
          status: 200,
        };
      },
      now: () => times.shift(),
      route: "/api/v1/health",
      samples: 2,
    });

    assert.equal(requests, 3);
    assert.deepEqual(report, {
      p50_ms: 2,
      p95_ms: 4,
      p99_ms: 4,
      route: "/api/v1/health",
      samples: 2,
      throughput_rps: 200,
    });
  });
});
