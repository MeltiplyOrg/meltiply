# CI checks

[The workflow](../.github/workflows/ci.yml) runs on pushes, pull requests, and manual
dispatch on ephemeral `ubuntu-24.04` runners. Actions use version tags, not commit hashes.

## Quality gate

- `changes`: select application and image lanes from changed paths.
- `baseline`: full-history secret scan, documentation checks, routing regressions;
  always runs.
- `frontend-fast`: app formatting, types, bindings, lint, coverage, production build,
  public-site checks.
- `cloudflare-fast`: spelling, contracts, Worker bindings, package/Worker types, tests
  and builds, strict lint, dead code, formatting, PostgreSQL integration.
- `cloudflare-tooling`: Node tooling suites, shell lifecycle and release regressions,
  supply-chain/SBOM policy, costs.
- `frontend-performance`: production publishing journey budgets and a browser check
  that saves and reloads publishing preferences, including multiple email recipients.
  Traces and JSON reports are retained.
- `selfhost-images`: when image inputs change, build all three images for amd64 and
  ARM64 on native runners and smoke the exact artifacts. Nothing is published.
- `ci-gate`: requires baseline and every selected lane; rejects failures or cancellations.

Lanes run independently after routing. Docs-, PR-template-, and skill-only PRs run
baseline and the final gate without installing dependencies. The router
([`github-routing.mjs`](../scripts/ci/github-routing.mjs)) reads
[`github-paths.json`](../scripts/ci/github-paths.json). Default-branch pushes compare
the previous commit; branches compare against their merge base. Manual runs and
unavailable ancestry select every lane.

Jobs use Node 24.18.0 and Bun 1.4.2 against disposable Docker PostgreSQL with
fixture-only credentials. Tokens have read-only repository access, checkouts retain no
credentials, and no deployment secrets are supplied. Never execute contributor code
through `pull_request_target` or persistent self-hosted runners.

The Cloudflare lane's `bun run contract:check` compares PRs with their merge base
and, when available, the latest reachable contract release. Breaking spans need a
fresh exact-change review token in one changelog bullet; missing initial-release
baselines are reported explicitly. See the
[contract upgrade procedure](../packages/contracts/README.md).

`bun run test:tooling` discovers Node test files in CI helpers, local tooling,
translations, infrastructure, releases, staging adapters, and self-hosted
jobs. Shell regressions and PostgreSQL suites stay separate; none need deployment
credentials.

Regression fixtures must isolate the rule a test names: clear independent upload limits
when modeling a monthly rollover, use a fresh service cache per cold observation, and
distinguish policy rejection from unrelated auth or server failures. Tests of signed
capability expiry must not let it outlive the persisted write hold.

## Manual lanes

[`extended.yml`](../.github/workflows/extended.yml) exposes lanes selected by hand:
`frontend-full`, `frontend-ui`, `cloudflare-full`, `cloudflare-integration`,
`cloudflare-extended`, `publishing-flow`, `publishing-browser`, `publishing-queues`,
`device-authorization`, `object-storage`, `portable-caching`, `portable-caching-smoke`,
`performance-focused`, `performance-backend`, `performance-media`, and
`versioned-contract`. They run on
GitHub-hosted machines without deployment secrets. A passing `ci-gate` does not imply
a manual lane ran.

Lanes use the real API, storage, processor, transport, and consumer with controlled
external Provider responses; they do not certify live credentials, platform audit, or
public posting. Playwright retries a failed test twice under `CI` unless the lane
command overrides it, so treat a retried pass as flaky rather than clean; traces and
screenshots are retained in the lane artifact before the next journey.

Wrangler fires no cron triggers locally, so the acceptance API exposes a fixture-only
route that invokes the Automation Worker's scheduled dispatcher through its existing
service binding; stored due times are unchanged and no future clock is injected.

`versioned-contract` runs the full application gate plus contract artifact and
production-entry HTTP health smoke. The
[contract release workflow](../.github/workflows/contract-release.yml) prepares
branch preview artifacts without publishing; protected `contract-v*` tag pushes
on default-branch history alone can publish. See the
[release procedure](../packages/contracts/README.md#prepare-and-publish).

Live deployments follow the
[operator-run release path](../infra/cloudflare/README.md#operator-run-deployment).

## Self-hosted release images

[`ci.yml`](../.github/workflows/ci.yml) and [`selfhost.yml`](../.github/workflows/selfhost.yml)
share [`selfhost-ci.yml`](../.github/workflows/selfhost-ci.yml), which builds the
app-only workerd runtime, migration image, and native media processor in parallel on
native amd64 and arm64 runners. Two downstream jobs smoke the exact artifacts without
rebuilding: email verification, authenticated database access, signed storage, queue
delivery, media processing, abrupt-restart recovery, and HTTPS.

Ordinary CI has read-only permissions and no registry login. Only published releases
and explicitly requested manual runs publish to GHCR, after image checks and
`cloudflare:check` pass. See [self-hosting](self-hosting.md#published-images-and-ci).

## Caching

[`install-workspace`](../.github/actions/install-workspace/action.yml) caches Bun's
download store keyed by OS/architecture, Bun version, lockfile, workspace config, and
patches; installation always uses `--frozen-lockfile`. Installed `node_modules` is not
cached. Frontend-only installation passes `selfhost: "false"` to skip the self-hosted
runtime's npm install.

Docker layer caches are isolated by component and architecture; the runtime Dockerfile
copies manifests, lockfiles, and patches before application source so source-only
changes reuse dependency layers. The backend lane persists Vite's content-addressed
task store for type-check and build only — tests, integration tests, secret scans, and
repository checks run every time. No PostgreSQL state or credentials are cached. Do
not enable Vitest's filesystem module cache with the pinned Cloudflare test plugin: the
Worker runtime tries to read host-only cache paths.

## Quality tools

[`install-quality-tool.sh`](../scripts/ci/install-quality-tool.sh) installs Gitleaks
8.30.1 and typos 1.35.5 from versioned archives with pinned SHA-256 checksums.

Spelling checks cover generated third-party notice bundles; a scoped dictionary
preserves an upstream author's surname. Do not rewrite copyright attribution to satisfy
a spelling suggestion.

The secret scanner keeps a live synthetic detection canary. Its config excludes three
proven false positives only when their exact source path and rule also match: the Argo
guide's `YOUR_API_TOKEN`, the SQL column `r2_thumbnail`, and one example JWT whose
signature is plain text. These are not file or commit exemptions — different
credentials in the same files still fail.

## Runner costs and branch protection

Standard GitHub-hosted runners are
[free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions);
larger runners and artifact/cache storage are not. These workflows use standard
runners, and extended lanes keep diagnostic artifacts for seven days.

Require `ci-gate` in branch protection. Do not require conditional lane statuses:
deliberately unselected jobs skip. Only a completed hosted run proves the gate passed.
