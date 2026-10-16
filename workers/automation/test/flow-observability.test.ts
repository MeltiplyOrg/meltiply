import { describe, expect, it } from "vite-plus/test";

import { flowDatabaseAvailable, flowExplorerEnabled } from "../src/flow-observability";

describe("automation flow observability gating", () => {
  it("enables the explorer only in local and test environments", () => {
    expect(flowExplorerEnabled({ ENVIRONMENT: "local", VERSION: "x" })).toBe(true);
    expect(flowExplorerEnabled({ ENVIRONMENT: "test", VERSION: "x" })).toBe(true);
    expect(flowExplorerEnabled({ ENVIRONMENT: "staging", VERSION: "x" })).toBe(false);
    expect(flowExplorerEnabled({ ENVIRONMENT: "production", VERSION: "x" })).toBe(false);
  });

  it("requires a usable system Hyperdrive binding", () => {
    expect(
      flowDatabaseAvailable({
        DB_SYSTEM: {
          connectionString: "postgres://meltiply_system:secret@db/meltiply",
        } as Hyperdrive,
        ENVIRONMENT: "test",
        VERSION: "x",
      }),
    ).toBe(true);
    expect(
      flowDatabaseAvailable({
        DB_SYSTEM: {} as Hyperdrive,
        ENVIRONMENT: "test",
        VERSION: "x",
      }),
    ).toBe(false);
    expect(flowDatabaseAvailable({ ENVIRONMENT: "test", VERSION: "x" })).toBe(false);
  });
});
