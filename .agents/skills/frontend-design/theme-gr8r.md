# Gr8r-adapted visual reference

The visual authority is [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio),
adapted to Meltiply's publishing workflows. Exact values live in
`frontend/shared/tokens.css`; consult that file rather than maintaining a second
token-value table here.

## Palette and surfaces

Use warm off-white for the page, stone for navigation, and opaque surfaces for
content. Dark mode uses warm charcoal layers, not a blue-black inversion. Indigo
is the primary action and focus color; periwinkle is its dark counterpart.
Neutral selected navigation is distinct from accent-filled actions. Semantic
green, amber, and red communicate confirmed success, attention, and failure with
labels or icons. Provider colors identify external accounts only.

Use `bg-page/canvas/surface/inset/field`, `text-ink/ink-2/ink-3`,
`border-line/line-strong/line-soft`, `bg-primary`, `text-primary-foreground`, and
`bg-accent-tint`. Backgrounds are flat; the retired stripe tokens and pattern are
not part of the design. Use opaque menus/dialogs; never reduce essential text
contrast with arbitrary opacity.

## Typography and geometry

- Self-hosted Geist for interface text; Geist Mono for identifiers, code, and
  keyboard hints. Use semibold for titles and medium for controls.
- 23px page title, about 13.5px working text, 12px secondary labels, and 11–12px metadata.
- Desktop rail 252px, collapsed rail 52px, top bar 46px, content gutter 24px.
- Controls 30px, small controls 26px, large controls 36px. Mobile navigation and
  important touch actions use 44px targets rather than desktop density.
- Radii: `rounded-chip` 4px, `rounded-control` 6px, `rounded-card` 8px,
  `rounded-window` 10px.
- Use 4pt spacing, tighter within groups and larger between tasks.

## Elevation

A surface gets one crisp boundary. `shadow-card` is quiet, not a second hairline
ring under an existing border. Menus and dialogs may use `shadow-overlay`; dark
cards rely on borders rather than luminous shadows. Content grids use compact
cards; tables use neutral headers and thin row separators. Toolbars are flat
rows, not another nested card.

## Adaptation boundaries

Keep Meltiply's faceted logo, Post/Channel/Brand Profile terms, real account data,
and existing publication semantics. Gr8r project/task seed content, its logo,
member photos, billing, notifications, and collaboration features do not ship as
Meltiply capabilities. Settings exposes only working preferences and account
security. Jump search covers pages and loaded Brand Profiles; route filters own
content search.
