# Contributing to Meltiply

Meltiply schedules and distributes social media content across platforms using serverless Cloudflare Workers, Queues, Workflows, Durable Objects, Neon PostgreSQL, and R2.

Contributions are built collaboratively by engineers and AI coding agents. This guide establishes the setup, AI development workflow, coding standards, quality gates, and pull request protocol.

## Licensing and contribution rights

Original contributions are submitted under the repository's [Sustainable Use License](LICENSE.md), unless an explicit separate agreement applies. Third-party material retains its own terms: identify its source and license, preserve required notices, and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not submit code or assets you lack permission to redistribute.

Submission under SUL is not a copyright assignment or an unrestricted relicensing grant. Any additional rights require a separate written agreement with the actual rights holder.

License/dependency changes must pass `bun run test:supply-chain` and `bun run security:supply-chain`. Review the [publication guide](docs/licensing.md) for development-tool restrictions, Git-history clearance, and native/bundled distribution obligations.

---

## Context pointers

Before making architectural or domain changes, consult these sources of truth:

- **Agent instructions & runtime architecture**: [`AGENTS.md`](AGENTS.md) defines completion gates per subsystem, mandatory function comment rules, and runtime invariants.
- **Domain vocabulary & models**: [`CONTEXT.md`](CONTEXT.md) defines ubiquitous domain terms (`Workspace`, `Platform`, `Provider`, `Post`, `Distribution`, `Asset`) and naming seams.
- **Product intent & brand**: [`PRODUCT.md`](PRODUCT.md) defines user personas, platform personality, and design tokens.

---

## Getting Started

### Prerequisites

- **Node.js**: `>=24.0.0 <25` (runtime for Wrangler, Vite, Vitest, and tooling scripts)
- **Bun**: `1.4.2` (workspace package manager and script runner)
- **Docker & Docker Compose**: local PostgreSQL, storage emulators, and building/running the linux/amd64 media processor container
- **Make**: primary workflow runner

### Parallel devcontainers

The [devcontainer configuration](.devcontainer/devcontainer.json) shares a
persistent Bun download cache and the host Docker daemon's images/build cache.
Each checkout keeps its own `node_modules`; do not install concurrently into
the same checkout or edit hardlinked package files in place.

Local PostgreSQL and optional telemetry remain private to each devcontainer:
the [Compose helper](scripts/cloudflare-local/compose.sh) selects a per-container
project and [network overlay](.devcontainer/compose.yml). Run local Compose
commands through that helper, not directly against the baseline file. Services
retain their localhost endpoints inside the container; use editor port forwarding
to access Grafana or database ports from the host.

With `herdr-worktree-devcontainer`, main-checkout configuration assets are staged
and mounted read-only; stable Docker labels survive branch hostnames and container
renames. Keep the launcher on its updated checkout, and update each worktree's
local scripts with this change before starting local services. Worktree cleanup
removes its explicitly labelled services and data volumes, attached anonymous
volumes, and unused worktree-specific Dev Containers image tags. The shared Bun
cache, base/shared Docker images, and Docker build cache are preserved.

Rebuild existing devcontainers to adopt this layout. Their old nested-Docker
volumes are not migrated or deleted automatically; retain any data you still
need before removing them. Avoid daemon-wide prune/cleanup commands while other
containers are active. Docker socket access is host-admin access: use this setup
only for trusted development.

The [network repair watcher](.devcontainer/container-network.sh) is shared once
per daemon and touches only pinned Cloudflare proxy namespaces. Inspect it with
`docker logs meltiply-container-network`.

### Quickstart

1. Clone and bootstrap the repository:

   ```bash
   git clone https://github.com/MeltiplyOrg/meltiply.git
   cd meltiply
   make setup
   direnv allow
   ```

2. Configure environment overrides:
   Add Worker overrides to the root `.env` created by `make setup`.

3. Start the local stack:

   ```bash
   make dev
   ```

   This starts the PostgreSQL database, applies schema migrations, boots Cloudflare Workers under Wrangler, and serves the Vite frontend.

   To run the frontend development server independently:

   ```bash
   make frontend-boot
   ```

### Media processor (native Container)

Asset optimization and video normalization run in a Cloudflare Container-backed
processor, not in the Worker: the engine under `workers/automation/processor`
runs on `alpine:3.23` with real **FFmpeg 8.0.1 / ffprobe** for video and
**libvips 8.17.x** for images, and `workers/automation/src/native-processor.ts`
is the Worker adapter that dispatches jobs to it.

- The Automation Worker reaches the engine through the private
  `MEDIA_PROCESSOR` Durable Object binding only (class
  `MediaProcessorContainer`); there is no public route for arbitrary jobs.
- The engine's `POST /process` endpoint requires the `PROCESSOR_JOB_TOKEN`
  bearer secret — a per-instance token the Durable Object generates, persists
  in DO storage, and injects through `ctx.container.start({env})`. It is never
  a wrangler var, secret, or `.env.example` entry; the only Worker credentials
  the adapter reads are the existing `R2_*` signing keys. Jobs carry only
  short-lived, exact-object signed input/output URLs; never hand a job
  permanent R2 bucket credentials, and never build a shell command string —
  pass an argv array to the binaries.
  Engine output writes are create-only — the signer binds
  `if-none-match: *` into the PUT signature, so a replayed or leaked grant can
  create the deterministic staging key but never overwrite bytes already
  there; a 412 means only that some object exists. Stored-byte identity is
  proven Worker-side before promotion: the Worker re-reads the staging object
  and requires a content-digest match — the stored sha256 when storage reports
  one, else the stored ETag against the recorded PUT ETag. The engine removes
  HTTP ETag quotes so its recorded tag matches R2's bare `etag` field. An output
  with no comparable digest is refused rather than trusted on a
  produced-vs-recorded sha256 match, which only proves the job deterministically
  recomputes the same bytes. Promotion of engine output to a ready key uses
  `ObjectStore.copyObject` with ETag/destination guards — the verified source
  must be unchanged and the publish-ready key absent — so replay and overwrite
  attempts return `null` rather than mutating bytes.
- Container config lives in `workers/automation/wrangler.jsonc`
  (`meltiply-media-processor`, `image: ./processor/Dockerfile`,
  `instance_type: "standard-3"` — 2 vCPU / 8 GiB / 16 GB, provisional pending
  benchmark — `max_instances: 4`, plus a `durable_objects` binding and a `v1`
  `new_sqlite_classes` migration). Engine variables (defaults in the
  Dockerfile): `PROCESSOR_PORT` (8080), `PROCESSOR_MAX_INPUT_BYTES`
  (576716800, 550 MiB), `PROCESSOR_MAX_OUTPUT_BYTES` (536870912, 512 MiB),
  `PROCESSOR_JOB_TIMEOUT_MS` (540000 — the engine ceiling fits inside the
  durable 600 s job lease), `PROCESSOR_MAX_PENDING_JOBS` (1), and
  `PROCESSOR_FFMPEG_THREADS` (2).
- The Worker adapter reuses `createR2SignerFromEnv` for exact-object capabilities,
  with a default 900-second TTL (`PROCESSOR_CAPABILITY_TTL_SECONDS`).
  Cleanup gates on `asset_objects.write_hold_until`; `updated_at` remains an
  audit timestamp, never a disguised future deadline. Every minted upload or
  part URL persists its planned deadline on the staging row under the session
  lock before the URL is exposed, and the signer is handed that absolute
  deadline (`expiresAt`) — a paused or delayed sign clamps to the persisted
  hold rather than stretching it, and an already-elapsed deadline fails
  instead of minting a late grant. A confirmed multipart abort or complete
  closes the hold immediately (the uploadId is dead); a single PUT retains
  the recorded grant window because its URL cannot be revoked; a failed or
  ambiguous abort keeps the hold and its charge. Native output grants carry
  the persisted row deadline into `signObjectWrite` the same way.
  Processing stages (`staging/<org>/<asset>/processing-<profile>`) remain
  inventoried and charged after promotion until their writer hold expires and
  deletion succeeds. A late PUT cannot mutate approved original/rendition keys
  or recreate bytes outside the inventory.
- Native-decoded durations retain fractional seconds in both the Asset summary
  and its object inventory (for example, `2.4` seconds), including when an
  already-compliant original is accepted without optimization. Migration
  `008_fractional_asset_duration.sql` upgrades the legacy integer summary;
  processing never rounds media facts to satisfy storage.
- Cloudflare Containers require a Docker-compatible engine and
  **linux/amd64** images, including when developing on ARM64 (buildx + QEMU).
  The smoke script builds `meltiply-processor-smoke` for `linux/amd64`.
- Full local Worker sessions use
  [`r2-gateway.mjs`](scripts/cloudflare-local/r2-gateway.mjs) to expose only the
  native S3 route on the Docker gateway at an allocated port. Wrangler's outer
  proxy accepts a loopback Host; its inner runtime restores the exact signed
  authority before SigV4 verification. Browser and processor capabilities remain
  identical, and the API retains its configured listener.
  The gateway applies signed download disposition/type overrides after a
  successful native S3 GET, filling Miniflare's response-metadata gap without
  bypassing signature validation or changing stored bytes.
  Wrangler applies CLI env files and variables only to the primary Worker, so
  the launcher uses a private temporary config tree with mode-0600 `.dev.vars`
  files containing the root env and the same R2 endpoint. Source and dependency
  paths link back to the checkout so edits remain live. Existing Worker-local
  env files are untouched and ignored by these sessions; root `.env` is the
  configuration source. Exit cleanup removes only the owned temporary tree,
  and concurrent sessions never share secret-file paths.
  A Docker daemon with threaded rather than domain cgroup controllers cannot
  enforce the processor's resource envelope: fix the daemon's cgroup setup
  before claiming native Ready-state browser acceptance.
- The devcontainer starts a [sidecar network repair](.devcontainer/container-network.sh)
  for the pinned local Cloudflare proxy image. On WSL/VPN kernels, inherited
  marked reverse-path validation can block startup before the engine is created.
  The repair changes only each sidecar's network namespace, not host routing or
  other containers. Outside the devcontainer, use a compatible Docker host; see
  the [upstream networking fix](https://github.com/cloudflare/workerd/pull/6794).
- Run the local smoke with:

  ```bash
  bun run --filter @meltiply/automation-worker smoke:processor
  # → workers/automation/processor/smoke/run.sh
  ```

  It starts the fixture object service, engine, and assertions on one Docker
  network and proves real behaviour: bearer auth, a still image, an animated
  GIF/WebP (animation preserved), 65–70 second MP4 and MOV beyond the short-video
  transformation service's limits, a no-benefit compliant original returned as
  the verified rendition, an oversized input, and a corrupt input (actionable
  failure, no output). Fixtures are generated by the image's own ffmpeg/vips
  inside the container. Optional knobs: `SMOKE_IMAGE` (image name) and
  `PROCESSOR_JOB_TOKEN` (generated when unset).
  The default smoke enforces Docker's 2-CPU/8-GiB limits. On a host whose cgroup
  hierarchy cannot enforce them, explicit `PROCESSOR_SMOKE_MEASURE_ONLY=1`
  omits those flags while retaining native thread limits and measuring the
  engine process tree's CPU time and combined process RSS. This is local
  measured evidence, not proof of hard resource-envelope or remote deployment
  enforcement; it must be reported as such.

- Remote Cloudflare deployment is a separate prerequisite: verify account and
  runtime availability before relying on the Container-backed processor, and
  never report deployed behaviour from a local-only smoke run.

> [!NOTE]
> Use `bun run test`, not `bun test`. Test suites execute under Vitest and Node's test runner for runtime fidelity.

Dependency security floors: Astro `>=7.2.8`, Hono `>=4.13.7`, and Vitest
`>=4.1.11` resolve the 25 Dependabot alerts reported for the default branch.
Keep Vitest coverage providers aligned with Vitest. Root Hono and Vitest
overrides also protect transitive consumers; retain these floors when updating
dependencies and regenerate `bun.lock` with `bun install`.

---

## AI-Assisted Development Workflow

All contributors — human engineers and AI coding agents — follow the same workflow discipline.

### Human-Agent Responsibilities

- **Human engineers**: Define task scope, evaluate architectural trade-offs, review every diff, test interactive user flows, and approve PR submission.
- **AI agents**: Adhere to codebase patterns, preserve tenant isolation and queue invariants, produce runnable proof, satisfy quality gates, and format PR bodies according to repo rules.
- **Context onboarding**: Point AI agents to [`AGENTS.md`](AGENTS.md) and [`CONTEXT.md`](CONTEXT.md) at the start of a session so they adhere to domain vocabulary and completion criteria.

### Function Documentation Standard

Every function or method created or modified must include a 2–6 line comment directly above its declaration:

1. **Purpose**: The requirement it fulfills and why the chosen approach satisfies it.
2. **Design choices**: Non-obvious invariants, trade-offs, or error handling.
3. **Contract**: Constraints on inputs, defaults, return values, side effects, and thrown errors. Include a concise input → output example when transformations are non-trivial.

---

## Branching Strategy

Always branch from an updated `main`:

```bash
git fetch origin
git checkout -b <branch-name> origin/main
```

### Branch Naming Conventions

| Type          | Pattern                           | Example                      |
| :------------ | :-------------------------------- | :--------------------------- |
| Feature       | `feat/<issue-number>-short-desc`  | `feat/42-add-tiktok-oauth`   |
| Bug fix       | `fix/<issue-number>-short-desc`   | `fix/57-broken-worker-route` |
| General issue | `issue/<issue-number>-short-desc` | `issue/34-worker-timeout`    |
| Chore / docs  | `chore/<issue-number>-short-desc` | `chore/12-update-deps`       |

Rules:

- One branch per issue or logical task.
- Keep branches focused; avoid bundling unrelated changes.
- Push your branch to GitHub and open a Pull Request; avoid local merges into `main`.

---

## Commit Message Rules

Meltiply uses [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <imperative description>

[optional body]

[optional footer: Closes #<issue-number>]
```

### Commit Types

| Type       | When to Use                                   |
| :--------- | :-------------------------------------------- |
| `feat`     | New feature or behavior                       |
| `fix`      | Bug fix                                       |
| `chore`    | Tooling, configuration, or dependency updates |
| `docs`     | Documentation changes only                    |
| `refactor` | Code restructuring without behavior changes   |
| `test`     | Adding or updating tests                      |
| `style`    | Formatting or whitespace adjustments          |
| `ci`       | CI/CD pipeline changes                        |
| `skill`    | Agent skill additions or modifications        |
| `perf`     | Performance improvements                      |

### Rules

- Keep subject lines under 72 characters, written in the imperative mood ("add queue consumer", not "added queue consumer"), with no trailing period.
- Keep commits atomic: one logical change per commit.
- Use explicit scopes where applicable (e.g., `feat(api):`, `fix(auth):`, `skill(code-review):`).

---

## Quality Gates & Verification

Every change must be verified before opening a Pull Request.

### Quality Gate Commands

Run the gate matching your change scope:

| Scope                                   | Command                                                                                                                            |
| :-------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend UI only**                    | `bun run --filter frontend check`                                                                                                  |
| **Workers or shared packages only**     | `bun run --filter './packages/*' --filter './workers/*' type-check && bun run --filter './packages/*' --filter './workers/*' test` |
| **OpenAPI contracts only**              | `bun run contract:check`                                                                                                           |
| **Documentation only**                  | `bun run docs:check`                                                                                                               |
| **Full check / Cross-cutting / Pre-PR** | `make check` (alias for `bun run cloudflare:check`)                                                                                |

Browser journeys run through `make frontend-test-e2e`, which exercises the
default Playwright project against the production local stack. The
publication journey and the channel-scoped composer scenarios need the
controlled-Provider acceptance backend and are excluded from the default run;
opt in with `MELTIPLY_E2E_ACCEPTANCE=1 make frontend-test-e2e` (see
`frontend/app/README.md`).

The manual frontend CI lane gives the complete browser suite a bounded
30-minute window; individual test deadlines still apply. Lighthouse measures
the built production frontend, not Vite development modules, and enforces the
existing [Lighthouse budgets](frontend/app/.lighthouserc.json).
Protected routes resolve the session before importing the workspace layout,
so an anonymous visit does not download navigation and workspace-query code.

Theme-reveal pixel probes skip pixels matching both settled palettes or neither.
Such content has no theme opinion; unchanged glyphs at the toggle origin must
not terminate a boundary ray before it reaches the surrounding ink. Mid-reveal
coverage, flat-background validation, and origin/edge thresholds remain required.

`bun run workers:types` regenerates binding declarations in an isolated
configuration mirror. Local `.env*` and `.dev.vars*` files stay untouched and
cannot add developer-only secrets to checked-in types.

Provider HTTP requests must invoke native `fetch` with `globalThis` as its
receiver. Calling a stored fetch as a client method throws an illegal-invocation
error in Workers before reaching the provider; Node-only tests do not expose
that runtime constraint.

Facebook OAuth response-validation warnings use `facebook_oauth_*_invalid` codes
to identify the invalid field, such as token expiry or Page access token.
These indicate local response validation—not an HTTP rejection—and never
include authorization codes, tokens, or raw Page data.
Shared logs emit one JSON line: correlation fields remain at the top, event
details live under `context`, and sanitized exception messages, stack frames,
and bounded cause chains live under `error`. OAuth failures include the known
user ID and outbound method, origin, and HTTP status when available; request
bodies, headers, URL queries, and provider response bodies are not logged.

### Verification Principles

- **Runnable proof**: A passing build or lint alone is insufficient. Verify runtime behavior with unit tests, integration tests, or smoke tests.
- **Zero-compromise fixes**: Fix introduced violations directly. Keep strict TypeScript checks, zero-warning lint (`vp lint --deny-warnings`), and dead-code elimination (`knip`) intact. Do not weaken rules or suppress warnings to pass.
- **Process discipline**: Run one heavy test, build, or check at a time. Prefix shell commands with `rtk` (e.g., `rtk bun run test`, `rtk git status`).
- **PostgreSQL isolation**: Stop local Workers and browser sessions before the
  full gate: its integration runner resets the local `meltiply` schemas on port
  5433 and seeds deterministic fixtures. Do not mix standalone suites with
  browser-upload jobs: the outbox relay claims global due work. Automation files
  run serially because they reuse seeded ownership scopes and quota/outbox state.
- **Local database ownership**: API and Automation invocations use independent
  local PostgreSQL pools; clients close on release in both Promise and callback
  checkout paths. Local Better Auth instances are not cached across requests.
  This prevents workerd-owned sockets and queued connects from crossing request
  boundaries; deployed isolate pooling is unchanged.
- **Local proxy stability**: Keep installed Cloudflare tooling at the workspace
  pins. Older Wrangler proxies can terminate the entire dev server when an idle
  connection closes during reuse; see the
  [upstream keep-alive race](https://github.com/cloudflare/workers-sdk/issues/14641).
  Do not hide a dead backend with browser retries or relax request deadlines.

---

## Pull Request Process

### 1. Confirm PR Scope

Use the requested base branch, else the remote default
(`git symbolic-ref refs/remotes/origin/HEAD`, fallback
`gh repo view --json defaultBranchRef`), and inspect the shipping branch diff
before drafting. Do not rebase automatically.

### 2. Execute Quality Gate

Run the gate matching your change scope — the scoped completion gate in
[`AGENTS.md`](AGENTS.md#completion-gate) is the authority.

### 3. Author the Pull Request Body

PR bodies are authored as structured JSON. Copy [`.github/pr.example.json`](.github/pr.example.json),
replace the provenance placeholders, and leave irrelevant sections blank —
`scripts/gh-guard/pr.schema.json` defines the shape and
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
summarizes the flow. AI agents follow the `pr` skill (`.agents/skills/pr/SKILL.md`),
which carries the section-by-section writing guidance.

### 4. Validate the Body

```bash
bun run pr:check /tmp/pr-body.json   # schema + diagram + format + typo checks
bun run pr:render /tmp/pr-body.json  # optional: preview the rendered Markdown body
```

### 5. Submit the Pull Request

```bash
scripts/gh-guard/gh pr create --body-json /tmp/pr-body.json --base <base> --head <branch>
```

> [!IMPORTANT]
> The PATH-shadow `gh` guard (`scripts/gh-guard/gh`) fails closed: it validates
> the JSON, renders the body, and injects the title/body. `--body`,
> `--body-file`, `--title`, `--fill`, and interactive creation are blocked.
>
> The explicit wrapper works without PATH activation. Use `gh` as shorthand
> only when it resolves to the repository guard.

### 6. Review and Merge

- Confirm all CI checks pass.
- Address review feedback and push updates to the branch.
- Request maintainer review to approve and merge. Do not merge your own PR.

---

## Questions

Open an issue on GitHub or comment on the relevant issue discussion.
