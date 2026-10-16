# Meltiply Agent Instructions

This is the repository-wide source of agent instructions for Meltiply. Meltiply
schedules and distributes social media content across platforms using queue-based
serverless primitives, providing analytics, media management, and automations.
Project state and contributor refactoring permissions are governed by root [`STATE.md`](STATE.md).

## Completion gate

Choose verification by affected behavior, not by file count. After implementation:

1. **Compare and reuse**: Reuse established helpers and update affected callers.
2. **Runnable proof**: For behavior changes, exercise the changed path with a focused
   test or smoke command. Docs and comments do not require runtime proof.
3. **Scoped checks**: Run the smallest applicable gate from repository root:

   | Changed area                                                                                            | Required verification                                                                                                              |
   | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
   | Documentation, agent guidance, or comments only                                                         | Format changed files; run `bun run docs:links` when Markdown links, headings, or paths change. No application gates.               |
   | Devcontainer, tool installation, or development configuration only                                      | Validate changed configuration and smoke the affected tool/container. No application gate unless application behavior is affected. |
   | Frontend UI only                                                                                        | Run the affected workspace's check: `bun run --filter frontend-app check` or `bun run --filter frontend-public check`.             |
   | Workers or shared packages only                                                                         | `bun run --filter './packages/*' --filter './workers/*' type-check && bun run --filter './packages/*' --filter './workers/*' test` |
   | OpenAPI contracts only                                                                                  | `bun run contract:check`                                                                                                           |
   | Cross-cutting application changes, migrations, runtime dependencies, or explicitly requested full check | `bun run cloudflare:check`                                                                                                         |

   Select checks for each affected area in mixed changes. A comprehensive gate
   replaces the checks it includes. Reuse passing results while the code/config
   they cover is unchanged; a later docs-only edit does not invalidate them.
   Run documentation-checker tests only when changing the checker. PR creation
   alone does not require repeating gates.

4. **Zero-compromise fixes**: Fix introduced violations directly. Keep strict types,
   zero-warning lint (`vp lint --deny-warnings`), and dead-code elimination (`knip`) intact. Do not
   weaken rules, baselines, or suppress findings merely to pass.
5. **Exact reporting**: In your final response, state the exact commands run and their
   outcomes. A task is complete only when required checks pass and behavior is verified.
   Existing violations, timeouts, or environment failures mean **verification blocked**,
   not passed. Report blockers explicitly with evidence.

### Workstation and process discipline

Run only one resource-intensive test, build, or check at a time. Prefix shell commands
with `rtk` (e.g. `rtk bun run test`, `rtk git status`). On any out-of-memory error,
timeout, or system slowdown, stop heavy operations and report verification blocked;
do not spawn unconstrained background processes.

### Subagent delegation

Work inline in the current agent by default. Spawn subagents only when the user
explicitly requests subagents, delegation, or parallel agent work, or when an
applicable skill explicitly requires subagents for the current workflow step.
Optional skill suggestions, task size, independent work slices, and potential
speedups do not authorize spawning. Choose skills because they match the user's
task, not to obtain delegation permission. Keep any authorized delegation scoped
to the requested work or required skill step; perform the remaining work inline.

## Architecture and runtime

- **Platform**: Cloudflare Workers, Queues, Workflows, Cron Triggers, Durable Objects
  (for coordination), Neon PostgreSQL through Hyperdrive, and R2 storage.
- **Monorepo structure** (Bun workspace):
  - `workers/`: `api` (public HTTP endpoints and webhooks), `automation` (queue
    consumers, scheduled publication, sync jobs), and `state` (OAuth coordination).
  - `packages/`: `contracts` (OpenAPI specs & generated clients), `database`
    (PostgreSQL client, connection pooling, and queries), `domain` (business logic
    and entities), `providers` (social provider adapters), `observability`
    (structured logging & tracing), `secrets`, `storage` (R2 wrappers), and `auth`.
  - `frontend/`: Vite React SPA with Tailwind CSS and `components/ui` (shadcn/ui).
- **Database & migrations**: PostgreSQL schema migrations live in `packages/database/migrations/`.
  Apply them using `./scripts/cloudflare-local/database.sh migrate`. Parameterize all
  SQL queries; never use raw concatenated SQL.
- **Queue & async contracts**: Treat queue messages as at-least-once deliveries.
  Ensure consumers are idempotent, handle transient failures with exponential backoff,
  and route poison pills to Dead Letter Queues (DLQ).
- **Environment**: Node `>=24.0.0 <25`, `Bun 1.4.2`. Keep secrets private; update
  `.env.example` when adding environment bindings.

## Code quality and standards

- Follow **KISS, YAGNI, and DRY**: choose the simplest design that satisfies the
  requirement; build nothing speculative.
- Keep shared helpers in their appropriate boundary: worker-internal in that Worker,
  cross-package in `packages/`, cross-script in `scripts/lib/`.
- Use explicit domain types and narrow untrusted boundary inputs with schemas. Avoid
  `any` or unvalidated assertions.
- Keep provider-specific logic inside `packages/providers` (Facebook, Instagram,
  Threads, TikTok, YouTube). Implement the shared provider interface rather than
  leaking provider-specific branching into generic pipelines.
- Avoid avoidable allocations, repeated computation, unbounded queries, N+1 data
  access, and unhandled promises.

### Frontend consistency

Before changing frontend components, read the [product UI conventions](PRODUCT.md#modular-consistent-surfaces)
and the [shared UI ownership and reuse workflow](docs/frontend-ui.md). Inspect
`frontend/shared/package.json` exports, the matching shared implementation, and
an existing caller before choosing a component. Compose installed
`@meltiply/ui` controls and public Astro components; extend their canonical
implementation when a capability is missing. Keep page content and domain-bound
compositions local. New reusable primitives belong in `frontend/shared`, with
all consumers migrated rather than copied implementations or local re-exports.
Account for every changed control's feedback, motion, focus, and low-motion
behavior; pass the shared ownership gate as well as the affected workspace check.
Dialogs come in exactly two types: `CenterDialog`/`CenterAlertDialog` and `SideDialog`
(see [Dialogs](docs/frontend-ui.md#dialogs)).

### Function comments

- Agents must add or update a comment for every function or method they create or
  change. Place it immediately above the declaration, using the surrounding
  documentation style. Cover small callbacks in the enclosing function's comment
  when they have no independent contract.
- State the purpose and feature requirement the function serves, why it is needed,
  and how its approach achieves that purpose. Explain design choices and
  non-obvious invariants rather than narrating statements.
- Describe the input-to-output contract: meaningful input constraints, units and
  defaults; returned results; and relevant edge cases, errors, side effects, or
  external state. Include a compact input → output example when prose alone leaves
  the transformation ambiguous.
- Keep comments proportional: usually 2–6 concise lines, shorter for simple
  contracts and longer only for necessary behavioral detail. Use names and types
  for structural facts; use comments for semantics a signature cannot express.
  Put local explanations beside complex branches rather than bloating the header.
- Before completing a change, check every affected function's comment against its
  implementation and verified behavior. A maintainer must be able to derive
  representative inputs and expected outputs and identify what a refactor or
  optimization must preserve. Update stale comments in the same change; document
  implemented behavior, not an unfulfilled feature request.

## Commits and Pull Requests

- Use Conventional Commits: `type(scope): imperative description`, under 72 characters,
  no trailing period. Valid types: `feat`, `fix`, `refactor`, `chore`, `ci`, `docs`,
  `test`, `perf`, `style`, `skill`. Never push directly to `master`/`main`.
- **PRs**: Read the [`pr` skill](.agents/skills/pr/SKILL.md) before authoring a PR
  manifest, creating a pull request, or revising one.

## Agent skills

- **Project state**: Consult root [`STATE.md`](STATE.md) before refactoring, altering schemas, or resetting data. Its first line names the active branch: `developing` allows clean-cutover refactors, in-place schema edits, and database wipes; `production` enforces backward compatibility, additive migrations, and zero data loss.
- **Navigation & design**: Use the `codegraph` skill for caller/impact analysis and
  `codebase-design` when shaping module seams or interfaces.
- **Effect v4**: Use the `effectv4` skill when writing or editing Effect programs, services, layers, retries, or error mapping in Workers backend or frontend.

### Issue tracker

Tracked in GitHub Issues (`MeltiplyOrg/meltiply`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical 5-role triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repository layout (`CONTEXT.md` at root and `docs/adr/`). See `docs/agents/domain.md`.
