# Frontend layout contract

The Gr8r-adapted workspace uses compact chrome, warm flat surfaces, and route-owned working edges. Read alongside [shared UI ownership](frontend-ui.md) and [product conventions](../PRODUCT.md#modular-consistent-surfaces).

## Page geometry

- `NavigationShell` owns the 252px desktop rail, 52px collapsed rail, 46px desktop top bar, and a shrinkable route column. The top bar contains workspace/profile context, route title, and jump search. Settings is a full route, not a dialog.
- The shell has no global page padding. Headers and toolbars own 24px desktop gutters; mobile uses 16px. Table rows reach working edges and inset the leading cell. Grid owns its viewport gutter. Posts has one sidebar entry, without nested views.
- `WorkspaceSurface` is a full-bleed flex column. Its header uses 24px top and 12px bottom padding, 23px semibold title, and 13.5px description. Actions wrap without creating a second card.
- Posts supports Table (default), Grid, and Calendar, selected only from its page toolbar. Table adopts the Tasks spreadsheet grammar with counted collapsible groups and column controls; Grid and Calendar retain publishing-specific data and behavior.
- Channels follows Gr8r Members: centered 1200px page, underlined Accounts/Brand Profiles tabs, search and connection-status segments, bordered directory table, identity rows, health badges, and actual profile cards. Its background is the same `bg-surface` as Posts; table overflow stays inside the directory panel.
- Cards represent Posts or genuinely independent objects. Use spacing and separators for page hierarchy; avoid nested decorative cards.

## Density and tokens

| Element                                | Desktop contract                                           |
| -------------------------------------- | ---------------------------------------------------------- |
| Standard / small / large button        | 30px / 26px / 36px                                         |
| Standard input                         | 30px; a task may explicitly request a larger editing field |
| Sidebar row                            | 30px; Posts is one destination without view shortcuts      |
| Working / control / micro text         | 13.5px / 12.5px / 11px                                     |
| Radius: chip / control / card / dialog | 4px / 6px / 8px / 10px                                     |

Use the shared semantic tokens and Tailwind utilities. Rewritten app React components use TypeScript/Tailwind and `cn`; do not add page-specific CSS selectors or copy style blocks. Shared CSS is for tokens, global focus/reset, or browser interoperability that utilities cannot represent. Use 8–12px between related controls and 20–24px between major groups. Compact desktop density never shrinks mobile primary touch targets below 44px.

## Shared compositions

- `TopToolbar` composes search, filter disclosure, active chips, sort/group/column menus, and view controls. It wraps on small screens; filters stay reachable.
- Shared `Table` owns row density, header stickiness, dividers, and hover/selection. Posts Table and Channel directory supply columns/data, not a second style system.
- Posts Grid uses `PostCard`; Post actions/selection and brand context do not fork per view.
- `Tabs` owns accessible section switching and shared segment/underline/navigation treatments. Route panels own their actual content and scroll region.
- Empty/loading/error states use canonical shared primitives and actual query state.

## Scroll ownership

| Region               | Owner                                    | Behavior                                                                                  |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Document frame       | `NavigationShell`                        | Viewport-bound, no document horizontal overflow                                           |
| Route working column | `NavigationShell` main                   | Vertical overflow fallback                                                                |
| Sidebar destinations | Sidebar nav                              | Independent vertical scroll; footer remains reachable; no Search or Brand Profile section |
| Posts Table          | Shared table viewport                    | Bounded vertical and horizontal overflow                                                  |
| Grid/Calendar        | Route-specific collection viewport       | Bounded scrolling with route-owned gutters                                                |
| Channel directory    | Channel tab panel and directory viewport | Horizontal table overflow stays inside centered page                                      |
| Settings sections    | Full-height route                        | Responsive section rail; content owns vertical scroll                                     |
| Composer/dialog body | Composer/shared dialog content           | Bounded scroll; dialogs preserve `data-lenis-prevent`                                     |

Every flex/grid ancestor of a bounded scroller needs `min-h-0` and/or `min-w-0`. Avoid giving both the full page and an unbounded child ownership of the same vertical content.

## Responsive behavior

- Below the desktop rail breakpoint, use the navigation drawer and persistent 52px top bar. Search remains in the top bar; Settings remains reachable from mobile navigation.
- Below 640px, gutters are 16px, page actions wrap, and toolbar search/filter/view controls remain visible and keyboard-operable.
- Settings section navigation becomes a horizontal scrollable row. Content scrolls inside the viewport-bound route.
- Channel and spreadsheet tables scroll horizontally rather than clipping actions. Post and profile grids reflow naturally.
- Verify desktop and phone widths, keyboard traversal, long profile names, empty collections, loading, failures, and both palettes. No unintended document horizontal overflow.

## State and motion

Navigation, headings, filters, and palette changes are immediate. Keep controls mounted when state or labels change so input and focus survive. Status groups preserve unknown provider outcomes; hiding a table column does not lose underlying data. Selection covers the visible filtered collection, including collapsed groups, without expanding to unloaded records. Use reduced-motion-aware shared transitions only where retained UI already uses motion; no animation is required to communicate an action.
