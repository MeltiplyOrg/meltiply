# Shared UI ownership and reuse

See also [frontend-layout.md](frontend-layout.md) for the workspace alignment, density, responsive, and scroll-ownership contract.

## Review findings

The UI had a shared visual system but incomplete component ownership:

- [`frontend/shared`](../frontend/shared) already owned tokens, animated icons,
  motion and theme preferences, consent, clipboard handling, and notification
  state. Most reusable React controls still lived under
  `frontend/app/src/components/ui`, limiting discovery to the app.
- The app's shadcn configuration generated controls into its local UI directory.
  Repeated requests to add UI therefore had a sanctioned path for new local
  implementations rather than a shared-library destination.
- The raw-control lint rule exempted every local `components/ui` file. Naming a
  new local wrapper as a primitive bypassed the reuse requirement.
- Root Oxlint excluded landing and docs. Astro type/build checks validate code,
  but do not establish shared component ownership or prevent copied controls.
- Public surfaces already shared [`public.css`](../frontend/shared/public.css),
  but repeating markup still left semantics, labels, attributes, and behavior
  vulnerable to drift. Shared CSS alone is not a component contract.
- Several components duplicated a purpose already covered by a shared one. They
  were removed: `HoldButton` (destructive confirmation, now `AlertDialog`),
  `QueryError` (now `Alert` with a retry `Button`), the app toaster wrapper (now
  `@meltiply/ui/toast`), the unmounted `QuotaWarning` banner, and the local
  `BrandMark.astro` adapter. `StatusBadge` now renders `StatusPill`.

## Ownership

[`@meltiply/ui`](../frontend/shared/package.json) is the canonical shared UI
workspace. Import its explicit subpaths; inspect its implementation and a real
caller before changing UI.

| UI responsibility                                                                   | Owner                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Reusable React controls and feedback surfaces                                       | `frontend/shared/src/components/ui`                     |
| Generic composed React patterns                                                     | `frontend/shared/src/components/atoms` and `primitives` |
| Static public-site controls and compositions                                        | `frontend/shared/src/components/public`                 |
| Tokens, public styles, icons, motion, theme, consent, clipboard, notification state | Existing modules in `frontend/shared`                   |
| App data, routing, translations, provider identity, workflow compositions           | `frontend/app/src/components`                           |
| Documentation navigation, search, article transitions and reading rail              | `frontend/public/src/components`                        |
| Marketing content and product demonstrations                                        | `frontend/public/src`                                   |

Sharing does not mean making every page a generic template. Keep business state
and route-specific content local. Share controls and genuine repeated compositions
whose semantics and behavior are the same. An app-bound wrapper may translate
labels or bind queries while composing the shared primitive; it must not copy the
primitive's implementation.

React controls use imports such as `@meltiply/ui/button`, not the retired
app-local primitive paths. Static Astro public controls use
`@meltiply/ui/public/<component>`. Shared implementations cannot import app or
public-site internals. Public Astro markup stays static; reuse is not a reason to add
React hydration to links, buttons, brand marks, or structural chrome.

The public shell owns one Lenis document controller in
[`public-scroll.ts`](../frontend/public/src/scripts/public-scroll.ts), shared by
landing and docs. Wheel inertia carries a longer coast; TOC links use a bounded 320ms
heading pull while Astro retains fragment history. Touch, keyboard and nested
overflow remain native. Manual/OS low motion disables smoothing immediately,
and route preparation releases inertia before Astro restores scroll positions.

Interface glyphs use `lucide-react` across the app, docs, and landing; Astro
renders static glyphs without client hydration. Shared animated icons preserve
the same Lucide-derived geometry and two-pixel default stroke. Provider logos
and the reading-rail artwork are identity/progress illustrations, not a second
interface icon pack; app provider logos stay in `PlatformIcon`.

Docs heading-copy controls publish success or failure through the shared
`@meltiply/ui/toast` store. Success details include the exact copied section URL;
failure retains selected manual-copy recovery. The persistent docs shell mounts
the canonical `Toaster`, stacked above cookie consent so its actions stay usable.

### Dialogs

There are exactly two dialog types. Pick by size and purpose; never add a third.

| Type                  | Import                                                       | Use for                                                                                                       |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Centered              | `CenterDialog*` from `@meltiply/ui/center-dialog`            | Compact forms and short focused tasks, shown in the middle of the screen                                      |
| Centered confirmation | `CenterAlertDialog*` from `@meltiply/ui/center-alert-dialog` | Destructive or irreversible confirmations; same placement and motion, cannot be dismissed by clicking outside |
| Side                  | `SideDialog` from `@meltiply/ui/side-dialog`                 | Large inspection panels that slide in from the right edge, such as Post details                               |

Centered dialogs own their motion: the first of a sequence pops up from the bottom
edge and the last one to leave pops out to it, while a handoff between two centered
dialogs morphs one opaque box from the currently visible size into the next in
place. Only the contents crossfade and slide sideways; covered forms remain
mounted, and cancelling a confirmation morphs back without losing input.
The backdrop stays steady across handoffs. Callers get that handoff for free — do not add entrance or exit
animations, and do not read or write `data-dialog-motion` from feature code.

## Agent workflow

1. Read [the product UI contracts](../PRODUCT.md#modular-consistent-surfaces),
   the shared package exports, the matching implementation, and an existing caller.
2. Choose an installed primitive, then an existing composition. Use its variants,
   focus, feedback, and motion contracts. Page code supplies content and layout.
3. When an actual capability is missing, extend the canonical implementation.
   Create a new shared module only after identifying why existing interfaces cannot
   express the behavior. Document that decision in the change description.
4. Keep genuinely domain-specific compositions beside their domain consumers.
   Repeated generic interaction or styling belongs in the shared workspace.
5. Migrate every affected caller and remove replaced definitions. Preserve keyboard
   behavior, accessible names, focus identity, reduced motion, and static rendering.
6. Run the affected workspace checks and the shared ownership gate; exercise the
   changed surface in a browser. Lint is an ownership guard, not visual proof.

The app and shared shadcn configurations resolve UI generation into the shared
workspace. Run `bunx --bun shadcn@latest info --json` from `frontend/app` to inspect
`resolvedPaths.ui` before installing; generated source needs review and the same
reuse and verification rules as handwritten source.

## Enforcement limits

Hard checks can enforce canonical ownership, import restrictions, and known
control contracts. They cannot prove that two arbitrarily named compositions are
semantically identical. Review must still compare existing shared modules before
accepting a new abstraction. Avoid similarity thresholds or growing exception
baselines: they hide duplication instead of resolving its ownership.
