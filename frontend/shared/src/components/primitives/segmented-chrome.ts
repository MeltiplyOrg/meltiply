/**
 * One visual grammar for every segmented track: the compact value selector, the
 * segment tab strip, and the account menu's theme segments. Layout variants keep
 * their own extras, but the track, the travelling indicator, and each item's
 * geometry come from here so a segment never drifts between owners.
 */

/**
 * 28px track that hugs its items unless the caller sets a width or `fill`. Items
 * start at the leading edge so a constrained track that scrolls (for example
 * `max-w-full overflow-x-auto` on phones) keeps its first option at the scroll
 * origin instead of hiding it in unreachable negative overflow. The minimum
 * height, not a fixed height, lets a coarse-pointer track grow around 44px
 * items while fine pointers keep the 28px band.
 */
export const SEGMENTED_TRACK =
  "relative inline-flex min-h-7 shrink-0 items-center justify-start gap-0.5 rounded-control bg-hover-2 p-0.5";

/**
 * The one selected fill. It is rendered by `SlidingHighlight` behind the items,
 * never painted by an item itself, so selection travels instead of repainting.
 */
export const SEGMENTED_INDICATOR = "inset-y-0.5 border-transparent bg-surface shadow-btn";

/**
 * 24px item above the indicator, with the shared 44px minimum on coarse
 * pointers (`min-height` yields the fixed height, so the track grows with it).
 * The caller adds `flex-1` when options share the track's width; focus, hover,
 * and disabled treatment stay identical everywhere.
 */
export const SEGMENTED_ITEM =
  "relative z-10 inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-control px-2.5 text-xs font-medium text-ink-2 outline-none transition-colors pointer-coarse:min-h-11 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45";

/**
 * Label treatment for the item the indicator currently covers. State-driven
 * owners add their own selector (for example `data-[state=active]:text-ink`),
 * because the selected state belongs to their primitive; native buttons use this
 * class directly.
 */
export const SEGMENTED_SELECTED = "text-ink";
