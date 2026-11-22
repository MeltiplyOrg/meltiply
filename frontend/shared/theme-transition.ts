export type Theme = "light" | "dark";

let pendingPaletteChanges = 0;

/**
 * Applies a palette change with color transitions suppressed, so every surface repaints at once.
 * Suppression lasts two frames past the last overlapping change, until the new palette has painted.
 */
export function applyThemeImmediately(applyTheme: () => void): void {
  const root = document.documentElement;
  pendingPaletteChanges += 1;
  root.classList.add("theme-changing");
  try {
    applyTheme();
  } finally {
    pendingPaletteChanges -= 1;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pendingPaletteChanges === 0) root.classList.remove("theme-changing");
      }),
    );
  }
}
