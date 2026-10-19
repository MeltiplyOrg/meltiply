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
- Core app surfaces: Posts (composition, scheduling, and publishing outcomes),
  Analytics (read-only performance for a published cohort), and Channels
  (Platform accounts and Brand Profiles). Removed capabilities and
  restoration prerequisites are recorded in the
  [frontend capability inventory](docs/frontend-capabilities.md).
- Queue messages are at-least-once deliveries; consumers must stay idempotent,
  back off on transient failures, and route poison pills to DLQs.

## Capabilities and Constraints

- Retained creator workflows: Post composition with composer-owned attachments,
  Platform account connection, Brand Profile organization, scheduled and
  monitored publication, and read-only Analytics over stored provider snapshots.
  Backend comment APIs do not imply an available creator-facing Inbox surface.
  Community resource quotas do not imply subscriptions.
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

Use [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio)'s warm, compact
workspace language across app, landing, and docs. The user selected this visual
world; reference task/team/billing examples do not become Meltiply capabilities.
Keep Meltiply's faceted mark and actual provider identities.

[`frontend/shared/tokens.css`](frontend/shared/tokens.css) owns the implemented
palette, fonts, density, radius, and elevation. Light surfaces are warm white
and stone; dark surfaces are layered warm charcoal. Indigo/periwinkle identifies
actions and focus, neutral paint identifies navigation selection, and semantic
status colors always have labels or accessible icons. Geometry is shared across
palettes rather than redesigned per theme.

### Design Direction

The current interface is a compact publishing workbench: Geist typography,
aligned working edges, quiet selection, thin separators, opaque surfaces, and
clear outcomes. Preserve its established appearance during cleanup; remove
duplicate implementations and obsolete code without substituting another design.

Posts is one sidebar destination with **Table → Calendar → Grid** in its toolbar.
Table is default and uses grouped spreadsheet presentation. Calendar supplies
real Month/Week dates, inspection/day lists, and explicit scheduling entry. Grid
uses real attachments. All views retain Post identity, authorized scope,
selection, and supported actions.

Channels uses the Members-style account directory and actual Brand Profile
cards. Its background and canonical controls match Posts; its directory
composition stays distinct. Connection health is one accessible icon per row,
with recovery beside the affected account.

Settings is a full route with Appearance, Language, read-only Account, and
inline Security. Every section shares one bounded content layout and background.
Light/Dark/System and supported languages use the existing consent-aware owners.
System follows live OS palette changes. Password verification, authenticator
enrollment, and recovery-code handling retain their real security requirements.

Top-bar jump search finds supported pages and loaded Brand Profiles. Collection
toolbars search/filter their own data; profiles are scope rather than sidebar
sections. Workspace identity stays read-only.

#### Calm Workbench

- Lead with Posts, schedules, Channel health, and the next safe action.
- Keep domain state explicit: saving/queuing is not publication, and one Channel's
  result does not overwrite another's.
- Use alignment, spacing, and separators for hierarchy; cards represent objects,
  not layers of decorative framing.
- Preserve unsaved work, selection, and useful focus through recoverable errors.
- Confirm destructive scope and explain that published platform copies remain.

#### Modular, Consistent Surfaces

- [`@meltiply/ui`](frontend/shared) owns canonical controls, tokens, icons,
  dialogs, feedback, consent, and animation recipes. Extend the owner rather than
  cloning controls or page CSS. See [shared UI ownership](docs/frontend-ui.md).
- Rewritten app components use strict TypeScript/React and Tailwind; public
  Astro/Fumadocs adapters share the same tokens within their framework.
- Features own real data, permissions, selection, async outcomes, labels, and
  actions. Reference-only fields and demo flows are not substitutes.
- `CenterDialog` handles focused forms/search, `CenterAlertDialog` handles
  destructive confirmation, and `SideDialog` handles large Post inspection.
  Shared primitives own frames, focus, dismissal, scrolling, and transitions.
- Feedback uses the shared toast store/Sileo renderer. Name the affected object
  and useful recovery; clipboard feedback includes the copied value.
- There is one animation implementation, without a separate motion mode,
  provider, preference state, root flag, or alternate branches. Preserve current
  animations and extend their shared owners when animation work is requested.

#### Visual System

Use the canonical palette, self-hosted Geist/Geist Mono, interface/provider icon
system, compact controls, and named radius/elevation tokens. Apply consistent
surface boundaries and ink hierarchy across routes. Detailed geometry and scroll
ownership live in [the layout contract](docs/frontend-layout.md), not a second
per-page style system.

#### Responsive and Accessible by Default

Preserve the primary task and readable hierarchy from desktop to phone. Keep
controls named, keyboard-operable, visibly focused, and readable with long real
content. Wide collections scroll within their working area; navigation and
Settings remain reachable. Status never relies on color alone.

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
- Never claim provider success before durable confirmation.
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
