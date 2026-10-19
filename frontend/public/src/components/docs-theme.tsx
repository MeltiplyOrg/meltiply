import {
  createContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { applyThemeImmediately, type Theme } from "@meltiply/ui/theme-transition";
import {
  readInitialThemePreference,
  subscribeThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "@meltiply/ui/theme-preference";

/** Resolves an unpinned theme from the device; unsupported media queries use light. */
function readSystemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export const DocsThemeContext = createContext<{
  requestedTheme: Theme | null;
  resolvedTheme: Theme;
  toggleTheme: () => void;
} | null>(null);

/**
 * Owns the public palette across persisted Astro guide navigation. Explicit
 * current-page intent survives hydration and is stored only with functional
 * consent. Changes commit synchronously without an ink clone or delayed mask;
 * unpinned pages follow live OS color-scheme changes.
 */
export function DocsThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );
  const [requestedTheme, setRequestedTheme] = useState<Theme | null>(() => {
    const preference = readInitialThemePreference();
    return preference === "light" || preference === "dark" ? preference : null;
  });
  const requested = useRef<Theme | null>(requestedTheme);

  /** Updates root CSS and the rendered preference label within one synchronous palette commit. */
  const commitPalette = useCallback((next: Theme) => {
    applyThemeImmediately(() => {
      document.documentElement.classList.toggle("dark", next === "dark");
      document.documentElement.style.colorScheme = next;
      setResolvedTheme(next);
    });
  }, []);

  /** Toggles the latest explicit/current palette without changing route or control identity. */
  const toggleTheme = useCallback(() => {
    const current =
      requested.current ?? (document.documentElement.classList.contains("dark") ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    requested.current = next;
    setRequestedTheme(next);
    writeThemePreference(next);
    commitPalette(next);
  }, [commitPalette]);

  /** Applies external preference changes, including consent withdrawal, through the same owner. */
  const onPreference = useEffectEvent((preference: ThemePreference | null) => {
    const next = preference === "light" || preference === "dark" ? preference : null;
    if (next === requested.current) return;
    requested.current = next;
    setRequestedTheme(next);
    commitPalette(next ?? readSystemTheme());
  });
  useEffect(() => subscribeThemePreference((preference) => onPreference(preference)), []);

  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    /** Device changes apply only while no explicit light/dark choice is pinned. */
    const onChange = () => {
      if (requested.current === null) commitPalette(readSystemTheme());
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [commitPalette]);

  const value = useMemo(
    () => ({ requestedTheme, resolvedTheme, toggleTheme }),
    [requestedTheme, resolvedTheme, toggleTheme],
  );
  return <DocsThemeContext value={value}>{children}</DocsThemeContext>;
}
