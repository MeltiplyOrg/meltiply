import { defineConfig } from "vite-plus";

/**
 * Unit coverage for the shared reporting module.
 *
 * `service.ts` is the transactional delivery engine: its SQL, retry, expiry and
 * withdrawal semantics are only meaningful against real PostgreSQL, so they are
 * asserted by the Worker integration suites
 * (`workers/api/test/reporting.integration.test.ts` and
 * `workers/automation/test/improvement-reporting.integration.test.ts`) instead of
 * by mocks here. Excluding it keeps this package's threshold honest rather than
 * padding it with a fake transaction adapter that would prove nothing.
 */
export default defineConfig({
  test: {
    // Keep mock call history until a suite explicitly clears it, preserving
    // pre-migration behavior instead of adopting Vitest 5's automatic reset.
    clearMocks: false,
    coverage: {
      enabled: true,
      exclude: ["src/service.ts"],
      provider: "v8",
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 80,
        lines: 75,
      },
    },
    reporters: process.env.CI
      ? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
      : ["default"],
  },
});
