import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Keep mock call history until a suite explicitly clears it, preserving
    // pre-migration behavior instead of adopting Vitest 5's automatic reset.
    clearMocks: false,
    setupFiles: ["../../scripts/lib/vitest-offline-collector.ts"],
    environment: "node",
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
