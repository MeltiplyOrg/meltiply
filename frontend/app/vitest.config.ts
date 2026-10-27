import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite-plus";
import { previewContractPlugin } from "./preview-contract";

export default defineConfig({
  plugins: [previewContractPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Vitest v5 resets each mock's recorded calls before every test
    // (`clearMocks` defaults to true). Keep v4's behavior of retaining call
    // history across a file so setup-level mocks stay assertable.
    clearMocks: false,
    env: { APP_URL: "http://localhost:8787" },
    include: ["**/*.test.{ts,tsx}"],
    // CI enables coverage on the command line; keep its v8 provider explicit
    // so dependency analysis sees the provider without enabling local coverage.
    coverage: { provider: "v8" },
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
  },
});
