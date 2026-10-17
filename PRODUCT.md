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
  monitored publication. Backend analytics and comment APIs do not imply
  available creator-facing app surfaces. Community resource quotas do not imply subscriptions.
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

Adopt [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio)'s warm, compact
workspace language across the application, landing, and documentation. Source
reuse was authorized for this redesign. The reference's project-management demo
is visual material, not a source of Meltiply product capabilities.

[`frontend/shared/tokens.css`](frontend/shared/tokens.css) owns all palette,
font, radius, and elevation values. React utilities and static Astro styles
resolve through these semantic tokens; pages do not maintain separate palettes.

| Role         | Light                    | Dark                    |
| ------------ | ------------------------ | ----------------------- |
| Page         | Warm off-white `#fbfaf8` | Warm charcoal `#1a1a19` |
| Sidebar      | Stone `#f4f3f0`          | Deep charcoal `#151514` |
| Surface      | White `#ffffff`          | Charcoal `#1d1d1c`      |
| Primary text | `#1d1c1a`                | `#eceae5`               |
| Accent       | Indigo `#4b5bd6`         | Periwinkle `#8e9af3`    |

Primary actions use the accent with the theme's contrasting `--on-accent`.
Green means confirmed success, amber means attention, and red means failure or
destruction. State always includes a label or icon. Platform colors identify
external providers only.

### Design Direction

The visual contract is a calm, warm workbench: Geist typography, thin stone
separators, compact controls, quiet selected rows, and aligned working surfaces.
Keep Meltiply's faceted brand mark and real publishing terminology. Replace
Gr8r's Projects with Brand Profiles and its task views with Posts; do not copy
its seed content, branding, billing, notifications, or collaboration claims.

The 252px sidebar collapses to 52px; a 46px top bar holds workspace context,
route title, and jump search. Posts is one sidebar destination without nested
view shortcuts. Its page toolbar offers exactly Table, Grid, and Calendar;
Table is the default. Table uses counted, collapsible status/profile groups and
metadata visibility controls. All views retain real Post selection and supported
inspect/edit/delete/create actions. Channels follows Gr8r Members' centered
directory with underline tabs, search/status segments, inset identity table,
icon-only health controls, and real Brand Profile cards. Its background and shared controls
match Posts; domain-specific page structure stays distinct.
Reference task seed records and unsupported project-management actions never
become publishing capabilities.

Route headings, toolbar rows, tables, cards, and directory own their reference
gutters and scroll regions. Table reaches workspace edges with first-cell
gutters; Grid owns its content padding; Channels remains centered to a 1200px
maximum. On phones, gutters are 16px, toolbar controls wrap, and directory
tables may scroll horizontally without clipping available actions.

`/settings` is a full-height, reference-style Settings page with responsive
section navigation. Appearance changes the real light/dark palette; Language
uses the existing supported locales; account identity is read-only; Security
uses the existing password-reauthenticated controls. This route adds no billing,
team administration, notification, or unsupported preference capabilities.

Search/jump opens only from the top bar or platform-correct Command/Control
shortcut. The sidebar contains no duplicate Search or Brand Profiles section.
Jump search finds supported destinations and loaded profiles; Posts and Channels
own collection search and Brand Profile filters without claiming unloaded data.

#### Calm Workbench

- Lead with posts, schedules, channel health, and the next safe action.
- Use one accent-filled primary action; secondary controls are outlined or quiet.
- Separate page sections with alignment, whitespace, or hairlines. Cards represent
  objects and independent panels, not layers of decorative containers.
- Show actual pending and failed outcomes. Saving a draft is not publication.
- Preserve user input, selection, and focus through navigation and recoverable errors.

#### Modular, Consistent Surfaces

- [`@meltiply/ui`](frontend/shared) owns reusable controls, theme tokens, icons,
  consent, and notifications. Extend its canonical implementation instead of
  cloning a primitive in route code. Follow [shared UI ownership](docs/frontend-ui.md).
- Use the same compact control shapes, typography, status treatment, and focus
  rules on every route. Geometry is theme-independent.
- Dialogs use `CenterDialog`, destructive confirmations use `CenterAlertDialog`,
  and large inspection surfaces use `SideDialog`. Shared primitives own focus,
  dismissal, scroll lock, and content retention.
- Feedback uses the shared `@meltiply/ui/toast` store and `@meltiply/ui/sileo`
  renderer. Include the affected object and a useful recovery action; clipboard
  feedback includes the exact copied value.
- Keep provider-specific settings beside the Channel or Post they affect.
  Progressive disclosure must not hide the primary state or recovery action.

#### Visual System

- Geist is the interface face; Geist Mono is for code, identifiers, and shortcut
  hints. Both are self-hosted through the shared workspace.
- Titles are 23px semibold; working text is around 13.5px; secondary labels are
  12px. Use the three-step ink ramp, not arbitrary opacity for essential copy.
- Desktop controls use the reference's 30px standard height and 26px small
  variant. Mobile navigation and important touch controls stay comfortably tappable.
- Radii: 4px chips, 6px controls, 8px cards, 10px dialogs. Use a border or the
  named elevation treatment without stacking duplicate hairline rings.
- Backgrounds are flat warm surfaces. The retired diagonal stripe canvas is not
  part of this system.
- Navigation, page titles, and theme selection update immediately. Keep retained
  transitions bounded and reduced-motion-safe; do not add staggered text,
  decorative icon travel, or theme ink reveals to the publishing workflow.
- Light/dark preferences share the consent-aware owner across app and public
  surfaces. A current-page choice works without optional persistence.

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
