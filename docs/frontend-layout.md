# Frontend layout contract

The Gr8r-adapted workspace uses compact chrome, warm flat surfaces, and one content edge. Read alongside [shared UI ownership](frontend-ui.md) and [product conventions](../PRODUCT.md#modular-consistent-surfaces).

## Page geometry

- `NavigationShell` owns the frame: 252px desktop sidebar, 52px collapsed rail, 46px top bar, and a working column that can shrink with `min-width: 0`.
- The top bar contains workspace/Brand Profile context, the current route, jump search, and Settings. It stays mounted across Posts and Channels navigation.
- The desktop content gutter is 24px. `workspace-main` owns outer padding; route headers, toolbars, grids, and tables align to it rather than adding independent outer insets.
- `WorkspaceSurface` orders title/context and actions, then the collection toolbar and working area. Titles are 23px semibold with a 32px line height; descriptions are 13px with a 20px line height.
- Toolbars are flat filter rows with a lower separator, not floating cards. Their horizontal overflow keeps all filters reachable on narrow screens.
- Collections use available width. Limit prose, forms, and empty-state copy rather than wrapping every collection in an arbitrary maximum width.
- A card represents a Post or independent panel. Page sections use spacing and dividers; avoid nested decorative cards.

## Density

| Element                                | Desktop contract                                           |
| -------------------------------------- | ---------------------------------------------------------- |
| Standard / small / large button        | 30px / 26px / 36px                                         |
| Standard input                         | 30px; a task may explicitly request a larger editing field |
| Sidebar row                            | 30px; nested Posts view shortcut 28px                      |
| Working text                           | About 13.5px                                               |
| Secondary labels / metadata            | 12px / 11–12px                                             |
| Radius: chip / control / card / dialog | 4px / 6px / 8px / 10px                                     |

Use the 4pt spacing vocabulary, with 8–12px between related controls and 20–24px between major groups. Compact desktop density is not permission to shrink mobile navigation: use 44px targets for primary touch actions.

## Scroll ownership

| Region                            | Owner                        | Behavior                                              |
| --------------------------------- | ---------------------------- | ----------------------------------------------------- |
| Document frame                    | `NavigationShell`            | Viewport-bound, no document horizontal overflow       |
| Route working column              | `workspace-main`             | Vertical overflow fallback                            |
| Sidebar destinations and profiles | Sidebar nav                  | Independent vertical scroll; footer remains reachable |
| Collection                        | Table/grid/calendar viewport | Bounded vertical or horizontal overflow as needed     |
| Toolbar                           | `TopToolbar`                 | Horizontal overflow only                              |
| Composer editing area             | Composer container           | Bounded internal vertical scroll                      |
| Dialog body                       | Shared dialog content        | Bounded vertical scroll with `data-lenis-prevent`     |

Every flex/grid ancestor of a bounded scroller needs `min-h-0` and/or `min-w-0`. Do not give both the entire page and an unbounded child ownership of the same vertical content.

## Responsive behavior

- Below the desktop rail breakpoint, use the menu drawer and persistent top bar. Search and Settings remain available without the rail.
- Below 640px, the working gutter is 12px and top bar is 52px. Page actions wrap beneath context; essential labels remain readable.
- Settings navigation becomes a horizontal tab row on phones. The content scrolls inside the viewport-bounded dialog.
- Tables may scroll horizontally; controls and status information must not be silently clipped. Cards reflow through the route's existing responsive grid.
- Verify desktop and phone widths, keyboard traversal, long profile names, empty collections, loading, failures, and both palettes. No unintended document horizontal overflow.

## State and motion

Navigation, headings, and palette changes are immediate. Keep controls mounted when state or labels change so input and focus survive. Retained shared transitions honor reduced motion; loading placeholders match the final geometry. Background refresh keeps usable data visible rather than replacing it with a full-page spinner.
