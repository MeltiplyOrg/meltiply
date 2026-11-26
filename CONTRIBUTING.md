# Contributing to Meltiply

[AGENTS.md](AGENTS.md) owns implementation standards and change-scoped verification
for humans and coding agents. Read [STATE.md](STATE.md) before refactors, schema
changes, or data resets; use [CONTEXT.md](CONTEXT.md) for domain vocabulary and the
[MVP release checklist](docs/release-acceptance.md) for release acceptance.

## Licensing

Original contributions are submitted under the [GNU Affero General Public License
version 3 or later](LICENSE.md) unless a separate agreement applies. Identify
third-party sources and licenses, preserve required notices, and update
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Submit only code and assets you
have permission to redistribute. Submission under the AGPL is not a copyright
assignment; it licenses your contribution to everyone who receives the software under
the same terms and grants the maintainers no additional rights.

For dependency or license changes run `bun run test:supply-chain` and
`bun run security:supply-chain`. See [release licensing](docs/licensing.md) for
development-tool restrictions and binary/native redistribution obligations.

## Setup

Follow [Get started](README.md#get-started) for supported versions and initial setup.

`make install` checks host prerequisites, installs the pinned Bun and Chromium, and
then runs the same repository setup: workspace dependencies, the ignored root `.env`,
migrations, and fixtures. Run `make setup` alone only when the host tools are already
present. Keep credentials out of commits; configure overrides in that root `.env`
using [`.env.example`](.env.example).

The self-host runtime is a separate npm package, outside the Bun workspaces.
Before repository-wide linting or running its local smoke scripts, install its
locked development dependencies as well:

```bash
npm ci --prefix scripts/selfhost --include=dev
```

This supplies Miniflare and PostgreSQL types at their owning package boundary;
do not rely on transitive dependencies from other workspaces.

`make dev` starts the database, Workers, app, and public site on loopback. Public
tunnels require `MELTIPLY_DEV_TUNNEL=1 make dev`; callback and webhook URLs must match
the chosen origin. For app-only iteration against an existing backend use
`make frontend-boot`.

Each devcontainer runs a dedicated Docker-in-Docker daemon with persistent
`/var/lib/docker` and `/var/lib/containerd` volumes keyed by `${devcontainerId}`, so
images, containers, networks, and application volumes are not shared with the host or
sibling devcontainers. The Bun download cache stays shared. Use
[`compose.sh`](scripts/cloudflare-local/compose.sh) so database and telemetry
operations select the devcontainer overlay; its `host` network is the devcontainer's
namespace, with PostgreSQL on port 5433. Do not install concurrently into the same
checkout.

The VibeCode Essential image is used directly, without a project image build. The
config replaces its inherited host-socket mount with read-only `/dev/null`, and
lifecycle hooks stop the inert socket proxy and start the bundled DinD daemon, so the
real host socket is never exposed. Privileged DinD is not a security sandbox:
containers still share the host kernel and the explicit host mounts stay accessible.
Open only trusted checkouts. The workerd reverse-path repair logs to
`/tmp/meltiply-container-network-<uid>/watcher.log`.

## Commands and testing

`make help` lists daily workflows; `bun run` lists package checks and operational
commands, which have no second Make alias.

```bash
bun run db:start
bun run local:smoke
bun run dev:backend
bun run local:teardown
```

Teardown discards local database volumes. The full gate's integration runner also
resets local schemas and seeds fixtures: stop local Workers and browser sessions
first, keep test databases isolated, and never point these commands at production
data. Do not run standalone integration suites alongside browser-upload jobs; the
outbox relay claims shared due work.

Exact scheduler-count tests must exclude unrelated in-flight demo fixtures without
changing production eligibility or relaxing assertions. The Automation asset suite
holds a separate connection's row locks only during each scheduler call so the real
`SKIP LOCKED` query skips baseline rows; release those locks before later
provider-sync fixtures update shared data.

Doctor and teardown regression scripts default to fixture-owned host topology;
container scenarios set their identities explicitly. Keep process and port probes,
Compose resources, tunnel credentials, home directories, and cgroup inputs inside the
fixture so these checks cannot inspect or reap a developer's live stack.

The native media processor runs as a `linux/amd64` Cloudflare Container using
FFmpeg/libvips; ARM hosts need working amd64 emulation. Verify a real image with
`./scripts/cloudflare-local/processor-smoke.sh`. No arbitrary-job public route is
exposed: the Worker uses its internal Durable Object binding and short-lived,
exact-object R2 capabilities.

Browser journeys use `make frontend-e2e-install` and `make frontend-test-e2e`.
Provider-controlled publication journeys require the acceptance backend and
`MELTIPLY_E2E_ACCEPTANCE=1`; see the [app guide](frontend/app/README.md). Use
`make frontend-lighthouse` for production-build performance budgets.

## Agent skills

Agent skills live in `.agents/skills` and are shared through the `.claude` and `.kiro`
symlinks. Pack-managed skills come from
[`Essential-kit/skills`](https://github.com/Essential-kit/skills); update them with
`bun run skills:sync` and verify with `bun run skills:check`. Read
[agent skills](docs/agents/skills.md) before editing the managed set.

## UI and public-guide changes

Treat the current Gr8r-adapted implementation as visual truth. Read [shared UI
ownership](docs/frontend-ui.md), [layout/scroll boundaries](docs/frontend-layout.md),
and the [capability inventory](docs/frontend-capabilities.md). Extend exported
`@meltiply/ui` controls and existing feature compositions instead of copying
components or building a page-specific CSS system.

Keep feature data, authorization, selection, and async actions with their owners.
Preserve the existing animation path; new animation work extends shared recipes
without adding a mode or preference layer. Update public guides when controls, labels,
navigation, or workflow entry points move.

Follow the scoped completion gate and inspect actual desktop/phone states in both
palettes. Passing lint or a build alone does not prove the UI.

## Branches, commits, and pull requests

Start a focused branch from the remote default. Use Conventional Commits with an
imperative subject under 72 characters and no trailing period. Keep unrelated work out
of the commit; never push directly to `master`/`main`.

Run the [scoped completion gate](AGENTS.md#completion-gate) and record actual
commands and results. A blocked required check is a blocker, not a pass; reuse results
for unchanged code rather than rerunning a full gate just to open a PR.

Write a Markdown body using the [PR template](.github/PULL_REQUEST_TEMPLATE.md):
changes, verification evidence, and relevant risks/rollback. Optional manual QA steps
must state expected outcomes, not pretend they already passed. Create a PR only when
requested:

```bash
gh pr create --base <base> --head <branch> --title '<type>(<scope>): <change>' --body-file /tmp/pr.md
```

Check `gh pr list --head <branch>` first; update an existing PR through the REST API
rather than creating a duplicate. `gh pr edit` exits non-zero here on a
Projects-classic deprecation warning even after it writes, so it cannot gate CI:

```bash
gh api -X PATCH repos/<owner>/<repo>/pulls/<number> -F body=@/tmp/pr.md
```

Agents use the [pr skill](.agents/skills/pr/SKILL.md). Address review feedback and
request maintainer approval; do not merge your own PR.
