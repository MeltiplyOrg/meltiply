---
name: frontend-design
description: Build or restyle Meltiply React or Astro interfaces with the Gr8r-adapted shared UI system. Use for components, layout, controls, styling, settings, search, and dialogs.
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

1. Read the relevant contracts, list `frontend/shared/package.json` exports, and
   inspect the matching primitive and a real caller. Reuse the canonical module;
   a differently named copy is still duplication.
2. Extend an existing variant or compose it with local route data. Reusable React
   controls belong in `frontend/shared/src/components/ui`; app navigation,
   settings, search, labels, and data ownership stay in `frontend/app`.
   New shared modules require approval and a reason existing interfaces cannot
   express the behavior. Static public controls remain Astro, not hydrated React.
3. Use semantic tokens from `frontend/shared/tokens.css`. [Visual reference](theme-gr8r.md)
   explains their roles. Keep warm surfaces, indigo primary actions, Geist type,
   compact geometry, and theme-independent layout. Provider marks use `PlatformIcon`.
4. Follow [interaction guidance](clean-interactions.md): immediate navigation,
   stable control identity, visible focus, actionable failures, and shared dialog
   ownership. Preserve draft state, selection, auth boundaries, and recovery.
5. Update every affected caller and user-facing guide. Run affected frontend
   checks on GitHub-hosted runners unless local verification is explicitly
   authorized. Exercise the actual changed desktop/mobile surface in both themes.

## Completion criteria

- Existing primitives extended rather than copied; new shared files approved.
- Every surface follows the shared palette and compact layout, including empty,
  loading, disabled, hover, focus-visible, selected, and recoverable-error states.
- Keyboard navigation, focus restoration, mobile reachability, and reduced motion
  work without depending on decorative transitions.
- Required frontend checks pass and browser evidence covers the changed behavior.
- Product instructions and public guides describe the shipped interface, not the
  retired striped canvas, theme reveal, or reference-only demo features.
