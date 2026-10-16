# CI checks

[The GitHub Actions workflow](../.github/workflows/ci.yml) runs on pushes, pull
requests, and manual dispatch using ephemeral `ubuntu-24.04` hosted runners.
Actions use version tags, not commit-hash references.

## Quality gate

Automatic checks run in separate jobs:

- `changes`: select frontend/backend lanes from changed paths.
- `baseline`: full-history secret scan, documentation checks, and routing
  regression tests; always runs.
- `frontend-fast`: app formatting, types, bindings, lint, coverage, production
  build, and public-site checks.
- `cloudflare-fast`: spelling, contracts, Worker bindings, package/Worker types,
  tests and builds, strict lint, dead code, formatting, drift/routing regressions,
  local-tooling and release regressions, supply-chain/SBOM policy, costs, and PostgreSQL integration tests.
- `ci-gate`: require baseline and every selected lane to succeed; reject
  failures, cancellations, and unexpectedly skipped jobs.

The application lanes run independently after routing. Documentation-only changes
run baseline and the final gate without installing application dependencies.
[The router](../scripts/ci/github-routing.mjs) reads the public CI-owned
[path rules](../scripts/ci/github-paths.json). Workflow, routing, and development
container changes select both application lanes.

Default-branch pushes compare the previous commit with the new HEAD. Feature
branches and pull requests compare against their base merge point, retaining
earlier unmerged changes. Renames and deletions count. Manual runs and unavailable
ancestry conservatively select both lanes.

The jobs use Node 24.18.0 and Bun 1.4.2. The database is a disposable local Docker
PostgreSQL instance with fixture-only credentials; cleanup runs after failures.
Tokens have read-only repository access, checkouts retain no credentials, and no
deployment secrets are supplied. Do not execute contributor code through
`pull_request_target` or persistent self-hosted runners.

The [extended workflow](../.github/workflows/extended.yml) preserves manually
selected `frontend-full`, `cloudflare-integration`, and `cloudflare-extended`
lanes for real browser/Lighthouse journeys, live-local topology/load, and
release/staging/IaC checks. These run on GitHub-hosted machines without deployment
secrets; a passing automatic `ci-gate` does not imply the manual lanes ran.
Live deployments follow the [operator-run release path](../infra/cloudflare/README.md#operator-run-deployment).

`frontend-full` provisions local signing/storage configuration before browser
journeys. User-facing journeys and screenshots use the production build; the
DevBox motion scenarios use a separate loopback development server on the
adjacent port. Production tests never enable DevBox controls. The topology lane
owns a separate backend process for load checks after the smoke process exits.

## Caching

[Workspace installation](../.github/actions/install-workspace/action.yml) caches
Bun's download store, keyed by runner OS/architecture, Bun version, lockfile,
workspace configuration, and dependency patches. A compatible download-cache
fallback avoids re-downloading unchanged packages; installation always uses
`--frozen-lockfile`. Installed `node_modules` is not cached.

The backend lane persists Vite's content-addressed task store. Keys include the
runtime, dependency fingerprint, commit, run ID, and attempt; dependency-matched
restore prefixes allow later runs to reuse earlier task results without freezing
the cache at the first commit. Only type-check/build tasks use task caching;
tests, integration tests, secret scans, and repository checks execute every time.
No PostgreSQL state or credentials are cached. GitHub scopes PR caches separately
from the default branch; cache size and retention remain subject to GitHub limits.

## Quality tools

[The tool installer](../scripts/ci/install-quality-tool.sh) installs
Gitleaks 8.30.1 and typos 1.35.5 using versioned release archives and pinned
SHA-256 archive checksums. These verify downloads; they are not GitHub Action
commit references. Linux x64 and arm64 are supported.

The scanner retains its live synthetic detection canary. Its configuration
excludes three proven false-positive values only when their exact source path
and detection rule also match: the Argo guide's `YOUR_API_TOKEN`, the SQL DDL
column `r2_thumbnail`, and one exact example JWT whose signature is plain example
text, not a valid EdDSA signature. These are not whole-file or commit exemptions;
different credentials in those same files must still fail.

## Runner costs and branch protection

GitHub's standard hosted-runner execution is
[free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Larger runners are not free; artifact/cache storage has separate limits. These
workflows use standard runners. Extended lanes retain diagnostic artifacts for seven days.

Configure branch protection to require `ci-gate` after its first successful run.
Do not require the conditional lane statuses: deliberately unselected jobs skip.
Only a completed hosted run proves the gate passed.
