---
name: frontend-design
description: Build or restyle Meltiply UI (React app, Astro landing/docs) with the shared design system. Use for views, components, styling, motion, or dialogs. Enforces reuse-first sourcing; new shared components require user approval.
---

# Frontend Design

> Modified for Meltiply from historical Anthropic frontend-design guidance.
> Original upstream material retains [Apache-2.0](../../../LICENSES/anthropic-frontend-design.txt);
> see [third-party notices](../../../THIRD_PARTY_NOTICES.md).

Meltiply's design system is the `@meltiply/ui` workspace (`frontend/shared`): tokens
in `tokens.css`, React controls under `src/components/ui|atoms|primitives`, static
Astro pieces under `src/components/public`. Ownership, import rules, and lint
enforcement live in [docs/frontend-ui.md](../../../docs/frontend-ui.md) — read it
before changing component ownership.

## Workflow

1. **Search before writing.** List `frontend/shared/package.json` exports and grep
   `frontend/app/src/components` for the component's purpose before writing any UI
   file. A matching existing component or variant → use it. This step has no
   exception; duplication is the failure this skill exists to prevent.
2. **Extend the canonical file.** A missing variant, size, or prop extends the
   shared component it belongs to — same file, same export. A fork under another
   name or a lookalike rewritten in page code is a defect, not a shortcut.
   `no-canonical-ui-clones` lints known clones; unknown ones are still banned.
3. **New shared component → ask the user first.** Anything added to
   `frontend/shared` (including `bunx shadcn` output, which generates into it)
   becomes a dependency of every surface. Propose name, props, and why existing
   components cannot express it; get a yes before writing it. App-bound code that
   only wraps a shared component with data or labels lives in `frontend/app` and
   needs no approval.
4. **External sourcing, only when asked or nothing fits.** Permissive licenses
   only; restyle onto tokens; the ask-user gate still applies to shared output.
5. **Compose with tokens.** Semantic utilities only: `bg-surface`, `text-ink`,
   `text-ink-2/3`, `border-line`, `rounded-card/control/chip/window`,
   `shadow-card/overlay`. Raw palette utilities (`bg-blue-500`) and provider
   brand colors leak banned by lint; render identity through `PlatformIcon`.
   Token values and dark-mode pairs: [theme-monochrome.md](theme-monochrome.md).
6. **Ship motion and states the system already owns.** Controls get
   hover/focus/active/disabled from the shared class contract; dialogs are
   exactly `CenterDialog`, `CenterAlertDialog`, or `SideDialog`; data-driven
   dialogs hold content through exit with `useLatchedValue`; spatial changes
   morph via `layout`/`LayoutGroup`, not unmount. Patterns:
   [clean-interactions.md](clean-interactions.md). Honor `useMotionPreference`/
   low-motion variants — lint enforces them on animated surfaces.

## Completion criteria

- [ ] Zero new component files when an existing one (or its variant) covered the
      case; every file created has user approval recorded.
- [ ] Every shared surface uses tokens — no raw colors, no copied implementations.
- [ ] Each new/changed control carries hover, focus-visible, active, and
      disabled states plus a low-motion fallback.
- [ ] `bun run --filter frontend-app check` (and the surface's own check) green;
      changed surface exercised in a real browser.
