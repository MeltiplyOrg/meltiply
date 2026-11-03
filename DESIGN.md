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

Warm, compact, and flat: the interface borrows Gr8r Studio's visual language while
keeping Meltiply's real publishing workflows. Quiet neutral navigation and opaque
surfaces support scanning; indigo identifies actions and focus rather than decorating
every panel.

React and Astro share semantic tokens. TypeScript components and Tailwind compositions
extend canonical controls rather than copying page-specific primitives. Preserve the
current visual state when cleaning implementation code.

**Key Characteristics:** warm neutral fields with a restrained indigo accent; Geist
typography with compact controls and precise shared geometry; one visual grammar across
Posts, Channels, Settings, and dialogs; real identity, provider outcomes, and supported
actions instead of reference demo features.

## Colors

Warm paper neutrals with an indigo/periwinkle action accent. Frontmatter records
representative light and dark values; [shared tokens](frontend/shared/tokens.css) own the
complete semantic mapping and theme overrides.

- **Indigo action accent:** primary buttons, focus, selected control emphasis. Dark
  themes use the corresponding periwinkle role, not a separate component palette.
- **On-accent:** text on primary actions; use its theme-aware token, never hard-coded white.
- **Neutral:** warm page/canvas fields, opaque surfaces, a three-step ink ramp, and
  quiet/strong lines for divisions and control boundaries.

Success, warning, and danger indicate actual semantic state. Provider identity colors
stay distinct from product status, and state always carries text or an accessible icon
name.

**The Shared Palette Rule.** Use semantic roles from the shared token owner; never
create route-specific background or ink palettes.

## Typography

Self-hosted Geist (system sans-serif fallback) for body and headings; self-hosted Geist
Mono (system monospace fallback) for code, identifiers, and shortcuts. Both sites serve
losslessly compressed WOFF2 from the shared token owner; preserve glyph coverage and
metrics, with source/output hashes in the font provenance manifest.

The hierarchy is compact and information-led. Shared title, UI, control, and micro roles
live in the token owner; primitives keep intentional local sizes such as the text
input's 13px field text. Public reading and landing typography scale for their own tasks
without replacing the family. Use weight and spacing before adding color. Interface
glyphs use canonical Lucide; preserve Meltiply's faceted brand mark and real provider marks.

## Layout

The desktop workspace uses a 252px rail (52px collapsed) from 1024px. The top bar is 46px
from 640px and 52px below it. Mobile navigation replaces the rail as its own left-edge
layer reusing the rail's content, closed by Escape, the scrim, a destination, or the
desktop breakpoint.

Posts is one destination with **Table → Calendar → Grid**. Channels follows the
Members-style directory composition. Collection rows use a 40px baseline; Calendar
Month/Week keeps real date geometry and nested day overflow rather than a second card
language.

Settings keeps its bounded 672px form column for Appearance, Language, Account, and
Security. Administration is a directory surface with a centered 1200px ceiling,
height-locked to the content pane: grid tables for Members and invitations, a compact
seat summary, and a filtered Audit log whose 100-entry pages scroll under a pinned
header. A crown marks the Installation Owner and the lifecycle action is a toggle. Do
not apply Settings' form width to collection tables.

The side dialog is a 620px right-edge drawer that fills the phone viewport. Its 46px
record toolbar stays separate from the native scrolling body. The same drawer hosts
composition: **Shared Content**, media, and each selected channel's customization in one
continuous editor beside a compact 340px destinations/publishing column on wide panels.
The editor scrolls independently while destinations and timing stay in view, and the
draft's save state and single publishing action stay pinned below. The split follows the
panel's width, not the viewport. See [layout ownership](docs/frontend-layout.md).

## Elevation & Depth

Depth is tonal and structural: opaque surfaces, one intentional border, restrained
shadows. Buttons and cards use subtle shared shadow roles; raised controls and overlays
use stronger named roles. Dark mode drops the resting card shadow but retains overlay
separation. Never stack borders, rings, and shadows to describe the same boundary.
Exact theme-aware recipes live in `tokens.css`.

Shared motion uses the existing implementation and entrance/exit easing. There is one
animation path, not an app motion preference or alternate-mode branch. Native CSS
accessibility media queries stay independent of application modes.

## Shapes

Corners follow the chip/control/card/window scale in frontmatter. Compact tooltips use
their own 5px radius; the inverse selection pill uses the window radius rather than a
fully rounded capsule. Avatars and native choice controls keep their own semantic
shapes — do not impose card geometry on them.

## Components

### Buttons and fields

Canonical [Button](frontend/shared/src/components/ui/button.tsx) owns primary,
destructive, outline, secondary, ghost, and link variants with shared
hover/active/disabled/focus states. Default controls are 30px, small 26px, large 36px.
[Input](frontend/shared/src/components/ui/input.tsx) owns field fill, strong boundary,
accent focus, and native checkbox/radio exceptions;
[Textarea](frontend/shared/src/components/ui/textarea.tsx) adds `autoGrow`, with the
caller keeping both bounds through `min-h`/`max-h`. Keep visible labels and validation
in the consuming feature.

### Menus

`DropdownMenu` and `Select` render one vocabulary carried by shared hooks in
`frontend/shared/motion.css`: the surface (`[data-menu-surface]`), rows
(`[data-menu-item]`), right-aligned accent checks (`[data-menu-indicator]`), uppercase
micro labels (`[data-menu-label]`), and bleeding separators (`[data-menu-separator]`).
A page-composed disclosure panel marks itself with the same surface hook. `data-state`
animates every surface alike with `scale`/`opacity` only, because Radix owns the popper's
transform. `SlidingHighlight` owns the pill inside a menu, as `SidebarGlideHighlight`
does in a rail, so rows never paint their own fill.

**The One Menu Surface Rule.** Every floating list — dropdown, select listbox, submenu,
page-composed filter panel — renders the shared menu vocabulary including its surface
animation. A menu that hand-writes its own surface, row geometry, indicator, or motion is
a defect.

### Cards and metadata

[Card](frontend/shared/src/components/ui/card.tsx) supplies the shared opaque surface,
quiet line, corners, and restrained shadow. Metadata badges and status atoms use their
existing variants; do not turn every label into an action or give inert metadata
invented keyboard behavior.

### Loading states

A loading placeholder is the resolved geometry with its content held back, never a
second layout the page settles away from. One owner per surface:
`WorkspaceLoadingSkeleton` renders the workspace frame for the router's Suspense
boundary and session gate, with geometry, palette, and pulse living once in
`globals.css` so `index.html` can render the same markup for the pre-JavaScript first
paint. The Posts table placeholder repeats real cell slots through `PostRowCell`, the
Grid placeholder repeats the `PostCard` anatomy, and the Calendar keeps its real heading
and dates while only chips become placeholders. Skeletons hide bars from assistive
technology and announce loading once in visible copy.

### Navigation

The rail uses quiet text and neutral selected rows, not accent-filled navigation. Its
footer has one compact 36px avatar/name account trigger with trailing chevrons and an
avatar-only collapsed state; its 260px menu holds real identity details, Account
settings, inline Light/Dark/System segments, and Sign out. Theme changes apply
immediately without closing the menu through the shared preference owner. Unsupported
reference profile/presence/shortcut actions are absent.

**The One Icon Column Rule.** Every rail row reserves the same 16px leading slot. A
larger 24px identity avatar centers inside that slot instead of widening it.

**The Gliding Highlight Rule.** Rows in a glide container never paint their own hover
fill: one shared pill springs to the hovered row while the row keeps its labels, focus
ring, and selected surface above it. A row marked `data-glide-ignore` keeps its own
plain hover fill — the sidebar account block opts out, and the account menu it opens
sets `highlight={false}` so its rows use the shared `data-menu-plain` fill. Posts table
rows keep the table's own hover fill.

**The Travelling Selection Rule.** A control that picks one of several options never
paints the picked one in place. Segmented tracks, the account menu's theme group,
`TabsList variant="segment"`, and `line` tab strips hand the selected fill or accent
rule to one shared `SlidingHighlight`, which measures the selected item, commits that
box as static geometry, and moves with transforms only. Items stay above it and keep
their own label color and press treatment; a caller's `indicatorClassName` recolors the
highlight when the strip inverts. Native segmented tracks are `radiogroup`s whose
checked option carries `aria-checked` and is the only tab stop. Under reduced motion,
travel commits instantly and only the opacity fade marks appearance.

**The Calendar Morph Rule.** A calendar changing period keeps its identity. Month↔Week
commits through native View Transitions (`transitionViewEffect` in
`frontend/shared/effects.ts`): date labels share one `view-transition-name` across both
layouts, the toolbar stays still, and the root is not animated. Unsupported browsers
and reduced motion commit immediately; a repeated choice skips the previous transition
without skipping its state change. Never add a second motion library path or mode flag.

**The Rolling Count Rule.** A count that changes where it stands rolls instead of
swapping. One `RollingCount` serves result lines, column counts, tab counts, selection
docks, and per-item totals inside a one-line clipping window, so the new value arrives
from the side the count moved. The number stays one reading for assistive technology,
and a count that is merely mounted, loaded, or re-rendered never rolls. A count inside a
sentence is not an exception: `<Trans>` interpolates the component into the message.

### Filters and tooltips

Canonical field-row filters share Where/and rows, equality controls, Add filter chips,
clear/remove actions, and active-value chips. Tooltips use compact inverse ink, a 350ms
opening delay, 120ms fade, and 6px offset. Radix owns portals, collision handling, focus,
and Escape.

### Selection and dialogs

The floating selection pill uses inverse ink, separators, a real count, supported
actions, and icon-only Deselect. Select-all is checked only when every visible item is
selected; partial selection stays visually unchecked.

Use CenterDialog for focused work, CenterAlertDialog for destructive confirmation, and
SideDialog for Post inspection. Feature content supplies real Post properties,
attachments, caption, and independent Channel outcomes. Preserve keyboard dismissal,
focus containment, opener restoration, and pending/error states.

Both centered dialogs share one `dialogChrome` surface, elevation, radius, and focus
treatment: the ordinary dialog keeps outside-click and Escape dismissal with a localized
Close, while the destructive confirmation blocks outside dismissal, focuses Cancel, and
still cancels on Escape. Their widths stay intentionally different. Do not duplicate
drawer actions in a footer.

The inspector is a non-modal companion: the workspace stays clickable so another Post is
inspected in place, nothing dims or blocks the surface behind it, and focus containment
does not apply — Tab leaves the panel for the workspace. The panel steps 48px in from its
edge on `--ease-drawer` and slides back out on dismissal; its body blocks rise behind it
with a short stagger. Inspecting another Post without closing the panel replaces the body
and replays that entrance.

## Do's and Don'ts

### Do

- Extend shared TypeScript/React controls and semantic Tailwind compositions.
- Use one palette and consistent collection grammar across routes.
- Keep all Settings sections within the shared content width.
- Preserve real data, async outcomes, accessible names, and focus behavior.
- Extend existing animation owners when adding animation.

### Don't

- Restore sidebar view/profile/search subsections or obsolete view modes.
- Duplicate primitives, palette definitions, dialog frames, or sign-out behavior.
- Introduce an app motion mode, preference provider, or alternate animation branch.
- Copy reference-only capabilities Meltiply does not implement.
- Treat compilation as visual proof; inspect actual desktop and phone states in both palettes.
