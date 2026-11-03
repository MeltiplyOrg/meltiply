# Frontend layout contract

Layout and scroll boundaries for the current Gr8r-adapted interface. Use
[shared UI ownership](frontend-ui.md) for implementation seams and
[product conventions](../PRODUCT.md#modular-consistent-surfaces) for supported
behavior. Exact values come from [`tokens.css`](../frontend/shared/tokens.css), not a
parallel page theme.

## Alignment and scroll contract

Routes share one horizontal gutter: 16px on phones, 24px from the small breakpoint.
Collection headers and Settings use the same 16px/24px top padding, so a route's
heading, toolbar, and content begin on one edge. Documented maximum widths apply only
to prose, forms, and the directory composition — never as a second page inset.
Settings adds its 220px section rail from 768px, which explains its extra x offset.
Fine-pointer table rows keep 36px collection density; coarse-pointer selection targets
grow to 44px inside their cell.

The shell never scrolls: each route owns explicit scroll regions, with
Administration's height-locked tab lists as the documented exception. Horizontal
scrolling belongs only to the table or calendar canvas, or to a deliberately
scrollable segmented track.

## Workspace shell

`NavigationShell` owns the viewport frame, persistent header, desktop rail,
`MobileNavigationSidebar` layer, skip link, and route working column. Routes own their
headings, toolbars, content gutters, and scroll regions; the shell adds no second
padded card.

| Region            | Geometry and behavior                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop rail      | Visible from 1024px; 252px expanded or 52px collapsed. Destinations scroll independently of account/footer controls.                                                                                                                                                                                   |
| Header            | 52px below 640px, 46px from 640px. Holds navigation access, workspace/profile context, page title, jump search.                                                                                                                                                                                        |
| Mobile navigation | Below 1024px the header opens `MobileNavigationSidebar`: at most 320px, full height, sliding from the left behind a fading scrim, containing the same `SidebarNav` without its collapse control. Escape, scrim, a destination, or the desktop breakpoint closes it; the workspace is inert while open. |
| Working column    | `min-w-0` and `min-h-0` preserve bounded scrolling. No document-level horizontal overflow.                                                                                                                                                                                                             |

The shell and drawer frames use shared safe-area tokens for cutouts and home
indicators. Coarse-pointer buttons, select triggers, and menu rows hold 44px minimum
heights; text fields keep 16px text to avoid phone focus zoom.

## Collection surfaces

### Posts

`WorkspaceSurface` composes the page heading/actions, toolbar, active filters, and
selected view on the shared surface background. On phones the heading and primary
action share a row with the description beneath, and the toolbar uses two compact
rows: search, then filter with the view dropdown plus sort, group, and column
controls. The collection therefore starts within roughly 220px of the workspace
header instead of after four stacked filter rows.

- **Table** is the default: sticky header, selection column, title, optional
  metadata, counted collapsible groups. Rows paint the shared hover fill; a group's
  toggle collapses its rows in place with a height transition, staying mounted so
  expanding and collapsing animate alike. Grouping changes presentation without
  changing identity or selection. No trailing actions column.
- **Calendar** is a flush canvas, not a nested card. Its toolbar holds Today,
  previous/next, the period heading, and Month/Week. Month is Monday-first with 35 or
  42 dates, 112px minimum rows, three Post chips per day, and overflow access. The
  canvas may scroll horizontally; surrounding controls wrap.
- **Grid** uses `PostCard`, real attachments, and the selected column count, with a
  bottom analytics row of views, likes, comments, and shares in four non-wrapping
  slots. Draft, unpublished, and unmeasured counters show a dash; measured zeros stay
  zero. Cards reflow rather than causing document overflow.

Post reads request at most 60 records. Grid renders 60 matching cards with
Previous/page/Next beneath and returns its viewport to the top on page change. Table
keeps loaded rows and appends through its bottom Load more, which stays reachable
outside the wide table. Presentation filters operate on the loaded collection and
reset Grid; navigation stays reachable when no loaded row matches. Calendar keeps its
separately bounded month query.

All three views load inside the frame they resolve into: while pending, the header
reports loading instead of a zero count, the toolbar and table head stay mounted, and
each view renders placeholder rows, cards, or calendar chips with real geometry. The
shell's `WorkspaceLoadingSkeleton` covers session and route-chunk waits as one shape,
painted from `index.html` before the module graph arrives. Loading never changes page
height, columns, or scrollbars.

### Channels

Channels uses the Members-style directory composition, not a copy of Posts grouping: a
centered 1200px maximum, heading/actions, underlined Accounts/Brand Profiles tabs,
account search, status segments, field-row filters, and an inset directory table.

The directory header row stays pinned and that viewport owns both scroll axes, so the
wide table scrolls sideways without capturing the sticky header in an inner scroller.
Accounts show identity, platform, owning profile, one accessible health icon, and
channel settings; the Brand Profiles tab shows real profile cards and connection
counts.

Account identity keeps the saved name above a single compact username/ID line; adding
a username never adds a line or grows the row. Both values truncate within the Channel
column and copy on click — no separate copy-icon columns.

`/channels/connect` pairs the shared Meltiply mark and provider mark directly on the
canvas with a link glyph between them. Brand Profile assignment uses a bounded
native-scrolling radio list with a focus gutter; only connectable profiles appear in
workspace order. An already connected account can reconnect only to its current
owning profile; if none can accept the Channel, an explanatory empty state replaces
the choices.

### Analytics

`/analytics` is a read-only operational page inside `WorkspaceSurface`. Its toolbar
uses the same compact collection filter builder as Posts: one Filter disclosure holds
Brand Profile, range preset, platform, connected account, and content format; active
values become removable chips, and Refresh stays beside it. The toolbar wraps on
narrow screens rather than scrolling. It never switches the dashboard into a
single-metric mode.

The body scrolls independently and fills the available width: a KPI grid of two,
three, or five columns, then a full-width performance-trend card whose four lines
share one indexed scale and restore absolute values on hover. A responsive two-column
grid follows with the stacked engagement-by-platform chart, posts over time, follower
evolution, and the content-format list. The best-time heatmap and platform breakdown
table span the full width; the top-Posts table keeps all four metric columns visible
with header re-ranking. Chart-local selectors use the shared segmented control.

Brand Profile lives inside the same Filter builder and scopes every analytics query
through the workspace selection; changing it clears the account filter, and Clear all
restores All Brand Profiles plus the default range in one update.

The table collapses to stacked Post rows below `lg` with metric labels beside each
value. The chart keeps its `role="img"` summary and a visually hidden equivalent
table. Loading skeletons preserve KPI, chart, and table heights; refreshing keeps
prior data mounted. Day/Week/Month changes morph marks in place by FLIPping each
rendered stack from the previous geometry, so days merge into weeks without a React
render per frame.

## Settings

All sections share one layout; Security gets no separate width rule.

- Navigation and content share the surface background. Below 768px section navigation
  is a horizontally scrollable row; from 768px it is a 220px rail.
- The rail centers its `aria-current="page"` section on mount, section change
  (including reload and history navigation), language change, late label growth, and
  rail resize, then clamps to its scroll bounds.
- Appearance, Language, Account, and Security use one left-aligned 672px content
  column at full width below that limit.
- Administration uses the directory composition: a centered 1200px ceiling, a
  content-width tab strip, and shared grid tables for Members and pending
  invitations. Workspace is a 672px settings form with seat counts as a compact
  label/value summary.
- Light, Dark, and System cards are 192px and wrap rather than stretching wide.
- The content pane owns vertical scrolling. Busy security actions and pending
  authenticator enrollment block section, route, and history departures until
  completed or cancelled; reloading warns before unload.

## Dialogs and floating controls

`CenterDialog` owns focused forms and search; `CenterAlertDialog` owns destructive
confirmations. Both share one `dialogChrome` surface and focus treatment while keeping
distinct dismissal: the ordinary dialog dismisses from outside or Escape and exposes a
localized Close; the confirmation blocks outside dismissal, focuses Cancel, and still
cancels on Escape.

Dialog bodies own native scrolling and keep `data-lenis-prevent` where the document's
smooth-scroll controller must not intercept them. Primitives own Escape, scroll lock,
and opener restoration; the side inspector deliberately leaves focus untrapped so the
workspace stays reachable.

Centered forms and confirmations have 16px viewport gutters and a maximum height of
`100dvh - 32px`; primitives own native scrolling rather than each caller setting a
`vh` ceiling. Jump search keeps a shrinkable results viewport between its input and
keyboard-help row.

The Brand Profile dialog's 51-color palette reflows by available content width from a
single rendered swatch set: 9/8 honeycomb with capped 42×48px cells, then a six-column
grid, then progressively fewer columns down to one at 320px.

`BulkSelectionBar` is portalled outside clipped collection viewports; its inverse-ink
pill stays 24px above the safe-area edge and within the viewport width.

## State, motion, and verification

Keep control identity, unsaved content, selection, and keyboard focus stable as labels
or state change. Hidden columns retain underlying data; filters operate only on
loaded, authorized records. Scope changes clear selection per the owning feature's
contract.

Drawer focus entry and opener restoration use `preventScroll`; neither may move the
underlying collection. Inspecting a background Post hides rather than unmounts the
live composer, so returning preserves local inputs and upload tasks; only explicit
dismissal or an identity/scope change releases it. URL-backed composer intent opens
and closes on same-route navigation and history changes.

At the composer's wide split, independently scrolling columns reserve a 4px focus
gutter so rings stay visible at every edge; the editor compensates with margins to
keep shared content alignment. Phone layouts keep the drawer's outer padding.

There is one implemented animation path, with no application motion mode or
mode-specific guards. Extend the canonical owners when animation work is requested.
Native `prefers-reduced-motion` stays independent: CSS shortens declarative motion and
the shared WAAPI owner skips spatial effects. Interrupted toolbar exits cancel their
own animation before the next intent settles.

Smooth scrolling has one owner, `layout/smooth-scroll.tsx`. The document controller
smooths the window and stays out of every region marked `data-lenis-prevent`, so it
cannot swallow a nested wheel gesture, and each list viewport that owns its own
scrolling asks `useSmoothScrollContainer` for a container controller. On Queues both
the plan list and the calendar viewport own one; the page body never adds a second
document controller on phones.

Verify the actual desktop, phone, and reported user viewport. Cover both palettes,
long content, loading, empty/error states, keyboard traversal, nested scrolling, and
available actions. Every bounded scroller needs shrinkable flex/grid ancestors; only
the intended table or calendar canvas may overflow.
