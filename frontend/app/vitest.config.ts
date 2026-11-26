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
    clearMocks: false,
    fsModuleCache: true,
    env: { APP_URL: "http://localhost:8787" },
    include: ["**/*.test.{ts,tsx}"],
    coverage: { provider: "v8" },
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
  },
});
