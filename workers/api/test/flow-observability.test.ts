import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  flowGraph,
  flowExplorerEnabled,
  pendingSpans,
  trackPendingSpan,
  exportOtlpSpan,
} from "../src/flow-observability";
import type { ApiWorkerEnv } from "../src/env";

const testEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "test",
  APP_URL: "http://localhost:3000",
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

describe("pending span pruning", () => {
  const span = (name: string) => ({
    attributes: {},
    name,
    service: "api",
    startTimeMs: Date.now(),
    traceId: "trace-prune",
  });

  afterEach(() => {
    pendingSpans.clear();
    vi.useRealTimers();
  });

  it("expires spans abandoned past their TTL instead of leaking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    trackPendingSpan("run-abandoned", span("abandoned"));
    expect(pendingSpans.has("run-abandoned")).toBe(true);

    // An aborted flow never calls finishRun; once the TTL lapses the next
    // tracked insert evicts the stale entry rather than accumulating it.
    vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
    trackPendingSpan("run-live", span("live"));
    expect(pendingSpans.has("run-abandoned")).toBe(false);
    expect(pendingSpans.has("run-live")).toBe(true);
    expect(pendingSpans.size).toBe(1);
  });

  it("caps pending spans by evicting the oldest entries first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 300; index += 1) {
      trackPendingSpan(`span-${index}`, span(`span-${index}`));
    }
    expect(pendingSpans.size).toBe(256);
    expect(pendingSpans.has("span-0")).toBe(false);
    expect(pendingSpans.has("span-43")).toBe(false);
    expect(pendingSpans.has("span-44")).toBe(true);
    expect(pendingSpans.has("span-299")).toBe(true);
  });
});
