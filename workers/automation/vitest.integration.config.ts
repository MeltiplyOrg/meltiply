import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    fsModuleCache: true,
    setupFiles: ["../../scripts/lib/vitest-offline-collector.ts"],
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 20_000,
  },
});
