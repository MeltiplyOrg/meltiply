# Frontend layout contract

This document owns layout and scroll boundaries for the current Gr8r-adapted interface. Use [shared UI ownership](frontend-ui.md) for implementation seams and [product conventions](../PRODUCT.md#modular-consistent-surfaces) for supported behavior. Exact shared values come from [`tokens.css`](../frontend/shared/tokens.css), not a parallel page theme.

## Workspace shell

`NavigationShell` owns the viewport frame, persistent header, desktop rail, mobile navigation dialog, skip link, and route working column. Routes own their headings, toolbars, content gutters, and scroll regions; the shell does not add a second padded card.

| Region            | Current geometry and behavior                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop rail      | Visible from 1024px; 252px expanded or 52px collapsed. Destinations scroll independently of the account/footer controls.                                                                                         |
| Header            | 52px below 640px; 46px from 640px. Contains navigation access, workspace/profile context, page title, and jump search.                                                                                           |
| Mobile navigation | Below 1024px, the header opens a full-height, at-most-320px panel containing the same `SidebarNav` as desktop, without its collapse control. Help, account settings, theme choices, and sign-out stay available. |
| Working column    | `min-w-0` and `min-h-0` preserve bounded scrolling. No document-level horizontal overflow.                                                                                                                       |
| Route gutters     | Normally 16px on phones and 24px from the small breakpoint. A collection owns its own edge treatment.                                                                                                            |

Posts is one destination. Its view switcher belongs in the page toolbar, in **Table → Calendar → Grid** order. Brand Profiles remain collection scope and a Channels tab; jump search belongs in the header.

Queues is one destination with an explicit owning Brand Profile selector, a bounded plan list, and a paged membership panel. From the large breakpoint, the plan list reuses the `w-80` fixed-width rail utility and membership takes the remaining shrinkable width; the panels stack on phones. Its scrollable content uses the canonical container controller; configuration and destructive confirmations retain the canonical centered dialog frames.

The shell and drawer frames use the shared safe-area tokens for viewport cutouts and home indicators. Coarse-pointer buttons, select triggers, and menu rows have 44px minimum heights; text fields retain 16px text to avoid phone focus zoom. Fine-pointer controls keep desktop density.

## Collection surfaces

### Posts

`WorkspaceSurface` composes the page heading/actions, toolbar, active filters, and selected collection view on the shared surface background.

- **Table** is the default. The shared spreadsheet table has a sticky header, selection column, title, optional metadata, and counted collapsible groups. Rows paint the shared table hover fill, and the header row stays pinned while the table scrolls; a group's toggle turns its chevron while its rows collapse in place with a height transition, staying mounted so expanding and collapsing animate alike. Status, Brand Profile, or no grouping changes presentation without changing identity or selection. Rows reach the working edges and inset the leading cell. There is no trailing actions column.
- **Calendar** is a flush canvas, not a nested card. Its toolbar contains Today, previous/next, the period heading, and Month/Week controls. Month is Monday-first with 35 or 42 local dates, 112px minimum rows, three Post chips per day, and overflow/day-list access. Week uses seven date columns. The canvas may scroll horizontally; its surrounding controls wrap.
- **Grid** uses `PostCard`, real attachments, and the selected column count. The grid viewport owns its gutters. Cards reflow rather than causing document overflow.

Table, Grid, and Calendar day lists share real Post identity, selection, and supported actions. A partial selection leaves select-all visually unchecked. The shared bottom pill reports the actual selected count and opens the existing destructive confirmation.

All three views load inside the same frame they resolve into: while a query is pending, the page header reports the loading state instead of a zero count, the toolbar and table head stay mounted, the Table renders its real column slots as placeholder rows, the Grid renders placeholder cards with the `PostCard` anatomy, and the Calendar keeps its real period controls and dates with placeholder chips. The shell's own frame covers the session and route-chunk waits as one shape (`WorkspaceLoadingSkeleton`, painted from `index.html` before the module graph arrives), and the header's workspace name holds a placeholder bar until the Brand Profile resolves. Loading therefore never changes the page's height, columns, or scrollbars.

### Channels

Channels uses the Members-style directory composition, not a copy of Posts grouping: a centered 1200px maximum, heading/actions, underlined Accounts/Brand Profiles tabs, account search, connection-status segments, field-row filters, and an inset directory table.

The directory header row stays pinned to the top of the accounts viewport, and that viewport owns both scroll axes, so the wide table scrolls sideways without capturing the sticky header in an inner scroller. Accounts show identity, platform, owning profile, a single accessible health icon, and channel settings. The Brand Profiles tab shows real profile cards and connection counts. Both tabs use the same background and canonical controls as Posts. Table horizontal overflow stays inside the directory viewport.

## Settings

All sections share one layout; Security does not get a separate width rule.

- Navigation and content use the same surface background.
- Below 768px, section navigation is a horizontally scrollable row; from 768px it is a 220px rail.
- Appearance, Language, Account, and Security all use one left-aligned **672px maximum** content column with full available width below that limit.
- Administration uses the directory composition: a centered **1200px** ceiling, a content-width tab strip, and shared **spreadsheet grid tables** for Members and pending invitations. Workspace is a 672px settings form with its seat counts as a compact label/value summary rather than a table. The Administration route is height-locked — only each list scrolls. The Installation Owner is marked by a crown tooltip; their lifecycle control is a toggle and row actions collapse into a three-dot menu. Its Audit tab owns a bounded scroll viewport — a pinned header over 100-entry pages with a paging footer — while the toolbar's search, action, and target filters have fixed widths, Refresh re-reads the current page, and every filter applies server-side across the whole trail.
- Light, Dark, and System cards are **192px**, wrap, and do not stretch to fill a wide screen.
- The content pane owns vertical scrolling. Security forms and authenticator controls are inline; focused confirmation/enrollment steps retain their real security requirements.
- Busy security actions and pending authenticator enrollment/recovery codes block section, route, and history departures until completed or explicitly cancelled; reloading/leaving the document warns before unloading.

## Dialogs and floating controls

`CenterDialog` owns focused forms and search; `CenterAlertDialog` owns destructive confirmations. `SideDialog` owns large Post inspection: a 620px right-edge drawer, a compact 46px toolbar, and the full-viewport phone layout. It is a non-modal companion — the workspace stays clickable so another Post is inspected in place — and it never dims or blocks the surface behind it. Composition uses the same drawer: **Shared Content**, media, and selected Channels' customization/settings sections form a continuous scrollable editor. Wide panels use a 340px destinations/publishing column, with the remaining width assigned to the editor and independent overflow in each column; the draft's save state and single primary action remain pinned below. Shrinkable ancestors bound the columns, and sections do not shrink into one another. The split is a container query on the panel, so narrow panels stack in one reading order inside the drawer's native scrolling body instead of squeezing two columns.

Dialog bodies own native scrolling and keep `data-lenis-prevent` where the document's smooth-scroll controller must not intercept them. Primitives own Escape, scroll lock, and opener restoration; the side inspector deliberately leaves focus untrapped so the workspace stays reachable, while the centered dialogs keep containment.

Centered forms and confirmations have 16px viewport gutters and a maximum height of `100dvh - 32px`; their canonical primitives own native scrolling rather than each caller setting a `vh` ceiling. Jump search retains a shrinkable results viewport between its input and keyboard-help row. Mobile navigation explicitly uses full viewport height instead.

`BulkSelectionBar` is portalled outside clipped collection viewports. Its inverse-ink pill stays 24px above the safe-area edge and within the available viewport width.

## State, motion, and verification

Keep control identity, unsaved content, selection, and keyboard focus stable as labels or state change. Hidden columns retain underlying data; filters operate only on loaded, authorized records. Scope changes clear selection according to the owning feature's contract.

Drawer focus entry and opener restoration use `preventScroll`; neither may move the underlying collection. A non-modal inspection can remain open while the list scrolls, so dismissal preserves the current viewport rather than rewinding to where inspection began.

Inspecting a background Post hides rather than unmounts the live composer; returning preserves its local inputs and upload tasks. Only explicit composition dismissal or a deliberate identity/scope change releases it. URL-backed composer intent opens and closes on same-route navigation as well as reload.

At the composer's wide split, independently scrolling columns reserve a 4px focus gutter so textarea, input, select, and button rings remain visible at every edge. The editor compensates its gutter with margins to retain the shared content alignment; phone layouts keep the drawer's existing outer padding. Do not remove the clipping boundary or shrink a shared focus ring to work around a column's missing space.

There is one implemented animation path, with no application motion mode or mode-specific guards. Preserve existing animation recipes when cleaning up; extend their canonical owners when animation work is requested.

Native `prefers-reduced-motion` remains independent: CSS overrides shorten declarative motion, and the shared WAAPI owner skips spatial effects. Interrupted toolbar exits cancel their own animation and stale completion callbacks before the next intent settles.

Smooth scrolling has one owner, `frontend/app/src/components/layout/smooth-scroll.tsx`. The document controller (`SmoothScroll`) smooths the window and deliberately stays out of every region marked `data-lenis-prevent`, so it can never swallow a nested wheel gesture. Each list viewport that owns its scrolling — the Posts table, Grid, Calendar, and both Channels directories — attaches the callback ref returned by `useSmoothScrollContainer`. Its controller follows the mounted element, destroys itself on detachment or replacement, and rebuilds against the current first child when content is replaced. It re-measures when descendants change and snaps its scroll position to whole pixels so a `position: sticky` header cannot flicker along its top edge while the container animates through fractional offsets.

Verify the actual desktop, phone, and reported user viewport. Cover both palettes, long content, loading, empty/error states, keyboard traversal, nested scrolling, and available actions. Every bounded scroller needs shrinkable flex/grid ancestors; only the intended table or calendar canvas may overflow horizontally.
