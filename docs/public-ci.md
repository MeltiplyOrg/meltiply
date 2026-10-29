# CI checks

[The GitHub Actions workflow](../.github/workflows/ci.yml) runs on pushes, pull
requests, and manual dispatch using ephemeral `ubuntu-24.04` hosted runners.
Actions use version tags, not commit-hash references.

## Quality gate

Automatic checks run in separate jobs:

- `changes`: select application and image lanes from changed paths.
- `baseline`: full-history secret scan, documentation checks, and routing
  regression tests; always runs.
- `frontend-fast`: app formatting, types, bindings, lint, coverage, production
  build, and public-site checks.
- `cloudflare-fast`: spelling, contracts, Worker bindings, package/Worker types,
  tests and builds, strict lint, dead code, formatting, drift/routing regressions,
  local-tooling and release regressions, supply-chain/SBOM policy, costs, and PostgreSQL integration tests.
- `selfhost-images`: when production image inputs change, build the three images
  for both amd64 and ARM64 in six parallel native-runner jobs, then smoke the exact
  artifacts on each architecture, including crash recovery and HTTPS. Nothing is
  published.
- `ci-gate`: require baseline and every selected lane to succeed; accept only
  deliberate skips for unselected lanes and reject failures or cancellations.

Application and image lanes run independently after routing. Documentation,
PR-template, and agent-skill-only PRs run baseline and the final gate without
installing dependencies or building images. Public-site source changes select
frontend checks but not app-only image builds; its package manifest still affects
the shared dependency installation and selects image checks.
[The router](../scripts/ci/github-routing.mjs) reads the public CI-owned
[path rules](../scripts/ci/github-paths.json). Workflow, routing, and development
container changes select both application lanes.

Default-branch pushes compare the previous commit with the new HEAD. Feature
branches and pull requests compare against their base merge point, retaining
earlier unmerged changes. Renames and deletions count. Manual runs and unavailable
ancestry conservatively select every lane.

The jobs use Node 24.18.0 and Bun 1.4.2. The database is a disposable local Docker
PostgreSQL instance with fixture-only credentials; cleanup runs after failures.
Tokens have read-only repository access, checkouts retain no credentials, and no
deployment secrets are supplied. Do not execute contributor code through
`pull_request_target` or persistent self-hosted runners.

The [extended workflow](../.github/workflows/extended.yml) exposes manually
selected lanes: `frontend-full` for full browser/Lighthouse journeys,
`frontend-ui` for focused UI verification, `cloudflare-full` for
`bun run cloudflare:check`, `cloudflare-integration` for live-local topology/load,
`cloudflare-extended` for release/staging/IaC checks, `publishing-queues` for the
complete application gate, changed-scope React review, and real Queue browser/
API/PostgreSQL/background delivery journey, `device-authorization` for the
complete application gate plus the real browser consent journey and CLI HTTP
lifecycle over the running installation, and `object-storage` for provider
switching. The storage lane builds a pinned MinIO release from source,
checks live S3 operations, runs `bun run cloudflare:check`, then exercises
application uploads, native media processing, private delivery, and retention
against R2 and MinIO. They run on GitHub-hosted machines without deployment
secrets. A passing automatic `ci-gate` does not imply that a manual lane ran.
Live deployments follow the [operator-run release path](../infra/cloudflare/README.md#operator-run-deployment).

`publishing-flow` runs focused composer/creator-freshness and all five Provider regressions, changed-scope React
review, the full application gate, documentation links, and browser publication,
weekly Queue, and multi-profile recovery journeys. `publishing-browser` repeats
only setup, documentation links, and those browser journeys when the application
gate's code/configuration is unchanged. Publication verifies independent outcomes,
retry without duplicate copies, real media bytes, draft settings, schedule edits,
deletion without unpublishing, and all five video Platforms through Now, manual
Schedule, and weekly Queue. Queue retry/removal/history and multi-profile recovery
also use real video. It captures provider controls at desktop/phone
widths in both palettes. Each journey resets disposable PostgreSQL state and uses
the real API, storage, processor, transport and consumer with controlled external
Providers; it does not certify live credentials, platform audit, or public posting.
Wrangler fires no cron triggers locally, so the acceptance API exposes a
fixture-only route that invokes the Automation Worker's scheduled dispatcher
through its existing service binding; stored due times stay unchanged. Browser
publication journeys still execute after an earlier step fails without clearing
that failure. The matrix creates its future Queue slot when its Queue iteration
begins, so preceding Now/Schedule work cannot consume that slot's lead time.
Browser failures are reported without automatic retries, and each journey's traces
and screenshots are retained in the lane's artifact before the next journey runs.

`device-authorization` runs the complete application gate, then starts the
production Worker and built frontend preview against a fresh seeded database. A
real Chromium journey signs in through the existing form (including a second
factor when enrolled), returns to the pending `/device` request, checks the
desktop/phone layouts in both palettes, approves and denies with keyboard input,
and confirms that a link visit grants nothing. A CLI-shaped HTTP smoke against
the running installation issues and claims a code, approves and redeems it,
obtains and exercises a JWT, verifies that the raw session credential is
rejected by `/api/v1`, signs out, and confirms the browser session survives.
Correlated Worker stdout must identify browser and CLI credentials despite
spoofed client hints, leave revoked credentials unattributed, and contain only
non-secret credential identifiers. This proves the production-composed local
runtime, not a deployed installation.

`portable-caching` runs the complete application gate and the portable read-cache
acceptance journey; `portable-caching-smoke` repeats only that journey when the
application gate's code/configuration is unchanged. The journey records real HTTP
cold/warm/concurrent summary requests, PostgreSQL aggregate counts/time, independent
Brand Profile lifecycle writes, expiry, capacity eviction, and browser capability
retention across navigation/focus/reconnect/reload. It captures desktop/phone
screenshots in both palettes. A disposable Worker uses the production route,
actor resolution, RLS, credential decryption, and bounded Provider HTTP client;
only JWT verification and external Provider responses are controlled. Native TCP
dispatch exercises separate Worker request contexts, not just `app.request`.
Network disconnects are observations: SQL completion does not acknowledge flight
membership, and a client abort does not acknowledge server-side interruption.
Deterministic join/cancellation guarantees remain covered at the controlled service
and authenticated route seams. Exact production-image Compose smoke runs the same
summary/browser journey and disposable Provider driver on amd64 and ARM64.
Credential-free measurements and screenshots are retained in `artifacts/cache/`;
they do not certify a deployed Cloudflare isolate or live Provider acceptance.

`cloudflare-full` first runs the [provider connection smoke](../scripts/selfhost/oauth-connection-check.ts)
against its disposable seeded database and the built SQLite OAuth state Worker.
All five implemented Providers exercise real authorization-state consumption,
encrypted selection, explicit assignment, idempotent replay (including rejecting
a changed Brand Profile), reconnection, and cancellation through API handlers and
PostgreSQL persistence. Only actor authentication and external provider HTTP
responses are controlled. The full application gate runs afterward, followed by a
focused production-app browser journey covering mobile focus containment,
portalled account-menu dismissal, and reconnect eligibility at desktop/phone widths
in both palettes. Its owner, profiles, and Channels are real fixture state; pending
selection metadata is controlled. Screenshots and traces are retained as artifacts.
This does not certify live provider consent, app review, account permissions, or
real social publication; see the [provider contract research](research/provider-channel-connections.md).

`frontend-full` provisions local signing/storage configuration before browser
journeys. It runs production-entry browser scenarios, then the cross-profile
media/recovery/publishing journey against the controlled-Provider acceptance
entries; provisioning helpers never run against production endpoints.
Controlled fixture responses are schema-decoded using their wire ownership fields
before those identities drive media copying or injected failures.
Browser journeys create uniquely named Brand Profiles in the shared Workspace.
Their selection helper restores that exact profile across reloads; a second
browser context must receive the profile name explicitly. Fixture provisioning
must not attach Channels to the first seeded profile.
The Analytics journey uses the same profile restoration before palette and phone
captures. Its cohort values are deterministic, but Post and Distribution ids are
unique per run so retries cannot collide in the shared Workspace.
User-facing journeys and screenshots use production assets without DevBox chrome.
`frontend-ui` runs both frontend checks, dead-code detection,
documentation links, React review, development CSS/font HTTP smoke, and the
controlled-backend workspace/public browser journey. Artifacts include desktop,
phone, and reported-user-width captures plus failure traces.
The React Doctor invocation is pinned in the workflow and receives no GitHub token.
Its changed-scope comparison fetches the public base branch without credentials.
The topology lane owns a separate backend process for load checks after smoke exits.

The browser phase recreates its disposable database after the integration gate,
so quota-boundary fixtures cannot exhaust browser uploads. Production limits are
unchanged.

The Queue lane exercises two real future reservations, reload, media processing,
safe removal, a controlled Provider failure and retry, and retained history after
retirement. Desktop/phone screenshots cover both palettes. Local Wrangler does
not run Cron automatically, so the journey dispatches the real scheduled handler
at wall-clock time through its local explorer API; it never changes stored due
times or injects a future clock. This controlled external Provider evidence is
not credentialed live-Platform acceptance, and never promotes endpoint readiness
without that separate evidence.

The existing self-hosted image smoke includes Chromium owner journeys: first-run
creation, SMTP-captured verification/reset links, closed registration, password
changes, and optional authenticator recovery. Login screenshots contain only
blank forms, not credentials or browser traces. These checks do not prove
external inbox delivery or a managed Cloudflare rollout.

## Backend benchmarks

[The backend benchmark workflow](../.github/workflows/backend-benchmark.yml) is a
manual two-revision measurement job, not part of `ci-gate`. It checks out
`master` as the baseline and the dispatched commit as the candidate, gives each
a dedicated PostgreSQL 18.6 database migrated from that revision, and runs the
same in-process API workload against both in alternating order. Raw JSON and the
generated comparison files are uploaded as artifacts. It measures Posts,
Distributions, Calendar, analytics, Inbox, Asset upload-session reads and creation,
schedule fan-out and target removal, and bulk Post deletion at batch sizes
1/5/10/25/50 under sequential and bounded concurrency. The results and methodology
behind the current optimizations are in
the [backend comparison report](benchmarks/backend-optimization.md).

The default `read-cache` benchmark profile compares warm, cold exact-range and
20-request concurrent summaries, sequential/concurrent controlled Provider
requirements, and seven unchanged read endpoints. It preserves current Channel
uniqueness constraints and records exact aggregate/upstream work counts per
request. The `all` choice preserves the historical mutation fixture for compatible
older revisions; it is not accepted by current one-Channel-per-Provider migrations.
PR #65's [master comparison](benchmarks/backend-optimization.md#pr-65-versus-master)
commits all six raw runs and the generated report, including cold-read overhead
and unchanged-endpoint tail regressions rather than claiming a uniform speedup.

## Self-hosted release images

The normal [CI workflow](../.github/workflows/ci.yml) and the
[release image workflow](../.github/workflows/selfhost.yml) share the
[reusable image workflow](../.github/workflows/selfhost-ci.yml).
It builds the app-only workerd runtime, migration image, and native media
processor in parallel on native `ubuntu-24.04` and `ubuntu-24.04-arm` runners.
Each image is exported directly to a compressed Docker archive with one-day
artifact retention. Two downstream smoke jobs load these exact artifacts without
rebuilding and exercise email verification, authenticated database access, signed
storage, queue delivery, media processing, abrupt-restart recovery, and HTTPS.
Archives use zstd once; artifact upload disables redundant compression.

Ordinary CI has read-only repository permissions and no registry login or image
push step. Only published releases and explicitly requested manual release runs
can publish to GHCR with package-write `GITHUB_TOKEN` permissions, after the image
checks and `cloudflare:check` pass. See [self-hosting](self-hosting.md#published-images-and-ci)
for tags, configuration, and deployment.

## Caching

[Workspace installation](../.github/actions/install-workspace/action.yml) caches
Bun's download store, keyed by runner OS/architecture, Bun version, lockfile,
workspace configuration, and dependency patches. A compatible download-cache
fallback avoids re-downloading unchanged packages; installation always uses
`--frozen-lockfile`. Installed `node_modules` is not cached.

Docker layer caches are isolated by component and architecture. The runtime
Dockerfile installs workspace dependencies from manifests, lockfiles, and patches
before copying application source, so source-only changes reuse dependency layers.
Its audited production npm dependencies are installed once and reused by the
builder and final runtime. Release checks reuse the image workflow and run the
Cloudflare gate concurrently; publication loads verified artifacts and creates
multi-architecture manifests without rebuilding.

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

Spelling checks still cover generated third-party notice bundles. A scoped
dictionary preserves an upstream author's surname; do not rewrite copyright
attribution to satisfy an English spelling suggestion.

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
