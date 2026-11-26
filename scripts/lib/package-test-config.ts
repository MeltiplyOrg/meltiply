import { defineConfig } from "vite-plus";

export interface CoverageThresholds {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

export function packageTestConfig(
  thresholds: CoverageThresholds,
  options: { readonly coverageExclude?: readonly string[] } = {},
) {
  return defineConfig({
    test: {
      clearMocks: false,
      coverage: {
        enabled: true,
        ...(options.coverageExclude ? { exclude: [...options.coverageExclude] } : {}),
        provider: "v8",
        thresholds: { ...thresholds },
      },
      reporters: process.env.CI
        ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
        : ["default"],
    },
  });
}
