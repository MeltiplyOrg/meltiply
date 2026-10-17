# Frontend layout contract

This document records the alignment, density, responsive, and scroll-ownership conventions for the authenticated publishing workspace. It is the companion to `docs/frontend-ui.md` and `PRODUCT.md`.

## Page geometry

- The workspace shell (`NavigationShell`) owns the outer frame. Its `<main>` element is the single vertical scroll owner for workspace content; inner regions must not introduce a competing page-level scrollbar.
- Route content is wrapped in `WorkspaceSurface`, which fixes the page header (title, description, actions) at `shrink-0` and reserves a `gap-4` between the header and the working area. All operational routes (Posts, Channels, composer) use this surface so headings and content edges stay aligned when switching views.
- Horizontal padding lives on `<main>` only (`p-3 sm:p-5 lg:p-6`). Route surfaces and toolbars must not add their own outer horizontal padding; inner cards/panels may pad their own content.
- Browsing collections (tables, grids, channel lists) take the available width intentionally and are not wrapped in an arbitrary `max-w-*`. Readable limits (`max-w-sm`, `max-w-xl`, etc.) are reserved for prose, empty-state copy, and forms/dialogs.
- Page-level sections are separated by spacing or dividers (`border-t`, `gap-*`), not by nested cards. A card denotes an independent object (a Post row, a Channel, a dialog), not a page section.

## Density

- Control heights: icon buttons `size-8`/`size-9`, standard buttons `h-8`/`h-9`, toolbar `h-[3.375rem]`, inputs `h-9`/`h-10`. Comparable controls use the same height unless a task requires a documented exception.
- Spacing vocabulary: `gap-1.5`, `gap-2`, `gap-3`, `gap-4`, `p-2.5`, `p-3`, `p-4`, `p-6`, `p-12` for empty states. Avoid ad-hoc values.
- Typography: page title `text-2xl sm:text-3xl`, section heading `text-base`, body `text-sm`, metadata `text-xs`/`text-[12px]`.
- Touch targets on phones aim for 44px for primary navigation/actions; desktop compactness is not carried onto small viewports.

## Scroll ownership

| Region | Owner | Overflow |
| --- | --- | --- |
| Workspace page | `<main>` in `NavigationShell` | `overflow-y-auto` |
| Toolbar | `TopToolbar` | `overflow-x-auto` (horizontal only) |
| Composer editing area | composer container | `overflow-y-auto` (inner) |
| Dialog body | `CenterDialogContent`/`SideDialog` | `overflow-y-auto` with `data-lenis-prevent` |
| Tables/collections | their own scroll container | `overflow-y-auto`/`overflow-x-auto` only when needed |

Inner scroll containers must use `min-h-0` and never become the page scroll owner.

## Responsive behavior

- Breakpoints follow Tailwind defaults: `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536. Representative verification widths: 320, 390, 768, 1024, 1440, 1920.
- Toolbars reflow horizontally with `overflow-x-auto` rather than clipping; active filter state stays visible.
- Collection metadata stacks when a row no longer fits; row actions stay attached to their object.
- No unintended document horizontal overflow.

## Motion and loading

- Entrance motion is tied to route/view transitions, not data updates. Low motion disables travel but does not remount.
- Loading placeholders match destination geometry (shared `Skeleton`).
- Background refresh keeps usable content visible; full-page loading only for initial load.
