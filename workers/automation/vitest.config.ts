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
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
    exclude: ["test/**/*.integration.test.ts", "test/**/*.node.test.ts"],
    include: ["test/**/*.test.ts"],
  },
});
