import { createContext, useContext, useMemo } from "react";
import { useThemeController } from "@meltiply/ui/theme-controller-react";
import type { ThemePreference } from "@meltiply/ui/theme-preference";
import type { Theme } from "@meltiply/ui/theme-transition";

interface ThemeContextValue {
  requestedTheme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  requestedTheme: "system",
  setTheme: () => undefined,
  theme: "dark",
  toggleTheme: () => undefined,
});

/**
 * Thin application adapter over the shared theme controller. Current-page
 * choices work without optional storage; consent withdrawal drops persisted
 * intent, and transferred pre-hydration intent survives first paint. System
 * intent stays distinct from its resolved palette and follows live OS changes.
 * Repeated toggles resolve against the committed palette immediately.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { controller, state } = useThemeController();
  const value = useMemo<ThemeContextValue>(
    () => ({
      requestedTheme: state.requestedTheme,
      setTheme: controller.setTheme,
      theme: state.theme,
      toggleTheme: controller.toggleTheme,
    }),
    [controller, state],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/** Reads the single application theme owner for controls and appearance cards. */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
