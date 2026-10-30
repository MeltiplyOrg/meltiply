# Contributing to Meltiply

[AGENTS.md](AGENTS.md) owns implementation standards and change-scoped verification
for humans and coding agents. Read [STATE.md](STATE.md) before refactors, schema
changes, or data resets; use [CONTEXT.md](CONTEXT.md) for domain vocabulary.

## Licensing

Original contributions are submitted under the [Sustainable Use License](LICENSE.md)
unless a separate agreement applies. Identify third-party sources and licenses,
preserve required notices, and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Submit only code and assets you have permission to redistribute. SUL submission is
not an assignment or an unrestricted relicensing grant; obtain additional rights
in writing from the actual rights holder when needed.

For dependency/license changes, run `bun run test:supply-chain` and
`bun run security:supply-chain`. See [release licensing](docs/licensing.md) for
development-tool restrictions and binary/native redistribution obligations.

## Setup

Follow [Get started](README.md#get-started) for the supported runtime versions
and initial setup commands.

`make install` additionally checks host prerequisites, installs the pinned Bun if
needed, and installs Chromium. `make setup` installs workspace dependencies,
creates the ignored root `.env`, applies migrations, and seeds local fixtures.
Keep credentials out of commits; configure overrides in that root `.env`, using
[`.env.example`](.env.example) for supported settings.

`make dev` starts the database, Workers, app, and public site on loopback.
Public tunnels require `MELTIPLY_DEV_TUNNEL=1 make dev`. Use the printed URLs;
callback and webhook URLs must match the chosen origin. For app-only iteration
against an existing backend, use `make frontend-boot`.

Each devcontainer has a dedicated Docker-in-Docker daemon and persistent volumes
for `/var/lib/docker` and `/var/lib/containerd`, keyed by `${devcontainerId}`.
Docker images, containers, networks, and application volumes are not shared with
the host daemon or sibling devcontainers. The Bun download cache remains shared.
Use [`compose.sh`](scripts/cloudflare-local/compose.sh) so database and telemetry
operations select the devcontainer overlay. Its `host` network is the
devcontainer's namespace, not the outer host; PostgreSQL remains on port 5433.
Do not install concurrently into the same checkout.

The VibeCode Essential image is used directly, without a project image build.
The config overrides its inherited host-socket mount with read-only `/dev/null`.
Lifecycle hooks stop the resulting inert socket proxy and start the image's
bundled DinD daemon; the real host socket is never exposed. Startup also prepares
private cgroup v2 delegation so nested containers can enforce CPU and memory limits.

Rebuild existing devcontainers and run `make setup` after switching. The new inner
daemon does not import or delete old host-daemon images, containers, or database
volumes. Its two storage volumes persist independently of the devcontainer's
writable layer.

Host OMP and Wrangler state and GitHub/WakaTime configuration remain mounted;
GitHub authentication is used by the existing post-create Git setup. Privileged
DinD is not a security sandbox: containers still share the host kernel, and these
explicit host mounts remain accessible. Open only trusted checkouts.
The workerd reverse-path repair runs inside this devcontainer and logs to
`/tmp/meltiply-container-network-<uid>/watcher.log`.

## Commands and testing

`make help` lists daily workflows. `bun run` lists package checks, database,
infrastructure, release, and maintenance commands; these do not have a second
Make alias. For example:

```bash
bun run db:start
bun run local:smoke
bun run dev:backend
bun run local:teardown
```

Teardown discards local database volumes. The full gate's integration runner also
resets local schemas and seeds fixtures: stop local Workers/browser sessions first,
keep test databases isolated, and never point these commands at production data.
Do not run standalone integration suites alongside browser-upload jobs; the outbox
relay claims shared due work.

Exact scheduler-count tests must exclude unrelated in-flight demo fixtures without
changing production eligibility or relaxing assertions. The Automation asset suite
uses a separate connection's row locks only during each scheduler call, letting
the real `SKIP LOCKED` query skip baseline rows. Release those locks before later
provider-sync fixtures update the shared data.

Doctor and teardown regression scripts default to fixture-owned host topology;
container scenarios set their identities explicitly. Keep process and port probes,
Compose resources, tunnel credentials, home directories, and cgroup inputs inside
the fixture so running these checks cannot inspect or reap a developer's live stack.

The native media processor runs as a `linux/amd64` Cloudflare Container using
FFmpeg/libvips. ARM hosts need working amd64 emulation. Verify a real image with
`./scripts/cloudflare-local/processor-smoke.sh`; see the
[app guide](frontend/app/README.md) for upload behavior and browser acceptance setup.
No arbitrary-job public route is exposed: the Worker uses its internal Durable
Object binding and short-lived, exact-object R2 capabilities.

Browser journeys use `make frontend-e2e-install` and `make frontend-test-e2e`.
Provider-controlled publication/composer journeys require the separate acceptance
backend and `MELTIPLY_E2E_ACCEPTANCE=1`; details live in the app guide. Use
`make frontend-lighthouse` for the production-build performance budgets.

## Agent skills

Agent skills live in `.agents/skills` and are shared through the `.claude` and
`.kiro` symlinks. Pack-managed skills come from
[`Essential-kit/skills`](https://github.com/Essential-kit/skills); update them with
`bun run skills:sync` and verify them with `bun run skills:check`. Read
[agent skills](docs/agents/skills.md) before editing the managed set.

## UI and public-guide changes

Use the current Gr8r-adapted implementation as visual truth. Read
[shared UI ownership](docs/frontend-ui.md), [layout/scroll boundaries](docs/frontend-layout.md),
and the [capability inventory](docs/frontend-capabilities.md). Extend exported
`@meltiply/ui` controls and existing feature compositions instead of copying
components or building a page-specific CSS system.

Keep feature data, authorization, selection, and async actions with their owners.
Preserve the existing animation path; new animation work extends shared recipes
without adding a separate mode or preference layer. Update public guides when
controls, labels, navigation, or workflow entry points move.

Follow the scoped completion gate and inspect actual desktop/phone states in both
palettes. For agent-run verification, use GitHub-hosted runners unless local
execution was explicitly requested. Record exact check/runtime outcomes; passing
lint or a build alone does not prove the UI.

## Branches, commits, and pull requests

Start a focused branch from the remote default, not a hardcoded branch name.
Use Conventional Commits with an imperative subject under 72 characters and no
trailing period. Keep unrelated work out of the commit; never push directly to
`master`/`main`.

Run the [scoped completion gate](AGENTS.md#completion-gate) and record actual
commands/results. A blocked required check is a blocker, not a pass; reuse results
for unchanged code rather than rerunning a full gate solely to open a PR.

Write a Markdown body using the [PR template](.github/PULL_REQUEST_TEMPLATE.md):
changes, verification evidence, and relevant risks/rollback. Optional manual QA
steps must state expected outcomes, not pretend they already passed. Create a PR
only when requested, using the native CLI:

```bash
gh pr create --base <base> --head <branch> --title '<type>(<scope>): <change>' --body-file /tmp/pr.md
```

Check `gh pr list --head <branch>` first; update an existing PR with
`gh pr edit --body-file /tmp/pr.md` instead of creating a duplicate. Agents use the
[pr skill](.agents/skills/pr/SKILL.md) for the same process. Address CI/review
feedback and request maintainer approval; do not merge your own PR.
