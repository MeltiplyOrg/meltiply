import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    fsModuleCache: true,
    setupFiles: ["../../scripts/lib/vitest-offline-collector.ts"],
    environment: "node",
    include: ["test/**/*.node.test.ts"],
  },
});
