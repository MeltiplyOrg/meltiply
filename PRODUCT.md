# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Creators use Meltiply to compose Posts with their media, connect Platform
accounts, and schedule and monitor publication within one Workspace.

## Product Purpose

Meltiply is a dependable multi-platform publishing workspace. Success means a
creator can understand what is ready, what is in progress, what failed, and
what action is safe to take next without learning the backend architecture or
guessing whether a provider operation succeeded.

## Positioning

Meltiply is queue-native distribution infrastructure: every publish runs
through durable Cloudflare Queues, Workflows, and Cron Triggers with
idempotent consumers, exponential backoff, and dead-letter routing. A
direct-post scheduler cannot truthfully claim the same delivery semantics —
retries, recovery, and auditability are the product's mechanism, not an
implementation detail.

## Operating Context

- The workspace runs on Cloudflare Workers, Queues, Workflows, Cron Triggers,
  and Durable Objects, with Neon PostgreSQL through Hyperdrive and R2 storage.
- Work is organized into multi-tenant workspaces containing Brand Profiles —
  brand-scoped groups of connected provider channels (Facebook, Instagram,
  Threads, TikTok, YouTube).
- Core app surfaces: Posts (composition, scheduling, and publishing outcomes)
  and Channels (Platform accounts and Brand Profiles). Removed capabilities and
  restoration prerequisites are recorded in the
  [frontend capability inventory](docs/frontend-capabilities.md).
- Queue messages are at-least-once deliveries; consumers must stay idempotent,
  back off on transient failures, and route poison pills to DLQs.

## Capabilities and Constraints

- Retained creator workflows: Post composition with composer-owned attachments,
  Platform account connection, Brand Profile organization, and scheduled and
  monitored publication. Backend analytics, comments, and billing capabilities
  do not imply available creator-facing app surfaces.
- Provider-specific logic stays inside `packages/providers` behind the shared
  provider interface; generic pipelines never branch on provider identity.
- All SQL is parameterized; schema migrations live in
  `packages/database/migrations/`.
- Terminology: workspace (tenant boundary), Brand Profile (brand-scoped
  channel group), channel (connected provider account), post (a durable
  composition; a draft is a post state), distribution (one post's intent to
  publish to one channel).

## Brand Commitments

### Personality

Focused, calm, exact, and candid. Meltiply should feel like a dependable
workbench: quiet enough for daily use, structured enough for complex publishing
work, and direct enough that users always understand what happened and what to
do next.

### Palette

The current application design system is authoritative for all Meltiply surfaces,
including the landing page. Use the semantic OKLCH tokens in
[`frontend/shared/tokens.css`](frontend/shared/tokens.css) — imported by both
`frontend/app/src/app/globals.css` and `frontend/public/src/styles/global.css` —
not a separate marketing palette. That stylesheet owns the exact light/dark
values, texture, radii, elevation, and the shadcn-aligned aliases that the app's
`@theme inline` block maps onto Tailwind utilities.

| Token family                                            | Role                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `--page`, `--canvas`, `--surface`, `--inset`, `--field` | Cool neutral backgrounds and layered surfaces                         |
| `--ink`, `--ink-2`, `--ink-3`                           | Primary text, secondary copy, and subdued metadata                    |
| `--line`, `--line-strong`, `--line-soft`                | Hairline boundaries and structural separators                         |
| `--accent`, `--accent-ink`, `--accent-tint`             | Restrained blue accent, readable accent text, and selected-state tint |
| `--green*`, `--orange*`, `--red*`                       | Semantic success, warning, and error states                           |
| `--stripe-bg`, `--stripe`                               | Fixed diagonal canvas texture                                         |

Light mode uses a cool near-white canvas and white surfaces; dark mode uses
layered neutral surfaces with the same geometry. Primary filled controls use the
neutral ink/surface pairing. Blue supports focus and intentional accents; orange
is a semantic warning color, not a primary brand or CTA color. Provider colors
identify external platforms, never product state.

### Design Direction

Follow the installed application UI rather than the retired industrial palette
or a separate brand concept. The visual references are the
[`@meltiply/ui` shared workspace](frontend/shared) and its application callers in
[`frontend/app/src/components`](frontend/app/src/components). Follow the
[shared UI ownership workflow](docs/frontend-ui.md) and reuse its component vocabulary and interaction
patterns. Preserve the faceted Meltiply logo geometry: the main mark uses
`--ink` and the small center diamond uses `--accent`, adapting to light and dark
themes. The logo does not retain the retired industrial palette.

Theme changes share a masked ink reveal across the app and landing. Light to
dark expands in 1.2 seconds; every shrink toward light takes 0.6 seconds,
including reversal of an unfinished expansion. Each retarget starts from the
current coverage without replacing the mask or jumping its edge.
The theme button's center anchors both pointer and keyboard activation.
Withdrawal begins at the visible viewport boundary, not the document's bottom.
The round ink silhouette retains fluid lobes, with stronger lower ripples on
withdrawal, no directional stretching, feathering, or palette interpolation.
One inert, target-themed full-document copy follows window and nested scrolling;
fixed and sticky controls stay aligned. The mask's origin and silhouette remain
document-anchored, so scrolling reveals real below-fold content rather than a
stretched viewport snapshot. Repeated activation reverses or continues the same
mask. Live controls retain identity, focus, and input; the palette commits only
at the final endpoint, without staggered component color delays. Manual or
device-requested low motion uses a 200ms opacity blink with a 100ms theme commit.

`frontend/shared/` owns the tokens, animated SVG icons, motion preferences, effect
timings, and theme transition. React controls and native landing controls reuse
these implementations rather than maintaining parallel animations. Landing
content remains static HTML; decorative icon islands hydrate only when idle or
visible, with their geometry reserved before JavaScript runs.

#### Calm Workbench

- Lead with the user's posts, schedule, distribution state, and next safe action.
- Prefer one clear primary action over a field of competing buttons.
- Use whitespace, alignment, and hierarchy to reduce cognitive load; do not use
  decorative cards, gradients, or motion to manufacture importance.
- Keep product language concise, concrete, and honest about partial or pending
  work.

#### Modular, Consistent Surfaces

- Treat posts, distributions, comments, platform accounts, and usage records as
  consistent content units with predictable states and actions.
- Reuse the same spacing, control shapes, status treatment, and interaction rules
  across routes. Consistency is more valuable than novelty.
- Prefer existing primitives and composed patterns over one-off route-specific
  widgets.
- **Modal motion:** centered dialogs and confirmations use a bottom-up entrance and
  downward exit with fixed horizontal position; the side dialog slides in from and
  out to the right edge. Preserve each surface's resting geometry, and honor the
  shared low-motion preference.
- **Action feedback:** use the shared Sileo notification store (`@meltiply/ui/toast`,
  rendered by `@meltiply/ui/sileo`). All transient notifications appear bottom-right and expand upward.
  Pair an outcome headline with meaningful expandable detail: the affected object,
  copied value, or recovery action. Clipboard confirmations explicitly name the
  completed copy action and include the exact value, rather than bare profile text.

#### Progressive Disclosure

- Show the essential state and next action first; reveal provider constraints,
  technical detail, and secondary controls when they become relevant.
- Keep advanced options available without making first-use screens feel like
  configuration panels.
- Use inline expansion, contextual panels, and focused dialogs before sending a
  user away from the work they are doing.

#### Context and Flow

- Actions should be placed beside the object they affect and labeled with their
  real outcome.
- Preserve filters, selections, drafts, and user intent across recoverable
  errors and navigation within a workflow.
- Keep related work in one workspace so users do not need to reconstruct context
  across disconnected screens.
- Use fast, reversible interactions for small changes; reserve confirmation for
  destructive or externally consequential actions.

#### Visual System

- Use the app's system sans-serif hierarchy and three-step ink ramp. Create
  emphasis with contrast, weight, and spacing rather than ornamental typography.
- Use cool neutral surfaces, crisp hairline boundaries, and restrained layered
  shadows. The fixed diagonal stripe texture belongs on the background canvas,
  not inside controls or content.
- Preserve the application radius scale: 6px chips, 8px controls, 10px cards,
  and 14px windows. Use the named shadow tokens for elevation.
- Reuse installed shared shadcn/Radix controls and generic patterns from
  `@meltiply/ui` before introducing custom equivalents. Public-site components
  share static Astro implementations without shipping the React application runtime.
- Match light and dark themes without changing geometry. Keep semantic status
  colors distinct from the blue accent and pair status with text or icons.
- Keep focusable controls mounted during state changes. When label changes
  resize adjacent controls, use the installed Motion layout and label transitions
  to preserve spatial continuity and keyboard focus.
- Motion should clarify state and provide tactile feedback. Respect reduced
  motion; avoid decorative animation that competes with the work.

#### Responsive and Accessible by Default

- Preserve the primary task and readable hierarchy from desktop to mobile rather
  than shrinking every control into a dense layout.
- Use semantic controls, visible focus, sufficient contrast, keyboard navigation,
  and screen-reader announcements as part of the design—not as a later pass.
- Never communicate state through color alone; pair color with text, icons,
  labels, or structure.

## Evidence on Hand

- Current design tokens and theme: `frontend/shared/tokens.css`.
- Current components: shared icons and motion in `frontend/shared/`; app views in
  `frontend/app/src/components/`.
- Faceted logo variants: `frontend/app/public/media/logo-on-light.svg` and
  `frontend/app/public/media/logo-on-dark.svg`, recolored to the app token palette.
- Product and agent documentation under `docs/`; domain model in `CONTEXT.md`
  and ADRs in `docs/adr/`.
- No testimonials, case studies, press, or customer benchmarks exist. Future
  work must not fabricate them.

## Product Principles

- Make state and the next safe action obvious.
- Preserve user intent across recoverable failures.
- Never claim provider or billing success before durable confirmation.
- Keep dense operational information calm, readable, and support-friendly.
- Pull complexity below the interface; expose it progressively when context makes
  it useful.

## Anti-references

- Generic SaaS dashboards that hide state behind decorative cards.
- Provider workflows that invent optimistic success or conceal partial support.
- Loud or playful error treatments that compete with the recovery action.
- Cloud architecture terminology in user-facing product copy.

## Accessibility & Inclusion

Touched product flows must support keyboard navigation, screen readers, visible
focus, sufficient contrast, responsive layouts, and reduced motion. Status must
never rely on color alone, and error details must remain useful without exposing
sensitive payloads.
