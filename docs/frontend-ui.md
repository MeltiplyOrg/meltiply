# Shared UI ownership and reuse

Meltiply uses the Gr8r-adapted warm workspace system. [Product UI conventions](../PRODUCT.md#modular-consistent-surfaces) define behavior; [layout conventions](frontend-layout.md) define geometry. The reference is [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio), inspected at `904205c626918ee96054eb35495c394a60c0c601`. Source reuse was authorized for this redesign; its public repository has no general-purpose license grant. Do not treat that authorization as a license for unrelated third-party reuse.

## Ownership

[`@meltiply/ui`](../frontend/shared/package.json) is the canonical UI workspace.
Read its explicit exports, implementation, and an existing caller before
changing a control.

| Responsibility                                                             | Owner                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| Shared palette, Geist fonts, compact type/space/radius/shadow tokens       | `frontend/shared/tokens.css`                            |
| Buttons, inputs, menus, dialogs, feedback, cards, tables, tabs, and badges | `frontend/shared/src/components/ui`                     |
| Shared selection, status, and navigation atoms                             | `frontend/shared/src/components/atoms` and `primitives` |
| Static Astro controls and brand mark                                       | `frontend/shared/src/components/public`                 |
| Theme preference, consent, clipboard, notifications, motion infrastructure | Existing modules in `frontend/shared`                   |
| App navigation, jump search, Settings, Post/Channel data and behavior      | `frontend/app/src/components`                           |
| Documentation tree, article search, reading navigation                     | `frontend/public/src/components`                        |
| Marketing copy and explicitly labeled sample content                       | `frontend/public/src`                                   |

Use explicit subpath imports such as `@meltiply/ui/button` and
`@meltiply/ui/table`. Keep data, product semantics, and accessible labels in
the consuming app; shared controls cannot import app internals. Static Astro
controls stay static. Extend a canonical variant or build a route from shared
primitives rather than duplicating one. The Posts List/Table and Channel
directory share the same `Table`; Posts Board/Grid share `PostCard`; filter
disclosures, search, chips, navigation rows, and view segments are reused.

## React and styling

New or rewritten app React components are TypeScript (`.tsx`) and Tailwind
utilities. Use `cn` to combine caller and state variants; put finite style maps
outside render functions. Shared CSS is reserved for global reset/focus rules,
theme tokens, and browser interop that utility classes cannot express. Do not
add page-specific component selectors, copy long CSS blocks between pages, or
recreate shared controls locally. Public Astro/Fumadocs adapters remain within
their framework and resolve the same shared palette tokens.

## Visual language

- Flat warm page and stone rail, white light-theme surfaces, layered warm charcoal in dark mode. No striped background or separate marketing palette.
- Indigo primary actions and focus, neutral navigation selections, labeled semantic status colors. Provider identity remains in `PlatformIcon`.
- Self-hosted Geist for UI, Geist Mono for code and shortcut hints. Primary titles are compact semibold, not oversized display typography.
- One border per surface. Use `rounded-chip/control/card/window` and named elevation tokens. Avoid rings stacked on an already bordered card.
- Interface glyphs use `lucide-react` with a consistent 1.8px stroke and 16px default size. Keep Meltiply's faceted brand mark; do not transplant Gr8r's logo or avatars.

Use semantic Tailwind utilities: `bg-page`, `bg-canvas`, `bg-surface`,
`text-ink`, `text-ink-2`, `text-ink-3`, `border-line`, and the compact `text-ui`,
`text-control`, and `text-micro` scales. Exact values belong in shared tokens,
not inline CSS or page-specific values.

## Navigation and search

`SidebarNav` owns the 252px/52px rail, including real workspace destinations,
all five Post collection shortcuts, Brand Profiles, Settings, help, and the
current account actions. `NavigationShell` owns the 46px top bar and responsive
mobile drawer. Destinations derive from `WORKSPACE_NAV_ITEMS`; profile names
and scope come from workspace context. Workspace identity stays read-only.

`WorkspaceSearch` is a jump palette, not a global content index. The sidebar,
top bar, and `hotkeys.commandMenu` open it. It finds supported destinations and
loaded Brand Profiles. Route toolbars own collection search and filters.

## Reference page compositions

Posts reproduces Gr8r Tasks' flush List, counted/collapsible Board, and
spreadsheet Table. Media Grid and Calendar remain supported Meltiply views.
Status/profile grouping preserves Post identity and sorted order; table column
visibility hides metadata only. Board columns report publication outcomes and
never offer fake drag-to-change-status behavior. List, Board, Table, and Grid
share selection and the same real details/edit/delete/create callbacks.

Channels adapts the Members directory to real connected accounts and adds an
Accounts/Brand Profiles switch matching the reference's directory/team split.
Rows retain platform identity, account and profile names, connection health,
copy/reconnect/disconnect/settings actions, and filtered visible-selection
semantics. Profile cards count loaded workspace connections. No seed member,
team, billing, or role editor is copied.

## Settings

`WorkspaceSettings` renders the full `/settings` React route. Its reference-style
section rail exposes only real Appearance, Language, Account, and Security
workflows. Theme and language call existing consent-aware providers; account
details stay read-only; `AccountSecurity` retains password reauthentication,
authenticator enrollment, recovery-code handling, and sign-out behavior.
Never advertise demo billing, team management, notifications, or identity
editing.

## Dialogs and feedback

| Purpose                     | Shared primitive    |
| --------------------------- | ------------------- |
| Focused form or jump search | `CenterDialog`      |
| Destructive confirmation    | `CenterAlertDialog` |
| Large Post inspection       | `SideDialog`        |

Primitives own accessible names, focus trapping, Escape, scroll lock, focus
restoration, and transitions. Keep confirmation content stable; retain data
through exits with `useLatchedValue` when necessary. Route code does not
implement another dialog or add entrance choreography. Immediate navigation
and preference changes are the default; retain reduced-motion support where
the existing interface uses motion.

Transient outcomes use `@meltiply/ui/toast`, rendered by `@meltiply/ui/sileo`.
Pair a headline with the affected object and recovery action. Clipboard feedback
includes the copied value. Inline validation and durable failures remain beside
the controls they affect.

## Public surfaces

Landing and docs import the same palette and fonts. Their layout serves
persuasion and reading respectively; public article search is not app-wide
search. Native scrolling, keyboard navigation, fragments, and reduced-motion
behavior must remain usable. Existing public scroll adapters release state
during Astro navigation.

## Change workflow

1. Read product and layout contracts, shared exports, the matching implementation, and a real caller.
2. Extend the canonical primitive or compose it with route data. New modules need a clear reuse need and canonical ownership.
3. Migrate affected callers and remove replaced definitions, aliases, selectors, and stale instructions.
4. Verify hover, focus-visible, active, disabled, loading, empty, and recoverable-error states, including keyboard use and mobile overflow.
5. Run affected frontend checks and exercise the actual changed surface. Use GitHub-hosted runners unless local verification is explicitly authorized. Passing lint is not visual proof.

## Reference-to-product mapping

| Reference family                                        | Meltiply adaptation                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Workspace rail, top bar, breadcrumbs                    | `SidebarNav`, `NavigationShell`, real workspace/profile context                                      |
| Tasks List, Board, Table, grouping, metadata controls   | Posts List/Board/Table built on shared `Table`, `PostCard`, toolbar, and Post-owned state            |
| Grid and media previews                                 | Meltiply media Grid reuses the same `PostCard` and real attachments                                  |
| Members and Teams directories                           | Connected-account `ChannelTableView` and actual Brand Profile `BrandProfileDirectory`                |
| Command palette                                         | `WorkspaceSearch` over supported destinations and loaded profiles                                    |
| Full Settings navigation                                | `/settings` section rail over Appearance, Language, read-only Account, and Security                  |
| Buttons, fields, selects, tabs, menus                   | Canonical shared React controls and semantic Tailwind tokens                                         |
| Task drawer and confirmation modals                     | Post `SideDialog`, focused `CenterDialog`, destructive `CenterAlertDialog`                           |
| Auth screens and form states                            | Existing owner sign-in/setup/recovery with the warm palette and compact form language                |
| Empty, loading, error, and notification states          | Shared Empty/Skeleton/Alert/Sileo with real pending/error semantics                                  |
| Glyphs, type, colors, spacing, corners                  | Shared Lucide system, self-hosted Geist, and reference-derived semantic tokens                       |
| Files, timeline, teams, billing, reference seed content | No copied product routes; composer attachments and scheduling stay in supported publishing workflows |
