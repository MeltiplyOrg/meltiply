export type Theme = "light" | "dark";

let pendingPaletteChanges = 0;

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
