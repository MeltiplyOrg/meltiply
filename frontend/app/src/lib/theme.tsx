import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hasCookieConsent, subscribeCookieConsent } from "@meltiply/ui/cookie-consent";
import {
  readInitialThemePreference,
  readThemePreference,
  subscribeThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "@meltiply/ui/theme-preference";
import { applyThemeImmediately } from "@meltiply/ui/theme-transition";

export type Theme = "light" | "dark";

/** Resolves an explicit light/dark choice before falling back to the device palette. */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/** Reads the device palette safely; missing browser/media-query support uses light. */
function prefersDarkScheme(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

interface ThemeContextValue {
  requestedTheme: Theme;
  setTheme: (theme: Theme) => void;
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  requestedTheme: "dark",
  setTheme: () => undefined,
  theme: "dark",
  toggleTheme: () => undefined,
});

/**
 * Owns the application's immediate palette and consent-aware persistence.
 * Current-page choices work without optional storage; consent withdrawal drops
 * persisted intent, and transferred pre-hydration intent survives first paint.
 * Repeated toggles resolve against the latest request without a reveal timer.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [theme, setThemeState] = useState(() =>
    resolveTheme(readInitialThemePreference(), prefersDarkScheme()),
  );
  const [requestedTheme, setRequestedThemeState] = useState<Theme>(theme);

  const committedRef = useRef(theme);
  const requestedRef = useRef(theme);
  const mountedRef = useRef(false);
  const hasSelectedThemeRef = useRef(
    typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme-preference") === theme,
  );

  const commitPalette = useCallback((next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.style.colorScheme = next;
    committedRef.current = next;
    if (mountedRef.current) setThemeState(next);
  }, []);

  const setTheme = useCallback(
    (nextTheme: Theme) => {
      requestedRef.current = nextTheme;
      if (mountedRef.current) setRequestedThemeState(nextTheme);
      hasSelectedThemeRef.current = true;
      writeThemePreference(nextTheme);
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    },
    [commitPalette],
  );

  const toggleTheme = useCallback(() => {
    setTheme(requestedRef.current === "dark" ? "light" : "dark");
  }, [setTheme]);

  const applyExternalPreference = useCallback(
    (preference: ThemePreference | null) => {
      if (preference === requestedRef.current) return;
      if (preference === null && hasSelectedThemeRef.current && hasCookieConsent("functional")) {
        return;
      }
      const nextTheme = resolveTheme(preference, prefersDarkScheme());
      requestedRef.current = nextTheme;
      if (mountedRef.current) setRequestedThemeState(nextTheme);
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    },
    [commitPalette],
  );

  useEffect(() => {
    let functionalConsent = hasCookieConsent("functional");
    const unsubscribeTheme = subscribeThemePreference(applyExternalPreference);
    const unsubscribeConsent = subscribeCookieConsent(() => {
      const nextFunctionalConsent = hasCookieConsent("functional");
      if (nextFunctionalConsent === functionalConsent) return;
      functionalConsent = nextFunctionalConsent;
      if (!nextFunctionalConsent) {
        hasSelectedThemeRef.current = false;
        applyExternalPreference(null);
        return;
      }
      const preference = readThemePreference();
      if (preference !== null) {
        applyExternalPreference(preference);
      } else if (hasSelectedThemeRef.current) {
        writeThemePreference(requestedRef.current);
      }
    });
    return () => {
      unsubscribeTheme();
      unsubscribeConsent();
    };
  }, [applyExternalPreference]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    committedRef.current = theme;
    applyThemeImmediately(() => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    });
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ requestedTheme, setTheme, theme, toggleTheme }),
    [requestedTheme, setTheme, theme, toggleTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/** Reads the single application theme owner for controls and appearance cards. */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export { ThemeContext };
