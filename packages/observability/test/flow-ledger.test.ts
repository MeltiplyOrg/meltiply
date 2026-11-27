import { Effect } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  createFlowLedgerRecorder,
  flowDatabaseAvailable,
  flowExplorerEnabled,
  flowNodeTypeFor,
  type FlowLedgerClient,
  type FlowLedgerEnvironment,
} from "../src/flow-ledger";

class FakeLedger {
  readonly writes: { sql: string; values: readonly unknown[] | undefined }[] = [];
  rows: Record<string, unknown>[] = [{ id: "row-1" }];
  failure: Error | undefined;

  readonly client: FlowLedgerClient = {
    query: <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      if (this.failure) return Effect.fail(this.failure);
      this.writes.push({ sql, values });
      return Effect.succeed({ rows: this.rows as Row[] });
    },
  };
}

function setup(env: FlowLedgerEnvironment = { ENVIRONMENT: "test", VERSION: "1.0.0" }) {
  const ledger = new FakeLedger();
  const recorder = createFlowLedgerRecorder({
    env,
    runTransaction: (operation) => Effect.runPromise(operation(ledger.client)),
    service: "automation",
  });
  return { ledger, recorder };
}

const run = { entrypoint: "queue:publish", requestId: "req-1", traceId: "trace-1" };
const step = {
  nodeKey: "queue",
  operation: "consume",
  runId: "run-1",
  service: "automation",
  traceId: "trace-1",
};
const everyStepField = {
  ...step,
  attempt: 3,
  jobId: "job-1",
  metadata: { size: 1 },
  orgId: "org-1",
  parentStepId: "step-0",
  provider: "threads",
  queueName: "publish",
  requestId: "req-1",
  workflowId: "wf-1",
};

function logged() {
  const lines: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
  return lines;
}

const failureLine = (environment: string, version: string) =>
  expect.objectContaining({
    context: {
      error_code: "flow_ledger_write_failed",
      event: "flow_ledger_write_failed",
      outcome: "internal_error",
      retry_class: "none",
    },
    environment,
    error: expect.objectContaining({ message: "db unavailable", name: "Error" }),
    service: "automation",
    trace_id: "flow-observability",
    version,
  });

beforeAll(async () => {
  logged();
  const { ledger, recorder } = setup();
  await recorder.startRunForRequest(run);
  ledger.failure = new Error("db unavailable");
  await recorder.startRunForRequest(run);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("flowNodeTypeFor", () => {
  it.each([
    ["api", "api"],
    ["providers", "provider"],
    ["unknown-node", "service"],
  ])("the %s node", (nodeKey, type) => {
    expect(flowNodeTypeFor(nodeKey)).toEqual(type);
  });
});

describe("flowExplorerEnabled", () => {
  it.each([
    ["local", true],
    ["test", true],
    ["staging", false],
    ["production", false],
  ])("the %s environment", (ENVIRONMENT, enabled) => {
    expect(flowExplorerEnabled({ ENVIRONMENT })).toEqual(enabled);
  });
});

describe("flowDatabaseAvailable", () => {
  it.each([
    ["no binding", {}, false],
    ["a binding with no connection string", { DB_SYSTEM: {} }, false],
    ["a connection string", { DB_SYSTEM: { connectionString: "postgres://local" } }, true],
  ])("%s", (_example, env, available) => {
    expect(flowDatabaseAvailable(env)).toEqual(available);
  });
});

describe("createFlowLedgerRecorder", () => {
  describe("startRunForRequest", () => {
    it("a request in a Workspace", async () => {
      const { ledger, recorder } = setup();

      expect(await recorder.startRunForRequest({ ...run, orgId: "org-1" })).toEqual("row-1");
      expect(ledger.writes).toEqual([
        {
          sql: expect.stringMatching(/^INSERT INTO flow_runs/),
          values: ["test", "trace-1", "req-1", "org-1", "queue:publish", {}],
        },
      ]);
    });

    it("a request with no Workspace and no environment", async () => {
      const { ledger, recorder } = setup({});

      await recorder.startRunForRequest(run);

      expect(ledger.writes.map((write) => write.values)).toEqual([
        ["unknown", "trace-1", "req-1", null, "queue:publish", {}],
      ]);
    });

    it("a request ID recorded for another Workspace", async () => {
      const { ledger, recorder } = setup();
      ledger.rows = [];

      expect(await recorder.startRunForRequest(run)).toEqual(null);
    });

    it("a ledger that is down", async () => {
      const lines = logged();
      const { ledger, recorder } = setup();
      ledger.failure = new Error("db unavailable");

      expect(await recorder.startRunForRequest(run)).toEqual(null);
      expect(lines).toEqual([failureLine("test", "1.0.0")]);
    });

    it("a ledger that is down with no environment", async () => {
      const lines = logged();
      const { ledger, recorder } = setup({});
      ledger.failure = new Error("db unavailable");

      await recorder.startRunForRequest(run);

      expect(lines).toEqual([failureLine("unknown", "unknown")]);
    });
  });

  describe("recordStep", () => {
    it("a step with every field", async () => {
      const { ledger, recorder } = setup();

      expect(await recorder.recordStep(everyStepField)).toEqual("row-1");
      expect(ledger.writes).toEqual([
        {
          sql: expect.stringMatching(/^INSERT INTO flow_steps/),
          values: [
            "run-1",
            "step-0",
            "org-1",
            "queue",
            "queue",
            "automation",
            "consume",
            3,
            "req-1",
            "trace-1",
            "job-1",
            "wf-1",
            "publish",
            "threads",
            { size: 1 },
          ],
        },
      ]);
    });

    it("a step with only required fields", async () => {
      const { ledger, recorder } = setup();

      await recorder.recordStep(step);

      expect(ledger.writes.map((write) => write.values)).toEqual([
        [
          "run-1",
          null,
          null,
          "queue",
          "queue",
          "automation",
          "consume",
          1,
          null,
          "trace-1",
          null,
          null,
          null,
          null,
          {},
        ],
      ]);
    });

    it("a step that returns no row", async () => {
      const { ledger, recorder } = setup();
      ledger.rows = [];

      expect(await recorder.recordStep(step)).toEqual(null);
    });

    it("a ledger that is down", async () => {
      const lines = logged();
      const { ledger, recorder } = setup();
      ledger.failure = new Error("db unavailable");

      expect(await recorder.recordStep(step)).toEqual(null);
      expect(lines).toEqual([failureLine("test", "1.0.0")]);
    });
  });

  describe.each([
    ["finishRun", "UPDATE flow_runs"],
    ["finishStep", "UPDATE flow_steps"],
  ] as const)("%s", (method, update) => {
    const written = (values: unknown[]) => [
      { sql: expect.stringMatching(new RegExp(`^${update}`)), values },
    ];

    it("a success", async () => {
      const { ledger, recorder } = setup();

      await recorder[method]("id-1", { status: "succeeded" });

      expect(ledger.writes).toEqual(written(["succeeded", null, null, "id-1"]));
    });

    it("a retryable failure", async () => {
      const { ledger, recorder } = setup();

      await recorder[method]("id-1", {
        errorCode: "provider_timeout",
        retryable: true,
        status: "failed",
      });

      expect(ledger.writes).toEqual(written(["failed", "provider_timeout", true, "id-1"]));
    });

    it("a ledger that is down", async () => {
      const lines = logged();
      const { ledger, recorder } = setup();
      ledger.failure = new Error("db unavailable");

      await recorder[method]("id-1", { status: "succeeded" });

      expect(lines).toEqual([failureLine("test", "1.0.0")]);
    });
  });
});
