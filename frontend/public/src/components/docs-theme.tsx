import { createContext, useMemo, type ReactElement, type ReactNode } from "react";
import { useThemeController } from "@meltiply/ui/theme-controller-react";
import type { Theme } from "@meltiply/ui/theme-transition";

export const DocsThemeContext = createContext<{
  requestedTheme: Theme | null;
  resolvedTheme: Theme;
  toggleTheme: () => void;
} | null>(null);

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
