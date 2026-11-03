# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Creators compose Posts with their media, connect Platform accounts, and schedule and
monitor publication within one Workspace.

## Product Purpose

Meltiply is a dependable multi-platform publishing workspace. Success means a creator
can understand what is ready, what is in progress, what failed, and what action is safe
to take next without learning the backend architecture or guessing whether a provider
operation succeeded.

## Positioning

Meltiply is queue-native distribution infrastructure. Every publish runs through
durable queues, workflows, and scheduled triggers with idempotent consumers,
exponential backoff, and dead-letter routing, and the guarantee is the product's
mechanism rather than an implementation detail — a direct-post scheduler cannot
truthfully claim the same retries, recovery, and auditability.

Publishing is immediate when a creator chooses Now; Cron and scheduled triggers are
what start deferred work. The managed deployment implements delivery with Cloudflare
Queues, Workflows, and Cron Triggers; the self-hosted deployment implements the same
contract with documented local equivalents. Neither target is part of the guarantee.

## Operating Context

- Runs on Cloudflare Workers, Queues, Workflows, Cron Triggers, and Durable Objects,
  with Neon PostgreSQL through Hyperdrive and R2 storage.
- Multi-tenant workspaces contain Brand Profiles — brand-scoped groups of connected
  provider channels (Facebook, Instagram, Threads, TikTok, YouTube).
- Core surfaces: Posts (composition, scheduling, publishing outcomes), Analytics
  (read-only performance for a published cohort), Channels (Platform accounts and Brand
  Profiles). Removed capabilities are recorded in the
  [frontend capability inventory](docs/frontend-capabilities.md).
- Queue messages are at-least-once: consumers stay idempotent, back off on transient
  failures, and route poison pills to DLQs.

## Capabilities and Constraints

- Retained creator workflows: Post composition with composer-owned attachments, Platform
  account connection, Brand Profile organization, scheduled and monitored publication,
  and read-only Analytics over stored provider snapshots. Backend comment APIs do not
  imply a creator-facing Inbox. Community deployments have unrestricted resource
  allowances and their administrators own capacity and costs; quota enforcement is
  retained for bounded hosted policies.
- Provider-specific logic stays inside `packages/providers` behind the shared provider
  interface; generic pipelines never branch on provider identity.
- All SQL is parameterized; schema migrations live in `packages/database/migrations/`.
- Terminology: workspace (tenant boundary), Brand Profile (brand-scoped channel group),
  channel (connected provider account), post (a durable composition; a draft is a post
  state), distribution (one post's intent to publish to one channel).

## Brand Commitments

### Personality

Focused, calm, exact, and candid. Meltiply should feel like a dependable workbench:
quiet enough for daily use, structured enough for complex publishing work, direct enough
that users always understand what happened and what to do next.

### Visual World

Use [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio)'s warm, compact workspace
language across app, landing, and docs. The user selected this visual world;
reference task/team/billing examples do not become Meltiply capabilities. Keep
Meltiply's faceted mark and actual provider identities.

[`frontend/shared/tokens.css`](frontend/shared/tokens.css) owns the implemented palette,
fonts, density, radius, and elevation. For rules that govern implementation, see
[the visual system](DESIGN.md), [shared UI ownership](docs/frontend-ui.md), and
[layout](docs/frontend-layout.md); this document owns intent only.

#### Calm Workbench

- Lead with Posts, schedules, Channel health, and the next safe action.
- Keep domain state explicit: saving or queuing is not publication, and one Channel's
  result never overwrites another's.
- Use alignment, spacing, and separators for hierarchy; cards represent objects, not
  layers of decorative framing.
- Preserve unsaved work, selection, and useful focus through recoverable errors.
- Confirm destructive scope and explain that published platform copies remain.

#### Modular, Consistent Surfaces

- [`@meltiply/ui`](frontend/shared) owns canonical controls, tokens, icons, dialogs,
  feedback, consent, and animation recipes. Extend the owner rather than cloning
  controls or page CSS.
- Features own real data, permissions, selection, async outcomes, labels, and actions.
  Reference-only fields and demo flows are not substitutes.
- There is one animation implementation, without a separate motion mode, provider,
  preference state, or alternate branch.

#### Responsive and Accessible by Default

Preserve the primary task and readable hierarchy from desktop to phone. Keep controls
named, keyboard-operable, visibly focused, and readable with long real content. Wide
collections scroll within their working area; navigation and Settings stay reachable.
Status never relies on color alone.

## Evidence on Hand

- Design tokens and theme: `frontend/shared/tokens.css`.
- Components: shared icons and motion in `frontend/shared/`; app views in
  `frontend/app/src/components/`.
- Faceted logo variants: `frontend/app/public/media/logo-on-light.svg` and
  `logo-on-dark.svg`, recolored to the app token palette.
- No testimonials, case studies, press, or customer benchmarks exist. Do not fabricate them.

## Product Principles

- Make state and the next safe action obvious.
- Preserve user intent across recoverable failures.
- Never claim provider success before durable confirmation.
- Keep dense operational information calm, readable, and support-friendly.
- Pull complexity below the interface; expose it progressively when context makes it useful.

## Anti-references

- Generic SaaS dashboards that hide state behind decorative cards.
- Provider workflows that invent optimistic success or conceal partial support.
- Loud or playful error treatments that compete with the recovery action.
- Cloud architecture terminology in user-facing product copy.

## Accessibility & Inclusion

Touched product flows must support keyboard navigation, screen readers, visible focus,
sufficient contrast, responsive layouts, and reduced motion. Status must never rely on
color alone, and error details must remain useful without exposing sensitive payloads.
