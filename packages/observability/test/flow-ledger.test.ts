import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createFlowLedgerRecorder,
  flowDatabaseAvailable,
  flowExplorerEnabled,
  flowNodeTypeFor,
} from "../src";

describe("flow ledger", () => {
  it("gates explorer recording strictly to local and test environments", () => {
    expect(flowExplorerEnabled({ ENVIRONMENT: "local" })).toBe(true);
    expect(flowExplorerEnabled({ ENVIRONMENT: "test" })).toBe(true);
    expect(flowExplorerEnabled({ ENVIRONMENT: "staging" })).toBe(false);
    expect(flowExplorerEnabled({ ENVIRONMENT: "production" })).toBe(false);
  });

  it("checks database binding availability from connectionString", () => {
    expect(flowDatabaseAvailable({})).toBe(false);
    expect(flowDatabaseAvailable({ DB_SYSTEM: {} })).toBe(false);
    expect(flowDatabaseAvailable({ DB_SYSTEM: { connectionString: "postgres://local" } })).toBe(
      true,
    );
  });

  it("maps known node keys and falls back to service", () => {
    expect(flowNodeTypeFor("api")).toBe("api");
    expect(flowNodeTypeFor("providers")).toBe("provider");
    expect(flowNodeTypeFor("unknown-node")).toBe("service");
  });

  it("records runs, steps, and swallows database errors without throwing", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const recorder = createFlowLedgerRecorder({
      env: { ENVIRONMENT: "test", VERSION: "1.0.0" },
      runTransaction: async (operation) =>
        Effect.runPromise(
          operation({
            query: (sql, values) => {
              queries.push({ sql, values });
              return Effect.succeed({ rows: [{ id: "row-1" } as never] });
            },
          }),
        ),
      service: "automation",
    });

    const runId = await recorder.startRunForRequest({
      entrypoint: "queue:publish",
      requestId: "req-1",
      traceId: "trace-1",
    });
    expect(runId).toBe("row-1");

    const stepId = await recorder.recordStep({
      nodeKey: "queue",
      operation: "consume",
      runId: "row-1",
      service: "automation",
      traceId: "trace-1",
    });
    expect(stepId).toBe("row-1");

    await recorder.finishStep("row-1", { status: "succeeded" });
    await recorder.finishRun("row-1", { status: "succeeded" });
    expect(queries).toHaveLength(4);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createFlowLedgerRecorder({
      env: { ENVIRONMENT: "test", VERSION: "1.0.0" },
      runTransaction: async () => {
        throw new Error("db unavailable");
      },
      service: "automation",
    });
    expect(
      await failing.startRunForRequest({
        entrypoint: "queue:publish",
        requestId: "req-2",
        traceId: "trace-2",
      }),
    ).toBeNull();
    errorSpy.mockRestore();
  });
});
