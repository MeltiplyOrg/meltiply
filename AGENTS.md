# Meltiply agent instructions

Read [STATE.md](STATE.md) before refactors, schema changes, or data resets. It owns
compatibility and migration rules. [CONTEXT.md](CONTEXT.md) owns domain terms,
[PRODUCT.md](PRODUCT.md) product intent, [DESIGN.md](DESIGN.md) the visual system.
Inspect code for current layout.

## Documentation discipline

Documentation states what is true now. It is not a changelog, a design history, or a
record of what you considered.

- **Edit, never append.** Change the sentence that is wrong. Never add a paragraph
  that overrides an earlier one while leaving both in place.
- **Delete what is obsolete.** A doc describing removed behavior, an unmerged branch,
  or a design that shipped differently is deleted, not annotated. A note explaining
  that a later section replaces an earlier one means the earlier section goes.
- **No dated notes.** Nothing like `Implementation note (2026-10-19)`, `revision`,
  or "the shipped branch now". If the fact changed, the text changes; the date is
  noise the next reader pays for.
- **Do not re-narrate code.** If a constant, a file path, or a test already states
  something exactly, the doc does not repeat it. Docs carry decisions, contracts,
  and boundaries a reader would otherwise get wrong; not measurements, class names,
  or step-by-step behavior visible in the source.
- **Prefer deleting a section to rewriting it.** When in doubt, cut. A missing
  explanation is cheaper than a stale one.
- **Fix drift in place.** Encountered a wrong claim while reading? Correct it in the
  same change rather than reporting it.

A change that adds more text than it removes, outside new capability docs, is
suspect. Justify it or cut it.

## Completion gate

Reuse existing helpers, update affected callers, and exercise changed behavior with a
focused test or smoke run. Documentation-only changes need no runtime proof. Run the
smallest applicable check from the repository root:

| Changed area                                                          | Required verification                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Docs, instructions, comments                                          | Format changed files; `bun run docs:links` when links, headings, or paths change.                                                  |
| Devcontainer, tool installation, development configuration            | Validate the configuration and smoke the affected tool/container.                                                                  |
| Frontend UI                                                           | `bun run --filter frontend-app check` or `bun run --filter frontend-public check`.                                                 |
| Workers or shared packages                                            | `bun run --filter './packages/*' --filter './workers/*' type-check && bun run --filter './packages/*' --filter './workers/*' test` |
| OpenAPI contracts                                                     | `bun run contract:check`                                                                                                           |
| Cross-cutting, migrations, runtime dependencies, requested full check | `bun run cloudflare:check`                                                                                                         |

Cover each affected area for mixed changes. Reuse passing results while their
code/config is unchanged; a comprehensive gate replaces the checks it includes. Test
the documentation checker only when changing it. PR creation is not a reason to
rerun checks.

Keep strict types, zero-warning lint, and dead-code checks. Fix introduced findings
directly rather than weakening rules or baselines. Report exact commands and
outcomes; failures, timeouts, and environment errors mean verification is blocked.

Serialize only resource-intensive checks you start manually; leave automatic CI
scheduling unchanged. Cancel, rerun, or alter CI runs only when the user explicitly
requests it. Use GitHub-hosted runners for builds, tests, container smoke runs, and
required verification unless local execution is explicitly requested. Stop manually
started heavy operations on OOM, timeout, or system slowdown. Work inline; delegate
only when the user requests it or an applicable skill explicitly requires it.

## Implementation invariants

- Worker-local helpers stay in their Worker, shared code in `packages/`, shared
  script helpers in `scripts/lib/`. Trace callers before changing shared interfaces.
- Validate untrusted inputs with schemas; use explicit domain types, not `any` or
  unchecked assertions. Parameterize SQL and keep credentials out of source/logs.
  Add new environment bindings to `.env.example`.
- Queue delivery is at least once: preserve idempotency, transient-failure backoff,
  and DLQ handling. Provider-specific behavior stays in `packages/providers`.
- Prefer simple code without speculative abstractions, repeated work, avoidable
  copies/allocations, unbounded queries, N+1 access, or unhandled promises.
- Document each new or changed function above its declaration: purpose, input/output
  constraints and defaults, effects/errors, non-obvious invariants. Explain the
  approach, not the statements. Keep comments proportional, cover callbacks in their
  enclosing contract, and update comments when behavior changes.

## Conditional guidance

- **Frontend:** read [product UI intent](PRODUCT.md#modular-consistent-surfaces),
  [shared ownership](docs/frontend-ui.md), [layout](docs/frontend-layout.md), and the
  [capability inventory](docs/frontend-capabilities.md) for the affected flow. Treat
  the current Gr8r-adapted components as visual truth. Inspect
  `frontend/shared/package.json` exports and a real caller; extend the canonical
  TypeScript/React/Tailwind control instead of copying components or page CSS. Keep
  feature data, authorization, selection, async outcomes, and labels in their owning
  feature. Preserve keyboard focus, mobile access, and the existing animation
  implementation; there is one path, without motion-mode state or mode-specific
  guards. Use `CenterDialog`, `CenterAlertDialog`, or `SideDialog` for their
  documented purposes. Migrate callers and public guides together, then exercise the
  changed UI in both palettes and at desktop/phone widths.
- **Effect programs:** use the `effectv4` skill for services, layers, retries, and
  error mapping. Use `codebase-design` when shaping module interfaces.
- **Skills:** pack-managed skills come from `Essential-kit/skills`; run
  `bun run skills:sync` after changing the pinned ref. See
  [agent skills](docs/agents/skills.md) before editing `.agents/skills/`.
- **PRs:** use the [pr skill](.agents/skills/pr/SKILL.md) to author or revise a PR.
  Use native `gh` with a Markdown body; submit only when asked and checks pass.
- **Commits:** Conventional Commits, imperative subject under 72 characters, no
  trailing period. Never push directly to `master`/`main`.
- **Issues:** infer the repository from the Git remote; see the
  [issue workflow](docs/agents/issue-tracker.md) and
  [triage labels](docs/agents/triage-labels.md).
- **Domain records:** root `CONTEXT.md` and `docs/adr/`; see
  [domain documentation](docs/agents/domain.md).
