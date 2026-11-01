import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { frontendOrigin, frontendPort } from "./e2e/ports";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stagingBaseUrl = process.env.STAGING_E2E_BASE_URL?.trim();
const stagingStorageState = process.env.STAGING_E2E_STORAGE_STATE?.trim();
const localApiOrigin = process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787";
const reuseExistingServers = process.env.MELTIPLY_E2E_REUSE_SERVERS === "1";
const publicPreview = process.env.MELTIPLY_E2E_START_PUBLIC === "1";
const publicOrigin = "http://127.0.0.1:4321";
// Opt-in acceptance mode boots the controlled-Provider acceptance Workers instead of
// the production local entries. Controlled journeys (publication and channel-scoped
// composer scenarios) need the controlled Provider on the far side of the Provider
// boundary and the fixture endpoints mounted by `workers/api/test-support`. Default
// production test runs keep `dev-backend.sh` and the production Worker mains, where
// fixture endpoints are not mounted.
const acceptanceMode =
  process.env.MELTIPLY_E2E_PUBLICATION === "1" || process.env.MELTIPLY_E2E_ACCEPTANCE === "1";

if (stagingBaseUrl && !stagingStorageState) {
  throw new Error("STAGING_E2E_STORAGE_STATE is required when STAGING_E2E_BASE_URL is set.");
}

/**
 * Title patterns matching composer journeys that exercise controlled-Provider Channels.
 * The production Worker stack (`dev-backend.sh`) does not mount the test fixture
 * endpoints (`/controlled-provider/v1/**`), so default production test runs must
 * exclude these scenarios to avoid provisioning 404s.
 */
const controlledComposerPatterns = [
  /recovers independent profile copies and retries only unfinished publishing/,
  /replaces one attachment without changing the count, order, or channel selections/,
  /reports an actionable processing failure and blocks publishing/,
  /reopens one Post with its ordered attachments and channel targets/,
  /reopens a draft whose provider options have no distribution/,
  /keeps an enabled but blank channel caption blank across saves/,
  /identifies media-required channels before submitting text-only posts/,
];

const performanceProjects =
  process.env.MELTIPLY_E2E_PERFORMANCE === "1"
    ? [
        {
          name: "performance",
          testMatch: "**/performance.spec.ts",
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : [];

const localProjects = [
  {
    name: "chromium",
    testIgnore: [
      "**/staging-smoke.spec.ts",
      "**/posts-publication.spec.ts",
      "**/publishing-queues.spec.ts",
      "**/workspace-design.spec.ts",
      "**/analytics.spec.ts",
      "**/performance.spec.ts",
    ],
    grepInvert: controlledComposerPatterns,
    use: { ...devices["Desktop Chrome"] },
  },
  ...performanceProjects,
];
const acceptanceProjects = [
  {
    name: "publication",
    testMatch: "**/posts-publication.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "composer",
    testMatch: "**/posts-composer.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "workspace",
    testMatch: [
      "**/workspace-design.spec.ts",
      "**/analytics.spec.ts",
      "**/shared-components.spec.ts",
      "**/public-site.spec.ts",
    ],
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "queues",
    testMatch: "**/publishing-queues.spec.ts",
    use: { ...devices["Desktop Chrome"] },
  },
];
const stagingProjects = stagingBaseUrl
  ? [
      {
        name: "staging",
        testMatch: "**/staging-smoke.spec.ts",
        use: {
          ...devices["Desktop Chrome"],
          baseURL: stagingBaseUrl,
          storageState: resolve(repositoryRoot, stagingStorageState!),
        },
      },
    ]
  : [];

const remoteE2eBaseUrl = stagingBaseUrl;

const reporters: ReporterDescription[] = [["./e2e/prometheus-reporter.ts"]];
if (process.env.CI) {
  reporters.push(
    ["line"],
    ["html", { open: "never" }],
    ["junit", { outputFile: "test-results/junit-e2e.xml" }],
  );
} else {
  reporters.push(["line"]);
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: reporters,
  use: {
    baseURL: frontendOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: stagingBaseUrl ? stagingProjects : acceptanceMode ? acceptanceProjects : localProjects,
  webServer: remoteE2eBaseUrl
    ? undefined
    : [
        {
          // The acceptance launcher boots the `workers/*/test-support` entries,
          // which are the production entries plus the controlled Provider on the
          // existing dependency seam. Nothing else in this config changes, so a
          // default run still boots the production Worker mains.
          command: acceptanceMode
            ? "bash scripts/cloudflare-local/dev-acceptance-backend.sh"
            : "bash scripts/cloudflare-local/dev-backend.sh",
          cwd: repositoryRoot,
          env: {
            ...process.env,
            WRANGLER_DEV_ALLOWED_ORIGINS: frontendOrigin,
            WRANGLER_DEV_APP_URL: frontendOrigin,
          },
          reuseExistingServer: reuseExistingServers,
          // Let the gateway forward shutdown to its detached Wrangler group;
          // killing only the gateway leaves inherited output pipes open.
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          // An acceptance boot may have to build the media-processor Container
          // image on first use, which the production local stack also needs but
          // has already paid for in a warm Docker cache.
          timeout: acceptanceMode ? 600_000 : 120_000,
          url: `${localApiOrigin}/api/v1/health`,
        },
        {
          // Browser snapshots and Lighthouse must exercise the same production
          // assets; development-only launchers are not part of that surface.
          command: `bun run --cwd frontend/app build:production && bun run --cwd frontend/app --no-install vp preview --host 127.0.0.1 --port ${frontendPort} --strictPort`,
          cwd: repositoryRoot,
          env: {
            ...process.env,
            APP_URL: frontendOrigin,
          },
          reuseExistingServer: reuseExistingServers,
          timeout: 120_000,
          url: `${frontendOrigin}/`,
        },
        ...(publicPreview
          ? [
              {
                command: `bun run --cwd frontend/public build && bun run --cwd frontend/public --no-install preview -- --host 127.0.0.1 --port 4321 --strictPort`,
                cwd: repositoryRoot,
                reuseExistingServer: reuseExistingServers,
                timeout: 180_000,
                url: `${publicOrigin}/`,
              },
            ]
          : []),
      ],
});
