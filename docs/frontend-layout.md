# Frontend layout contract

This document owns layout and scroll boundaries for the current Gr8r-adapted interface. Use [shared UI ownership](frontend-ui.md) for implementation seams and [product conventions](../PRODUCT.md#modular-consistent-surfaces) for supported behavior. Exact shared values come from [`tokens.css`](../frontend/shared/tokens.css), not a parallel page theme.

## Workspace shell

`NavigationShell` owns the viewport frame, persistent header, desktop rail, mobile navigation dialog, skip link, and route working column. Routes own their headings, toolbars, content gutters, and scroll regions; the shell does not add a second padded card.

| Region            | Current geometry and behavior                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Desktop rail      | Visible from 1024px; 252px expanded or 52px collapsed. Destinations scroll independently of the account/footer controls.            |
| Header            | 52px below 640px; 46px from 640px. Contains navigation access, workspace/profile context, page title, and jump search.              |
| Mobile navigation | Below 1024px, the header opens the shared navigation dialog. Posts, Channels, Settings, help, and account actions remain reachable. |
| Working column    | `min-w-0` and `min-h-0` preserve bounded scrolling. No document-level horizontal overflow.                                          |
| Route gutters     | Normally 16px on phones and 24px from the small breakpoint. A collection owns its own edge treatment.                               |

Posts is one destination. Its view switcher belongs in the page toolbar, in **Table → Calendar → Grid** order. Brand Profiles remain collection scope and a Channels tab; jump search belongs in the header.

## Collection surfaces

### Posts

`WorkspaceSurface` composes the page heading/actions, toolbar, active filters, and selected collection view on the shared surface background.

- **Table** is the default. The shared spreadsheet table has a sticky header, selection column, title, optional metadata, and counted collapsible groups. Status, Brand Profile, or no grouping changes presentation without changing identity or selection. Rows reach the working edges and inset the leading cell. There is no trailing actions column.
- **Calendar** is a flush canvas, not a nested card. Its toolbar contains Today, previous/next, the period heading, and Month/Week controls. Month is Monday-first with 35 or 42 local dates, 112px minimum rows, three Post chips per day, and overflow/day-list access. Week uses seven date columns. The canvas may scroll horizontally; its surrounding controls wrap.
- **Grid** uses `PostCard`, real attachments, and the selected column count. The grid viewport owns its gutters. Cards reflow rather than causing document overflow.

Table, Grid, and Calendar day lists share real Post identity, selection, and supported actions. A partial selection leaves select-all visually unchecked. The shared bottom pill reports the actual selected count and opens the existing destructive confirmation.

### Channels

Channels uses the Members-style directory composition, not a copy of Posts grouping: a centered 1200px maximum, heading/actions, underlined Accounts/Brand Profiles tabs, account search, connection-status segments, field-row filters, and an inset directory table.

Accounts show identity, platform, owning profile, a single accessible health icon, and channel settings. The Brand Profiles tab shows real profile cards and connection counts. Both tabs use the same background and canonical controls as Posts. Table horizontal overflow stays inside the directory viewport.

## Settings

All sections share one layout; Security does not get a separate width rule.

- Navigation and content use the same surface background.
- Below 768px, section navigation is a horizontally scrollable row; from 768px it is a 220px rail.
- Appearance, Language, Account, and Security all use one left-aligned **672px maximum** content column with full available width below that limit.
- Light, Dark, and System cards are **192px**, wrap, and do not stretch to fill a wide screen.
- The content pane owns vertical scrolling. Security forms and authenticator controls are inline; focused confirmation/enrollment steps retain their real security requirements.

## Dialogs and floating controls

`CenterDialog` owns focused forms and search; `CenterAlertDialog` owns destructive confirmations. `SideDialog` owns large Post inspection: a 620px right-edge drawer, compact 46px toolbar, optional 980px expanded inspector, and full-viewport phone layout. It is a non-modal companion — the workspace stays clickable so another Post is inspected in place — and only the expanded inspector dims the outside surface behind a dismissible scrim.

Dialog bodies own native scrolling and keep `data-lenis-prevent` where the document's smooth-scroll controller must not intercept them. Primitives own Escape, scroll lock, and opener restoration; the side inspector deliberately leaves focus untrapped so the workspace stays reachable, while the centered dialogs keep containment.

`BulkSelectionBar` is portalled outside clipped collection viewports. Its inverse-ink pill stays 24px above the safe-area edge and within the available viewport width.

## State, motion, and verification

Keep control identity, unsaved content, selection, and keyboard focus stable as labels or state change. Hidden columns retain underlying data; filters operate only on loaded, authorized records. Scope changes clear selection according to the owning feature's contract.

There is one implemented animation path, with no application motion mode or mode-specific guards. Preserve existing animation recipes when cleaning up; extend their canonical owners when animation work is requested.

Verify the actual desktop, phone, and reported user viewport. Cover both palettes, long content, loading, empty/error states, keyboard traversal, nested scrolling, and available actions. Every bounded scroller needs shrinkable flex/grid ancestors; only the intended table or calendar canvas may overflow horizontally.
