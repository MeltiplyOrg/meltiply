import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    environment: "node",
    fsModuleCache: true,
    include: ["test/**/*.node.test.ts"],
  },
});
