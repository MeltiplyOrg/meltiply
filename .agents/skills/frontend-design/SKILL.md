---
name: frontend-design
description: Build or restyle Meltiply React or Astro interfaces with the Gr8r-adapted shared UI system. Use for components, layout, controls, settings, search, and dialogs.
---

# Frontend Design

> Modified for Meltiply from historical Anthropic frontend-design guidance.
> Original material retains [Apache-2.0](../../../LICENSES/anthropic-frontend-design.txt);
> see [third-party notices](../../../THIRD_PARTY_NOTICES.md).

Meltiply adopts Gr8r Studio's warm, compact workspace design while retaining its
own publishing features and brand. [Product conventions](../../../PRODUCT.md#modular-consistent-surfaces)
own behavior; [shared UI ownership](../../../docs/frontend-ui.md) owns component
boundaries; [layout](../../../docs/frontend-layout.md) owns geometry. The source
reference is not authority to invent capabilities.

## Workflow

1. Read relevant contracts, shared exports, the matching implementation, and a real caller. Trace exported references with the language server before changing an interface.
2. Reuse canonical React controls and page compositions. Keep Post/Channel data, permission checks, async status, labels, and actions in the consuming feature.
3. New or rewritten app React components use strict TypeScript/TSX and Tailwind utilities. Compose shared primitives; use `cn` for state/caller classes and semantic tokens from `frontend/shared/tokens.css`. Do not copy CSS-heavy markup, add page-specific CSS selectors, or duplicate a shared control. Shared CSS is reserved for palette tokens, global reset/focus, and unavoidable browser interop.
4. Extend an existing shared primitive where possible: `Table` for Posts and Channels, `PostCard` for Board/Grid, shared toolbar/filter/chip patterns, tabs, and sidebar rows. Give a new shared component one clear reusable contract; never mirror an existing component under a new name.
5. Preserve the Gr8r-adapted visual grammar: flat warm surfaces, indigo actions, Geist type, compact densities, restrained borders, aligned gutters, and neutral selected states. Keep Meltiply identity, real provider marks, and real product outcomes. [Theme reference](theme-gr8r.md) records semantic values.
6. Follow [interaction guidance](clean-interactions.md): immediate navigation, stable control identity, visible focus, actionable failures, and canonical dialog ownership. Preserve drafts, selection, auth boundaries, and recoverable errors. Do not fake reference-only actions such as changing a publication outcome by dragging a card.
7. Update every affected caller and user-facing guide. Run affected frontend checks on GitHub-hosted runners unless local verification is explicitly authorized. Exercise the actual changed desktop/mobile surface in both themes.

## Completion criteria

- Canonical primitives and compositions are reused; no parallel per-page CSS or duplicated controls remain.
- Reference-derived List, Board, Table, directory, profile, navigation, search, and Settings compositions use real Meltiply data and supported behavior.
- Empty, loading, disabled, hover, focus-visible, selected, and recoverable-error states remain reachable.
- Keyboard navigation, focus restoration, mobile access, reduced-motion behavior, and horizontal table overflow work without relying on decorative transitions.
- Required frontend checks pass and hosted browser evidence covers the changed behavior.
- Product instructions and public guides describe the shipped interface, not retired themes, CSS structures, or reference-only demo features.
