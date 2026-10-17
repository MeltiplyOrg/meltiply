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
spacing:
  workspace-gutter: "24px"
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

The hierarchy is compact and information-led. Shared title, UI, control, and micro roles are recorded above; primitives retain their intentional local sizes, such as the text input's 13px field text. Public reading and landing typography scale for their own tasks without replacing the font family.

Use weight and spacing before additional color. Interface glyphs use the canonical Lucide system; preserve Meltiply's faceted brand mark and actual provider marks.

## Layout

The desktop workspace uses a 252px rail, or 52px when collapsed, from the 1024px breakpoint. The top bar is 46px from 640px and 52px below it. Mobile navigation replaces the rail rather than squeezing it beside content. The shared workspace gutter is recorded in frontmatter; feature layouts supply responsive reductions.

Posts is one destination with **Table → Calendar → Grid**. Channels follows the Members-style directory composition with matching surfaces and controls. Collection rows use a 40px baseline. Calendar Month/Week retains real date geometry and nested day overflow rather than introducing a second card language.

Settings uses one bounded 672px content column for every section. Its section rail is 220px from 768px and horizontal below; theme choices remain compact rather than stretching across the column. The Channels directory has a centered 1200px ceiling. Do not apply Settings' form width to collection tables.

The side dialog is 620px at the edge, expands to 980px, and fills the phone viewport. Its 46px record toolbar remains separate from the native scrolling body. See [layout ownership](docs/frontend-layout.md) for scroll boundaries and responsive details.

## Elevation & Depth

Depth is mostly tonal and structural: opaque surfaces, one intentional border, and restrained shadows. Buttons/cards use the subtle shared shadow roles; raised controls and overlays use stronger named roles. Dark mode removes the resting card shadow while retaining overlay separation. Never stack borders, rings, and shadows to describe the same boundary.

The exact theme-aware shadow recipes live in `tokens.css`; the sidecar references those live variables rather than freezing a second palette. Shared motion uses the existing implementation and entrance/exit easing. There is one animation path, not an app motion preference or alternate-mode branch. Existing native CSS accessibility media queries remain independent of application modes.

## Shapes

Corners follow the chip/control/card/window scale in frontmatter. Compact tooltips use their own 5px radius. The inverse selection pill uses the window radius rather than a fully rounded capsule. Avatars and native choice controls retain their own semantic shapes; do not impose card geometry on them.

## Components

### Buttons and fields

Canonical [Button](frontend/shared/src/components/ui/button.tsx) owns primary, destructive, outline, secondary, ghost, and link variants, with shared hover/active/disabled/focus states. Default controls are 30px, small controls 26px, and large controls 36px. [Input](frontend/shared/src/components/ui/input.tsx) owns field fill, strong boundary, accent focus, and native checkbox/radio exceptions. Keep visible labels and validation in the consuming feature.

### Cards and metadata

[Card](frontend/shared/src/components/ui/card.tsx) supplies the shared opaque surface, quiet line, card corners, and restrained shadow. Metadata badges and status atoms use their existing variants; do not turn every label into an action or give inert metadata invented keyboard behavior.

### Navigation

The rail uses quiet text and neutral selected rows, not accent-filled navigation. Its footer has one compact 36px avatar/name account trigger with trailing chevrons and an avatar-only collapsed state. A 260px menu contains real identity details, Account settings, inline Light/Dark/System theme segments with matching icons, and Sign out. Theme changes apply immediately without closing the menu and reuse the shared preference owner. Unsupported reference profile/presence/shortcut actions are absent.

**The One Icon Column Rule.** Every rail row reserves the same 16px leading slot. A larger 24px identity avatar centers inside that slot instead of widening it, so icons, labels, and the account name share one axis.

**The Gliding Highlight Rule.** Rail rows never paint their own hover fill. One shared pill (`SidebarGlideHighlight`) springs to the hovered row and fades out on leave, in the workspace rail and the Settings section rail alike, while the row keeps its labels, focus ring, and selected surface above it.

### Filters and tooltips

Canonical field-row filters share Where/and rows, equality controls, Add filter chips, clear/remove actions, and active-value chips. Tooltips use compact inverse ink, a 350ms opening delay, 120ms fade, and 6px offset. Radix owns portals, collision handling, focus, and Escape.

### Selection and dialogs

The floating selection pill uses inverse ink, separators, a real count, supported actions, and icon-only Deselect. Select-all is checked only when every visible item is selected; partial selection remains visually unchecked.

Use CenterDialog for focused work, CenterAlertDialog for destructive confirmation, and SideDialog for Post inspection. Feature content supplies real Post properties, attachments, caption, and independent Channel outcomes. Preserve keyboard dismissal, focus containment, opener restoration, and pending/error states. Do not duplicate drawer actions in a footer.

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
