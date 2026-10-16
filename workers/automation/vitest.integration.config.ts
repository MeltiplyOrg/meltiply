import { defineConfig } from "vite-plus";

// These suites share seeded ownership scopes and the global outbox relay.
// Serialize files so another fixture cannot change quota or claim events while
// a consumer-visible invariant is being exercised against PostgreSQL.
export default defineConfig({
  test: {
    // Keep mock call history until a suite explicitly clears it, preserving
    // pre-migration behavior instead of adopting Vitest 5's automatic reset.
    clearMocks: false,
    setupFiles: ["../../scripts/lib/vitest-offline-collector.ts"],
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 20_000,
  },
});
