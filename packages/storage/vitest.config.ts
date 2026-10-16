import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Keep mock call history until a suite explicitly clears it, preserving
    // pre-migration behavior instead of adopting Vitest 5's automatic reset.
    clearMocks: false,
    coverage: {
      enabled: true,
      provider: "v8",
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 70,
        lines: 80,
      },
    },
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
  },
});
