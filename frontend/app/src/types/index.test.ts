import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { distributionStatuses } from "./index";

const typesModulePath = fileURLToPath(new URL("./index.ts", import.meta.url));

describe("frontend data-layer types", () => {
  it("defines queue-oriented distribution statuses", () => {
    expect(distributionStatuses).toEqual([
      "scheduled",
      "queued",
      "processing",
      "awaiting_provider",
      "published",
      "failed",
      "cancel_requested",
      "cancelled",
      "needs_reconciliation",
    ]);
  });

  it("does not reference legacy worker-only distribution fields", () => {
    const source = readFileSync(typesModulePath, "utf8");

    expect(source).not.toMatch(/external[_-]?job[_-]?id/i);
  });
});
