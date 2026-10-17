---
name: frontend-design
description: Build, restyle, or document Meltiply React and Astro interfaces using the current Gr8r-adapted shared system. Use for components, layout, controls, settings, search, dialogs, and animation changes.
---

# Frontend Design

> Modified for Meltiply from historical Anthropic frontend-design guidance.
> Original material retains [Apache-2.0](../../../LICENSES/anthropic-frontend-design.txt);
> see [third-party notices](../../../THIRD_PARTY_NOTICES.md).

Preserve the current warm, compact Gr8r-adapted interface and Meltiply's real publishing behavior. The reference supplies visual language, not additional product capabilities.

## Workflow

1. Read [product UI intent](../../../PRODUCT.md#modular-consistent-surfaces), [shared ownership](../../../docs/frontend-ui.md), [layout](../../../docs/frontend-layout.md), and the [capability inventory](../../../docs/frontend-capabilities.md). Read the affected implementation, shared exports, and a real caller before changing a control. Trace exported interfaces through the language server.
2. Extend the canonical TypeScript/React/Tailwind component or composition. Use semantic tokens and `cn`; keep Post/Channel data, permissions, selection, async status, labels, and actions in the consuming feature. Public Astro adapters share those tokens without duplicating React behavior.
3. Preserve the page grammar: one Posts destination with Table → Calendar → Grid; a Members-style Channels directory; one shared Settings content width; canonical filters, tooltips, selection pill, and Post drawer. Consult [visual application](theme-gr8r.md) and [interaction ownership](clean-interactions.md) for the affected branch.
4. Preserve the existing animation implementation. There is one animation path, without a motion-mode provider, preference state, mode props, or alternate branches. Requested animation work extends shared primitives and recipes; it does not require mode-specific guards.
5. Migrate every affected caller, remove obsolete definitions/aliases/styles, and update the relevant public guide. Keep actual provider outcomes, draft recovery, authentication, and confirmation behavior intact.
6. Run the scoped repository gate on GitHub-hosted runners unless local execution is explicitly authorized. Exercise the changed desktop/phone surface and both palettes; inspect actual states and screenshots rather than treating compilation as UI proof.

## Completion

The changed flow uses canonical owners; replaced code has no callers; supported data/actions remain reachable; hover, focus, busy, empty, failure, and recovery states work; nested scrolling and responsive layouts remain usable; and instructions/public guides describe the shipped interface. Report exact verification results and any environment blocker.
