---
name: Meltiply
description: Gr8r-adapted publishing workspace with compact controls and warm flat surfaces.
colors:
  accent: "#4b5bd6"
  on-accent: "#ffffff"
  page: "#fbfaf8"
  canvas: "#f4f3f0"
  surface: "#ffffff"
  hover: "#f6f5f2"
  ink: "#1d1c1a"
  ink-secondary: "#57544e"
  ink-muted: "#6b6760"
  line: "#e9e7e2"
  line-strong: "#dad7d0"
  success: "#25754b"
  warning: "#8f5e0e"
  danger: "#b23c30"
  dark-page: "#1a1a19"
  dark-canvas: "#151514"
  dark-surface: "#1d1d1c"
  dark-ink: "#eceae5"
  dark-line: "#2c2b29"
  dark-accent: "#8e9af3"
typography:
  title:
    fontFamily: "Geist, sans-serif"
    fontSize: "23px"
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "13.5px"
  label:
    fontFamily: "Geist, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
  micro:
    fontFamily: "Geist, sans-serif"
    fontSize: "11px"
  mono:
    fontFamily: "Geist Mono, monospace"
    fontWeight: 400
rounded:
  chip: "4px"
  control: "6px"
  card: "8px"
  window: "10px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    height: "30px"
    padding: "0 11px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "30px"
    padding: "0 11px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "30px"
    padding: "4px 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
---

# Design System: Meltiply

## Overview

**Creative North Star: "Gr8r-adapted publishing workspace"**

Warm, compact, and flat: the interface borrows Gr8r Studio's visual language while keeping Meltiply's real publishing workflows. Quiet neutral navigation and opaque surfaces support scanning; indigo identifies actions and focus rather than decorating every panel.

React and Astro share semantic tokens. TypeScript components and Tailwind compositions extend canonical controls rather than copying page-specific primitives. Preserve the current visual state when cleaning implementation code.

**Key Characteristics:**

- Warm neutral fields with a restrained indigo accent.
- Geist typography, compact controls, and precise shared geometry.
- One visual grammar across Posts, Channels, Settings, and dialogs.
- Real identity, provider outcomes, and supported actions instead of reference demo features.

## Colors

The palette combines warm paper neutrals with an indigo/periwinkle action accent. Frontmatter records representative light and dark values; [shared tokens](frontend/shared/tokens.css) own the complete semantic mapping and theme overrides.

### Primary

- **Indigo action accent:** primary buttons, focus, and selected control emphasis. Dark themes use the corresponding periwinkle role, not a separate component palette.
- **On-accent:** text on primary actions; use its theme-aware token rather than hard-coded white.

### Neutral

- **Warm page and canvas:** application fields and surrounding space.
- **Opaque surface:** cards, fields, and overlays.
- **Three-step ink:** primary information, supporting text, and tertiary metadata.
- **Quiet and strong lines:** surface divisions and control boundaries.

Success, warning, and danger indicate actual semantic state. Provider identity colors remain distinct from product status. State must also have text or an accessible icon name.

**The Shared Palette Rule.** Use semantic roles from the shared token owner; do not create route-specific background or ink palettes.

## Typography

**Body and heading font:** self-hosted Geist with system sans-serif fallbacks. **Code and shortcut font:** self-hosted Geist Mono with system monospace fallbacks.

Both sites serve losslessly compressed WOFF2 assets from the shared token owner. Preserve the original glyph coverage and metrics; conversion and source/output hashes are recorded in the font provenance manifest.
The hierarchy is compact and information-led. Shared title, UI, control, and micro roles are recorded above; primitives retain their intentional local sizes, such as the text input's 13px field text. Public reading and landing typography scale for their own tasks without replacing the font family.

Use weight and spacing before additional color. Interface glyphs use the canonical Lucide system; preserve Meltiply's faceted brand mark and actual provider marks.

## Layout

The desktop workspace uses a 252px rail, or 52px when collapsed, from the 1024px breakpoint. The top bar is 46px from 640px and 52px below it. Mobile navigation replaces the rail rather than squeezing it beside content: it is its own left-edge layer over the workspace, reusing the rail's content, and slides in from the left behind a fading scrim. Escape, the scrim, a destination, or reaching the desktop breakpoint closes it. Feature layouts supply responsive gutter reductions.

Posts is one destination with **Table → Calendar → Grid**. Channels follows the Members-style directory composition with matching surfaces and controls. Collection rows use a 40px baseline. Calendar Month/Week retains real date geometry and nested day overflow rather than introducing a second card language.

Settings keeps its bounded 672px form column for Appearance, Language, Account, and Security. Administration is a directory surface with a centered 1200px ceiling, height-locked to the content pane: spreadsheet grid tables for Members and pending invitations, a compact label/value seat summary, and a filtered Audit log whose 100-entry pages scroll under a pinned header. A crown marks the Installation Owner, the lifecycle action is a toggle, and per-row actions live behind a three-dot menu. Do not apply Settings' form width to collection tables.

The side dialog is a 620px drawer at the right edge and fills the phone viewport. Its 46px record toolbar remains separate from the native scrolling body. The same drawer hosts composition: **Shared Content**, attached media, and every selected channel's customization and provider settings appear in one continuous editor, beside a compact 340px destinations/publishing column on wide panels. The editor takes the remaining width and scrolls independently while destinations and timing stay in view; the draft's save state and single publishing action stay pinned below. Date and segmented 24-hour time controls share one row, with the calendar available in a compact popover rather than permanently expanded. The split follows the panel's own width, not the viewport, so a narrow panel stacks in one reading order. See [layout ownership](docs/frontend-layout.md) for scroll boundaries and responsive details.

## Elevation & Depth

Depth is mostly tonal and structural: opaque surfaces, one intentional border, and restrained shadows. Buttons/cards use the subtle shared shadow roles; raised controls and overlays use stronger named roles. Dark mode removes the resting card shadow while retaining overlay separation. Never stack borders, rings, and shadows to describe the same boundary.

The exact theme-aware shadow recipes live in `tokens.css`; the sidecar references those live variables rather than freezing a second palette. Shared motion uses the existing implementation and entrance/exit easing. There is one animation path, not an app motion preference or alternate-mode branch. Existing native CSS accessibility media queries remain independent of application modes.

## Shapes

Corners follow the chip/control/card/window scale in frontmatter. Compact tooltips use their own 5px radius. The inverse selection pill uses the window radius rather than a fully rounded capsule. Avatars and native choice controls retain their own semantic shapes; do not impose card geometry on them.

## Components

### Buttons and fields

Canonical [Button](frontend/shared/src/components/ui/button.tsx) owns primary, destructive, outline, secondary, ghost, and link variants, with shared hover/active/disabled/focus states. Default controls are 30px, small controls 26px, and large controls 36px. [Input](frontend/shared/src/components/ui/input.tsx) owns field fill, strong boundary, accent focus, and native checkbox/radio exceptions; [Textarea](frontend/shared/src/components/ui/textarea.tsx) adds `autoGrow` for fields whose own content sets their height — the caller keeps both bounds through `min-h`/`max-h` classes, so a caption grows as it is written, stops at its maximum, and scrolls internally past it. Keep visible labels and validation in the consuming feature.

### Menus

`DropdownMenu` and `Select` render one vocabulary carried by shared hooks in `frontend/shared/motion.css`: the surface (`[data-menu-surface]`: 200px floor, 4px padding, window radius, opaque surface, overlay elevation with a hairline ring), rows (`[data-menu-item]`: 30px minimum height, 9px gap, 8px inset, control radius, 13.5px text), right-aligned accent checks (`[data-menu-indicator]`), uppercase micro labels (`[data-menu-label]`), and bleeding separators (`[data-menu-separator]`). A page-composed disclosure panel marks itself with the same surface hook. `data-state` animates every surface alike — `menu-surface-in` (160ms settle, 0.97 scale) and `menu-surface-out` (120ms) — with `scale`/`opacity` only, because Radix owns the popper's `transform` and `transform-origin` follows the popper's anchor. `SlidingHighlight` owns the pill inside a menu, as `SidebarGlideHighlight` does in a rail, so rows never paint their own fill; menus drive it with `deferUntilInteraction`, which suppresses Radix's pre-highlight on open until the pointer or keyboard actually moves.

**The One Menu Surface Rule.** Every floating list — dropdown menu, select listbox, submenu, or page-composed filter panel — renders the shared menu vocabulary, surface animation included, and a menu that hand-writes its own surface, row geometry, indicator, or motion is a defect.

### Cards and metadata

[Card](frontend/shared/src/components/ui/card.tsx) supplies the shared opaque surface, quiet line, card corners, and restrained shadow. Metadata badges and status atoms use their existing variants; do not turn every label into an action or give inert metadata invented keyboard behavior.

### Loading states

A loading placeholder is the resolved geometry with its content held back, never a second layout the page settles away from. One owner per surface: `WorkspaceLoadingSkeleton` (`frontend/app/src/components/layout/workspace-loading-skeleton.tsx`) renders the workspace frame — rail, top bar, titled header, toolbar, rows — for the router's Suspense boundary and the session gate, and its geometry, palette, and pulse live once in `globals.css` (`.ws-boot*`), which `index.html` also renders as static markup so the pre-JavaScript first paint is already the shell's shape. The Posts table placeholder repeats the real cell slots through `PostRowCell`, the Grid placeholder repeats the `PostCard` anatomy inside the shared `Card`, and the Calendar keeps its real month heading, dates, and controls while only Post chips become placeholders. Skeletons carry the shared `Skeleton` fill, hide their bars from assistive technology, and let the surface announce loading once in visible copy ("Loading posts…"); a placeholder count fills the fold so resolved content neither grows the page nor adds a scrollbar it did not have.

### Navigation

The rail uses quiet text and neutral selected rows, not accent-filled navigation. Its footer has one compact 36px avatar/name account trigger with trailing chevrons and an avatar-only collapsed state. A 260px menu contains real identity details, Account settings, inline Light/Dark/System theme segments with matching icons, and Sign out. Theme changes apply immediately without closing the menu and reuse the shared preference owner. Unsupported reference profile/presence/shortcut actions are absent.

**The One Icon Column Rule.** Every rail row reserves the same 16px leading slot. A larger 24px identity avatar centers inside that slot instead of widening it, so icons, labels, and the account name share one axis.

**The Gliding Highlight Rule.** Rows that live in a glide container never paint their own hover fill. One shared pill (`SidebarGlideHighlight`) springs to the hovered row and fades out on leave in the workspace rail and the Settings section rail, while the row keeps its labels, focus ring, and selected surface above it. A row marked `data-glide-ignore` is not a glide target and keeps its own plain hover fill: the sidebar's account block opts out, and the account menu it opens sets `highlight={false}` so its rows use the shared `data-menu-plain` fill instead of a travelling pill. Posts table rows keep the table's own hover fill, with no pill behind them.

**The Travelling Selection Rule.** A control that picks one of several options never paints the picked one in place. Segmented tracks (`SegmentedControl`), the account menu's theme segment group, `TabsList variant="segment"`, and `line` tab strips hand the selected fill or accent rule to one shared `SlidingHighlight`: it measures the selected item, commits that box as static geometry, and moves with transforms only — translate, plus `scaleX` from the left edge when the items differ in width — settling back to `scaleX(1)` so the pill or rule and its radius are exact and crisp at rest. Items stay `relative z-10` above it and keep their own label color, hover, and press treatment; the highlight owns the selected fill, and a caller's `indicatorClassName` recolors it when the strip inverts. A native segmented track is a `radiogroup` whose checked option carries `aria-checked`, is the only tab stop, and is selected with Arrow/Home/End; the account menu's theme segments reuse the same travelling fill inside menu semantics. When the OS asks for reduced motion, travel commits instantly and only the opacity fade marks appearance.

**The Calendar Morph Rule.** A calendar changing period keeps its identity. Month↔Week commits through native View Transitions (`transitionViewEffect` in `frontend/shared/effects.ts`): date labels share one `view-transition-name` across both layouts so they carry over, the toolbar and surrounding chrome stay still, and the root is not animated. Unsupported browsers and native reduced motion commit immediately, and a repeated choice skips the previous transition without skipping its state change. Never add a second motion library path or a mode flag for this.

**The Rolling Count Rule.** A count that changes where it stands rolls instead of swapping. One `RollingCount` serves them all — the surfaces' own result lines, the grid's column count, Channels' tab counts and selection dock, a Post's channel and attachment totals, a table group's size, a profile card's connected accounts — inside a one-line window (`data-value-roll`) that clips, so the new value arrives from the side the count moved and the previous one leaves the other way, on transforms and opacity only. Humble counts keep the animation out of the layout: the number stays one reading of itself for assistive technology, and a count that is merely mounted, loaded, or re-rendered never rolls. A count inside a sentence is not an exception: `<Trans>` interpolates the component into the translated message.

### Filters and tooltips

Canonical field-row filters share Where/and rows, equality controls, Add filter chips, clear/remove actions, and active-value chips. Tooltips use compact inverse ink, a 350ms opening delay, 120ms fade, and 6px offset. Radix owns portals, collision handling, focus, and Escape.

### Selection and dialogs

The floating selection pill uses inverse ink, separators, a real count, supported actions, and icon-only Deselect. Select-all is checked only when every visible item is selected; partial selection remains visually unchecked.

Use CenterDialog for focused work, CenterAlertDialog for destructive confirmation, and SideDialog for Post inspection. Feature content supplies real Post properties, attachments, caption, and independent Channel outcomes. Preserve keyboard dismissal, focus containment, opener restoration, and pending/error states. Both centered dialogs share one `dialogChrome` surface, elevation, radius, and focus treatment: the ordinary dialog keeps outside-click and Escape dismissal and a localized Close control, while the destructive confirmation blocks outside dismissal, focuses Cancel, and still cancels on Escape; their widths stay intentionally different. Do not duplicate drawer actions in a footer. The inspector is a non-modal companion, as in the reference: the workspace stays clickable so another Post is inspected in place, and nothing dims or blocks the surface behind it. Focus containment does not apply to it — Tab leaves the panel for the workspace; retain it for the centered dialogs. The panel steps 48px in from its edge on the reference drawer curve (`--ease-drawer`) and slides back out on dismissal; its body blocks rise behind it for 460ms with a 0/55/105/150ms stagger, so each block is catchable without the stagger feeling slow. Inspecting another Post without closing the panel replaces the body and replays that same staggered entrance for the new record.

## Do's and Don'ts

### Do:

- **Do** extend shared TypeScript/React controls and semantic Tailwind compositions.
- **Do** use one palette and consistent collection grammar across routes.
- **Do** keep all Settings sections within the shared content width.
- **Do** preserve real data, async outcomes, accessible names, and focus behavior.
- **Do** extend existing animation owners when adding animation.

### Don't:

- **Don't** restore sidebar view/profile/search subsections or obsolete view modes.
- **Don't** duplicate primitives, palette definitions, dialog frames, or sign-out behavior.
- **Don't** introduce an app motion mode, preference provider, or alternate animation branch.
- **Don't** copy reference-only capabilities that Meltiply does not implement.
- **Don't** treat compilation as visual proof; inspect actual desktop and phone states in both palettes.
