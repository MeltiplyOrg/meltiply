export type Theme = "light" | "dark";

let pendingPaletteChanges = 0;

/**
 * Keeps palette paints synchronous instead of running independent component
 * fades. Counted, idempotent releases survive overlapping cancellation; two
 * frames keep transitions disabled until the final root palette has painted.
 */
function suppressPaletteTransitions(): () => void {
  const root = document.documentElement;
  pendingPaletteChanges += 1;
  root.classList.add("theme-changing");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingPaletteChanges -= 1;
    if (typeof requestAnimationFrame !== "function") {
      if (pendingPaletteChanges === 0) root.classList.remove("theme-changing");
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pendingPaletteChanges === 0) root.classList.remove("theme-changing");
      }),
    );
  };
}

/** Commits an originless palette change without per-component color fades. */
export function applyThemeImmediately(applyTheme: () => void): void {
  const release = suppressPaletteTransitions();
  try {
    applyTheme();
  } finally {
    release();
  }
}
