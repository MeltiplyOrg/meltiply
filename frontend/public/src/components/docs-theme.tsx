import { createContext, useMemo, type ReactElement, type ReactNode } from "react";
import { useThemeController } from "@meltiply/ui/theme-controller-react";
import type { Theme } from "@meltiply/ui/theme-transition";

export const DocsThemeContext = createContext<{
  requestedTheme: Theme | null;
  resolvedTheme: Theme;
  toggleTheme: () => void;
} | null>(null);

/**
 * Thin public-site adapter over the shared theme controller. Explicit
 * current-page intent survives hydration and is stored only with functional
 * consent. Changes commit synchronously without an ink clone or delayed mask;
 * unpinned pages follow live OS color-scheme changes. System intent remains
 * unpinned so the button always describes the next explicit choice.
 */
export function DocsThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const { controller, state } = useThemeController();
  const value = useMemo(
    () => ({
      requestedTheme:
        state.requestedTheme === "light" || state.requestedTheme === "dark"
          ? state.requestedTheme
          : null,
      resolvedTheme: state.theme,
      toggleTheme: controller.toggleTheme,
    }),
    [controller, state],
  );

  return <DocsThemeContext value={value}>{children}</DocsThemeContext>;
}
