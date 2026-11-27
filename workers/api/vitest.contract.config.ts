import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    coverage: {
      enabled: true,
      provider: "istanbul",
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 55,
        lines: 50,
      },
    },
    fsModuleCache: true,
    setupFiles: ["../../scripts/lib/vitest-offline-collector.ts"],
    environment: "node",
    include: ["test/**/*.node.test.ts"],
  },
});
