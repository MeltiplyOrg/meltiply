import { describe, expect, it } from "vite-plus/test";

import { flowGraph, flowExplorerEnabled, exportOtlpSpan } from "../src/flow-observability";
import type { ApiWorkerEnv } from "../src/env";

const testEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: "http://localhost:8787",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

describe("flow observability OTLP tracing", () => {
  it("gates trace exporter to local and test environments", () => {
    expect(flowExplorerEnabled({ ...testEnv, ENVIRONMENT: "local" })).toBe(true);
    expect(flowExplorerEnabled({ ...testEnv, ENVIRONMENT: "test" })).toBe(true);
    expect(flowExplorerEnabled({ ...testEnv, ENVIRONMENT: "staging" })).toBe(false);
    expect(flowExplorerEnabled({ ...testEnv, ENVIRONMENT: "preview" })).toBe(false);
  });

  it("builds static flow graph topology", async () => {
    const graph = flowGraph();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    const nodeKeys = new Set(graph.nodes.map((node) => node.key));
    for (const edge of graph.edges) {
      expect(nodeKeys.has(edge.from)).toBe(true);
      expect(nodeKeys.has(edge.to)).toBe(true);
    }
  });

  it("exports OTLP trace spans best-effort without throwing when collector is offline", async () => {
    await expect(
      exportOtlpSpan(
        { ENVIRONMENT: "test" },
        {
          attributes: { test: true },
          endTimeMs: Date.now() + 10,
          name: "test.operation",
          service: "api-worker",
          startTimeMs: Date.now(),
          status: "ok",
          traceId: "test-trace-id-12345",
        },
      ),
    ).resolves.not.toThrow();
  });
});
