import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.test.jsonc",
      },
    }),
  ],
  test: {
    clearMocks: false,
    fsModuleCache: true,
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
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
    exclude: ["test/**/*.integration.test.ts"],
    include: ["test/**/*.test.ts"],
  },
});
