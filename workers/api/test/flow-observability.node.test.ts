import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApiWorkerEnv } from "../src/env";
import {
  exportOtlpSpan,
  flowExplorerEnabled,
  flowGraph,
  pendingSpans,
  trackPendingSpan,
} from "../src/flow-observability";

const testEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

describe("flowExplorerEnabled", () => {
  it.each([
    ["local", true],
    ["test", true],
    ["staging", false],
    ["preview", false],
    ["production", false],
  ] as const)("%s environment", (environment, enabled) => {
    expect(flowExplorerEnabled({ ...testEnv, ENVIRONMENT: environment })).toEqual(enabled);
  });
});

describe("flowGraph", () => {
  it("connects every edge between declared nodes", () => {
    const graph = flowGraph();
    const nodeKeys = new Set(graph.nodes.map((node) => node.key));

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((edge) => nodeKeys.has(edge.from) && nodeKeys.has(edge.to))).toEqual(
      true,
    );
  });
});

describe("exportOtlpSpan", () => {
  it("resolves without throwing when the collector is offline", async () => {
    await expect(
      exportOtlpSpan(
        { ENVIRONMENT: "test" },
        {
          attributes: { test: true },
          endTimeMs: 1_700_000_000_010,
          name: "test.operation",
          service: "api-worker",
          startTimeMs: 1_700_000_000_000,
          status: "ok",
          traceId: "test-trace-id-12345",
        },
      ),
    ).resolves.toEqual(undefined);
  });
});

describe("trackPendingSpan", () => {
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

  it("prunes spans whose TTL has elapsed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    trackPendingSpan("run-abandoned", span("abandoned"));

    vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
    trackPendingSpan("run-live", span("live"));

    expect([...pendingSpans.keys()]).toEqual(["run-live"]);
  });

  it("evicts the oldest entries once the 256-span cap is exceeded", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 300; index += 1) {
      trackPendingSpan(`span-${index}`, span(`span-${index}`));
    }

    expect(pendingSpans.size).toEqual(256);
    expect(pendingSpans.has("span-0")).toEqual(false);
    expect(pendingSpans.has("span-43")).toEqual(false);
    expect(pendingSpans.has("span-44")).toEqual(true);
    expect(pendingSpans.has("span-299")).toEqual(true);
  });
});
