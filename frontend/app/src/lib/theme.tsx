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

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
