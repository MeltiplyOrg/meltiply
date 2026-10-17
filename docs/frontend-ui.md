# Shared UI ownership and reuse

Meltiply uses the Gr8r-adapted warm workspace system. [Product UI conventions](../PRODUCT.md#modular-consistent-surfaces) define behavior; [layout conventions](frontend-layout.md) define geometry. The reference is [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio), inspected at `904205c626918ee96054eb35495c394a60c0c601`. Source reuse was authorized for this redesign; its public repository has no general-purpose license grant. Do not treat that authorization as a license for unrelated third-party reuse.

## Ownership

[`@meltiply/ui`](../frontend/shared/package.json) is the canonical UI workspace. Read its exports, implementation, and an existing caller before changing controls.

| Responsibility                                                              | Owner                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Warm light/dark palette, Geist fonts, radii, shadows                        | `frontend/shared/tokens.css`                            |
| Buttons, inputs, menus, dialogs, feedback, and other generic React controls | `frontend/shared/src/components/ui`                     |
| Shared composed patterns                                                    | `frontend/shared/src/components/atoms` and `primitives` |
| Static Astro controls and brand mark                                        | `frontend/shared/src/components/public`                 |
| Theme preference, consent, clipboard, notifications, motion infrastructure  | Existing modules in `frontend/shared`                   |
| App navigation, jump search, settings composition, publishing state         | `frontend/app/src/components`                           |
| Documentation tree, article search, reading navigation                      | `frontend/public/src/components`                        |
| Marketing copy and explicitly labeled sample content                        | `frontend/public/src`                                   |

Import explicit subpaths such as `@meltiply/ui/button`. Keep business state and labels in the consuming app; shared controls cannot import app internals. Static Astro controls stay static rather than hydrating React to render a link or icon. Extend an existing variant before adding a module or a local lookalike.

## Visual language

- Flat warm page and stone rail, white light-theme surfaces, layered warm charcoal in dark mode. No striped background or separate marketing palette.
- Indigo primary actions and focus, neutral navigation selections, labeled semantic status colors. Provider identity remains in `PlatformIcon`.
- Self-hosted Geist for UI, Geist Mono for code and shortcut hints. Primary titles are compact semibold, not oversized display typography.
- One border per surface. Use `rounded-chip/control/card/window` and named elevation tokens. Avoid rings stacked on an already bordered card.
- Interface glyphs use `lucide-react` with consistent stroke and size across app, docs, and landing. Keep Meltiply's faceted brand mark; do not transplant Gr8r's logo or avatars.

Use semantic utilities: `bg-page`, `bg-canvas`, `bg-surface`, `text-ink`, `text-ink-2`, `text-ink-3`, `border-line`, `bg-primary`, and `text-primary-foreground`. Exact values belong in the shared tokens, not page-level utility palettes.

## Navigation and search

`SidebarNav` owns the 252px/52px rail. `NavigationShell` owns the persistent top bar and responsive drawer. Their Posts/Channels destinations derive from `WORKSPACE_NAV_ITEMS`. Brand Profiles come from the real workspace context, not reference seed data. Workspace identity is read-only.

`WorkspaceSearch` is a jump palette, not a global content index. The sidebar, top bar, and `hotkeys.commandMenu` open it. It finds supported destinations and loaded Brand Profiles. Route toolbars own collection text search and filters. Keep the shortcut and hint in `lib/hotkeys.ts` rather than hardcoding platform-specific key names.

## Settings

`WorkspaceSettings` composes existing shared dialogs and tabs into Appearance, Account, and Security. Theme cards call the consent-aware theme provider. Account details are read-only. `AccountSecurity` retains password reauthentication, pending authenticator enrollment, recovery-code handling, and sign-out semantics. Both desktop and mobile expose Settings; no `/settings` administration route is implied.

Do not restore demo billing, team management, notification preferences, or unsupported identity editing. [Capability inventory](frontend-capabilities.md) remains authoritative for feature availability.

## Dialogs and feedback

| Purpose                                | Shared primitive    |
| -------------------------------------- | ------------------- |
| Focused form, settings, or jump search | `CenterDialog`      |
| Destructive confirmation               | `CenterAlertDialog` |
| Large Post inspection                  | `SideDialog`        |

Primitives own accessible names, focus trapping, Escape, scroll lock, focus restoration, and transitions. Keep confirmation content stable; retain data through exits with `useLatchedValue` when a primitive needs it. Route code does not implement another dialog or add entrance choreography. Immediate navigation and palette updates are the publishing default; honor the effective reduced-motion state in retained animated surfaces.

Transient outcomes use `@meltiply/ui/toast`, rendered by `@meltiply/ui/sileo`. Pair a headline with the affected object and recovery action. Clipboard feedback includes the copied value. Inline validation and durable failures remain beside the controls they affect.

## Public surfaces

Landing and docs import the same palette and fonts. Their layout serves persuasion and reading respectively; they do not pretend to be authenticated workspace screens. Public article search remains a documentation index. Native scrolling, keyboard navigation, fragments, and reduced-motion behavior must remain usable. Existing public scroll adapters must release state during Astro navigation.

## Change workflow

1. Read the product and layout contracts, shared exports, matching implementation, and a real caller.
2. Extend the canonical primitive or compose it with route data. New shared modules require an explicit ownership decision and approval.
3. Migrate all affected callers and remove replaced definitions, aliases, and stale instructions.
4. Verify hover, focus-visible, active, disabled, loading, empty, and recoverable-error states, including keyboard use and mobile overflow.
5. Run affected frontend checks and exercise the actual changed surface. Use GitHub-hosted runners unless local verification is explicitly authorized. Passing lint is not visual proof.

## Reference-to-product mapping

| Reference family                                            | Meltiply adaptation                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace rail, top bar, breadcrumbs                        | `SidebarNav`, `NavigationShell`, real workspace/profile context                                   |
| Projects and nested task views                              | Brand Profiles and Posts List/Grid/Calendar shortcuts                                             |
| Command palette                                             | `WorkspaceSearch` over supported destinations and loaded profiles                                 |
| Appearance/account settings                                 | `WorkspaceSettings` plus existing `AccountSecurity`                                               |
| Buttons, text fields, selects, tabs, menus                  | Canonical shared Radix controls with compact tokens and accent intent                             |
| Lists, tables, board cards, calendar cells                  | Existing Post and Channel collections; their API data and actions stay intact                     |
| Task drawer and confirmation modals                         | Post `SideDialog`, focused `CenterDialog`, destructive `CenterAlertDialog`                        |
| Auth screens and form states                                | Existing owner sign-in/setup/recovery with the warm palette and compact form language             |
| Empty, loading, error, and notification states              | Shared Empty/Skeleton/Alert/Sileo with real pending/error semantics                               |
| Lucide glyphs, type, colors, spacing, corners               | Shared Lucide system, self-hosted Geist, and reference-derived semantic tokens                    |
| Files, timeline, teams, billing, and reference seed content | No copied product routes; composer attachments and scheduling remain in their supported workflows |

The mapping transfers the complete applicable interface vocabulary without
introducing nonfunctional copies of reference-only features.
