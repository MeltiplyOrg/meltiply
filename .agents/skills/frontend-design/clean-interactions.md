# Clean Interactions & Motion

Motion in this design system confirms actions without layout shift. Everything
below maps to components that exist; inventing a new interaction component goes
through the new-shared-component gate in `SKILL.md`.

## Speed and tactility

- Durations 150–300ms on `cubic-bezier(0.16, 1, 0.3, 1)` (enter) or
  `cubic-bezier(0.23, 1, 0.32, 1)` (exit); keyframes live in `frontend/shared/motion.css`.
- Looping animation only for loaders; everything else plays once.
- Every interactive control carries five states: idle (`border-line bg-surface`),
  hover (`hover:bg-hover`), focus-visible (`ring-1 ring-line-strong`), active
  (`active:scale-[0.98]`), disabled (`opacity-40`).

## Sliding hover highlight

`SlidingMenuHighlight` / `SidebarGlideHighlight` (`@meltiply/ui/sidebar-glide-highlight`)
renders one floating pill that glides between items in a container instead of
flashing per-row backgrounds:

```tsx
<SidebarGlideHighlight containerRef={navRef} itemSelector="[data-nav-row]" />
```

## Spatial continuity

When state changes a control's label or size, keep the control mounted and morph
its geometry with `layout`/`LayoutGroup` (installed `motion` package); crossfade
the label through a keyed `motion.span` in `AnimatePresence mode="popLayout"`.
Unmount-and-remount resets focus, breaks screen-reader identity, and reads as a
glitch. Use plain state changes — no motion — when geometry does not move.

## Dialog exit stability

Dialogs stay mounted through their exit animation, so content that depends on
the value that opened them must hold that value: render from
`useLatchedValue(value)` (`@meltiply/ui/use-latched-value`) while `open` tracks
the live value. Example: a post panel keeps showing the post after `post`
becomes `null` on close, instead of blanking mid-slide.
