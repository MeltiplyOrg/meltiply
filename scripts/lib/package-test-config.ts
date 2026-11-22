import { defineConfig } from "vite-plus";

/** Per-package coverage floors; every metric is a percentage. */
export interface CoverageThresholds {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

/**
 * Builds the shared Vitest configuration for a `packages/*` workspace.
 *
 * Every package runs V8 coverage with its own floors, keeps mock call history
 * until a suite clears it, and emits JUnit results in CI. Packages state only
 * what differs: their thresholds and any sources excluded from coverage.
 *
 * @param thresholds - Coverage floors that fail the run when unmet.
 * @param options - Optional `coverageExclude` globs for sources covered elsewhere.
 * @returns Vite+ configuration for the package.
 */
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
