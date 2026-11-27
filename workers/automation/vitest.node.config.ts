import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    coverage: {
      enabled: true,
      provider: "istanbul",
      thresholds: {
        statements: 55,
        branches: 40,
        functions: 60,
        lines: 55,
      },
    },
    environment: "node",
    fsModuleCache: true,
    include: ["test/**/*.node.test.ts"],
  },
});
