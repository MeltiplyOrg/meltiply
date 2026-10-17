# Applying the current visual system

Meltiply adapts [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio) to real publishing workflows. [`frontend/shared/tokens.css`](../../../frontend/shared/tokens.css) is the implementation source for fonts, palette, density, radius, and elevation. [Layout](../../../docs/frontend-layout.md) owns route geometry and scrolling; [shared UI ownership](../../../docs/frontend-ui.md) owns reusable modules. Read these sources instead of maintaining another token table here.

## Surfaces and color

Use the warm off-white/stone light palette and warm charcoal dark layers. Posts, Channels, and Settings use consistent content backgrounds; domain-specific compositions may differ without inventing another palette. Indigo/periwinkle identifies primary actions and focus. Neutral navigation selection stays distinct from accent-filled actions. Provider colors identify platforms; semantic status colors carry labels or accessible icons.

Use semantic utilities such as `bg-page`, `bg-canvas`, `bg-surface`, `bg-field`, `text-ink`, `text-ink-2`, `text-ink-3`, and `border-line`. Shared menu, tooltip, card, and dialog variants own their states and boundaries.

## Type and composition

Self-hosted Geist is the interface face; Geist Mono is for code, identifiers, and shortcut hints. Use shared type/density/radius utilities rather than per-page values. Keep Meltiply's faceted mark and canonical interface/provider icons.

Posts uses the grouped spreadsheet, flush Month/Week calendar, and media Grid over the same real records. Channels uses the centered Members-style account directory and real Brand Profile cards. Settings uses one 672px maximum content column across all sections, with compact wrapping theme cards. Drawer, tooltip, filter, and selection-pill treatments come from their shared implementations; do not recreate them in features.

## Implementation and adaptation

Rewritten app components are strict TypeScript/React with Tailwind utilities and `cn`. Shared CSS owns global tokens/reset/focus and browser interop; public Astro/Fumadocs adapters resolve the same tokens. Route code owns data and supported actions rather than a parallel style system.

Keep the current visual identity during cleanup. Remove unused definitions, duplicate wrappers, obsolete selectors, aliases, and stale guidance only with consumer evidence. Preserve existing animation recipes; future animation work extends the same owners without restoring a separate mode.

Use real Post, Channel, Brand Profile, and account data. Reference-only task fields, seed records, logos, member photos, billing, notifications, and team-administration controls do not become Meltiply capabilities.
