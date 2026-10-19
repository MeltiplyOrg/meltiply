---
name: frontend-design
description: Add, restyle, or document Meltiply UI by extending canonical shared owners, so every surface keeps the Gr8r-adapted system. Use for controls, layout, settings, search, dialogs, and animation changes.
---

# Frontend Design

> Modified for Meltiply from historical Anthropic frontend-design guidance.
> Original material retains [Apache-2.0](../../../LICENSES/anthropic-frontend-design.txt);
> see [third-party notices](../../../THIRD_PARTY_NOTICES.md).

Preserve the current warm, compact Gr8r-adapted interface and Meltiply's real publishing behavior. The reference supplies visual language, not additional product capabilities.

## Owner lookup

Every element in scope resolves to an owner before UI is written: each control, panel, and surface cites the shared owner it extends, and only a genuine contract gap produces a new one.

1. Read [product UI intent](../../../PRODUCT.md#modular-consistent-surfaces), [the visual system](../../../DESIGN.md), [shared ownership](../../../docs/frontend-ui.md), [layout](../../../docs/frontend-layout.md), and the [capability inventory](../../../docs/frontend-capabilities.md).
2. Match each element against the ownership sources — `frontend/shared/package.json` exports, the canonical tables in [`lint/ui-contract-lib.mjs`](../../../lint/ui-contract-lib.mjs), and `frontend/shared/src/components/**` — then read the matched component, its variants, and one real caller. Trace exported interfaces through the language server.
3. Extend the matched owner through its variant, size, prop, or slot where its contract carries the variation. Add a shared owner only when the contract genuinely differs and a second surface needs it; keep composition, real data, permissions, labels, pending state, and actions in the consuming feature. Name the owner you extend, or the gap you fill, before editing.

## Build

4. Use semantic tokens and `cn`. Public Astro adapters resolve the same tokens without a second React implementation.
5. Preserve the page grammar: one Posts destination with Table → Calendar → Grid; a Members-style Channels directory; one shared Settings content width; canonical filters, tooltips, selection pill, and Post drawer. Consult [visual application](theme-gr8r.md) and [interaction ownership](clean-interactions.md) for the affected branch.
6. Preserve the existing animation implementation. There is one animation path, without a motion-mode provider, preference state, mode props, or alternate branches. Requested animation work extends shared primitives and recipes; it does not require mode-specific guards.
7. Migrate every affected caller, remove the obsolete definition, alias, wrapper, or style, and update the relevant public guide. Keep actual provider outcomes, draft recovery, authentication, and confirmation behavior intact.

## Verify

8. Run the repository [completion gate](../../../AGENTS.md#completion-gate) for the changed area on GitHub-hosted runners unless local execution is explicitly authorized. Its lint step applies the `boundaries/*` rules and [`lint/astro-ui-contract.mjs`](../../../lint/astro-ui-contract.mjs), which report a canonical-stem clone by naming the owner to import instead.
9. Re-read the diff for a second implementation: the same control, chrome, or token set written twice, a wrapper that only forwards props, or a new file whose stem matches an existing owner. Exercise the changed desktop and phone surfaces in both palettes and inspect real states rather than treating compilation as UI proof.

## Completion

- Every element in scope cites the owner it extends or the recorded gap it fills, so one control keeps one implementation; tokens, geometry, states, and copy resolve through the shared owners and existing localization.
- Replaced code has no callers; supported data and actions remain reachable; hover, focus, busy, empty, failure, and recovery states work; nested scrolling and responsive layouts remain usable; instructions and public guides describe the shipped interface.
- Report the owners you extended, the exact verification results, and any environment blocker.
