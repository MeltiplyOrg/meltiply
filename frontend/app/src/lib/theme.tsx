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
 * Owns the application's immediate palette and consent-aware persistence.
 * Current-page choices work without optional storage; consent withdrawal drops
 * persisted intent, and transferred pre-hydration intent survives first paint.
 * System intent stays distinct from its resolved palette and follows live OS
 * changes. Repeated toggles resolve against the committed palette immediately.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [requestedTheme, setRequestedThemeState] = useState<ThemePreference>(
    () => readInitialThemePreference() ?? "system",
  );
  const [theme, setThemeState] = useState(() => resolveTheme(requestedTheme, prefersDarkScheme()));

  const committedRef = useRef(theme);
  const requestedRef = useRef<ThemePreference>(requestedTheme);
  const mountedRef = useRef(false);
  const hasSelectedThemeRef = useRef(
    typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme-preference") === requestedTheme,
  );

  const commitPalette = useCallback((next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.style.colorScheme = next;
    committedRef.current = next;
    if (mountedRef.current) setThemeState(next);
  }, []);

  const setTheme = useCallback(
    (preference: ThemePreference) => {
      requestedRef.current = preference;
      if (mountedRef.current) setRequestedThemeState(preference);
      hasSelectedThemeRef.current = true;
      writeThemePreference(preference);
      const nextTheme = resolveTheme(preference, prefersDarkScheme());
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    },
    [commitPalette],
  );

  const toggleTheme = useCallback(() => {
    setTheme(committedRef.current === "dark" ? "light" : "dark");
  }, [setTheme]);

  const applyExternalPreference = useCallback(
    (preference: ThemePreference | null) => {
      if (preference !== null && preference === requestedRef.current) return;
      if (preference === null && hasSelectedThemeRef.current && hasCookieConsent("functional")) {
        return;
      }
      const nextTheme = resolveTheme(preference, prefersDarkScheme());
      requestedRef.current = preference ?? "system";
      if (mountedRef.current) setRequestedThemeState(preference ?? "system");
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    },
    [commitPalette],
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (requestedRef.current !== "system") return;
      const nextTheme = media.matches ? "dark" : "light";
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [commitPalette]);

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
