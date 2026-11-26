import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    clearMocks: false,
    coverage: {
      enabled: true,
      provider: "istanbul",
      thresholds: {
        statements: 50,
        branches: 35,
        functions: 50,
        lines: 50,
      },
    },
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
  },
});
