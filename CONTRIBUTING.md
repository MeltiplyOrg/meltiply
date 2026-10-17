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

Each devcontainer uses its own Compose project/network and `node_modules`, sharing
only the Bun download cache and Docker image cache. Use
[`compose.sh`](scripts/cloudflare-local/compose.sh), not a direct baseline Compose
invocation, so database and telemetry operations stay in the correct checkout.
Do not install concurrently into the same checkout.

The devcontainer builds from the official Node image with Docker and GitHub CLI
features. It mounts no host credentials, AI-agent state, or editor telemetry
configuration. Authenticate inside the container only when needed (`gh auth login`
or `bunx wrangler login`); configure Git identity explicitly. Tunnels and AI tools
are optional, not startup requirements. Docker socket access grants host-admin
capabilities: open only trusted checkouts. The optional
`.devcontainer/container-network.sh start` repair needs privileged Docker access;
use it only for the workerd reverse-path filtering problem described in that file.

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
