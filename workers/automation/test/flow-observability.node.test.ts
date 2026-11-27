import { describe, expect, it } from "vite-plus/test";

import { flowDatabaseAvailable, flowExplorerEnabled } from "../src/flow-observability";

describe("flowExplorerEnabled", () => {
  it.each([
    ["local", true],
    ["test", true],
    ["staging", false],
    ["production", false],
  ] as const)("%s environment", (environment, enabled) => {
    expect(flowExplorerEnabled({ ENVIRONMENT: environment, VERSION: "x" })).toEqual(enabled);
  });
});

describe("flowDatabaseAvailable", () => {
  it.each([
    [
      "usable system Hyperdrive connectionString",
      { DB_SYSTEM: { connectionString: "postgres://meltiply_system:secret@db/meltiply" } },
      true,
    ],
    ["empty DB_SYSTEM binding", { DB_SYSTEM: {} }, false],
    ["missing DB_SYSTEM binding", {}, false],
  ])("%s", (_example, patch, available) => {
    expect(flowDatabaseAvailable({ ENVIRONMENT: "test", VERSION: "x", ...patch })).toEqual(
      available,
    );
  });
});
