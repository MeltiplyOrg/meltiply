import {
  createContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
import {
  applyThemeImmediately,
  startThemeReveal,
  themeOriginFromEvent,
  type Theme,
  type ThemeRevealHandle,
} from "@meltiply/ui/theme-transition";
import {
  readInitialThemePreference,
  subscribeThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "@meltiply/ui/theme-preference";

/**
 * Resolves the live OS palette for an unpinned preference. This keeps docs
 * theme controls useful without optional browser storage or next-themes.
 */
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
  toggleTheme: (event: MouseEvent<HTMLButtonElement>) => void;
} | null>(null);

/**
 * Owns the live palette and reversible landing-style reveal across desktop/
 * drawer controls and persisted guide navigation. Validated navigation intent
 * survives hydration even without consent. Explicit intent is persisted only
 * with functional consent; an unpinned choice follows the OS. Lazy state adopts
 * the head bootstrap without an effect-driven extra render; preference controls
 * keep server-neutral labels until mounted, preserving hydration parity.
 */
export function DocsThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );
  const { lowMotion } = useMotionPreference();
  const [requestedTheme, setRequestedTheme] = useState<Theme | null>(() => {
    const preference = readInitialThemePreference();
    return preference === "light" || preference === "dark" ? preference : null;
  });
  const requested = useRef<Theme | null>(requestedTheme);
  const reveal = useRef<ThemeRevealHandle | null>(null);
  const inkTarget = useRef<Theme | null>(null);

  /** Commits the wave endpoint to the live root without relying on a theme provider. */
  const commitPalette = useCallback(
    (next: Theme) => {
      const root = document.documentElement;
      root.classList.toggle("dark", next === "dark");
      root.style.colorScheme = next;
      setResolvedTheme(next);
    },
    [setResolvedTheme],
  );

  /** Settles the current wave toward the latest request and releases its inert copy. */
  const settleReveal = useCallback(() => {
    if (inkTarget.current !== null)
      reveal.current?.setDirection(requested.current === inkTarget.current);
    reveal.current?.skip();
    reveal.current = null;
    inkTarget.current = null;
  }, []);

  /**
   * Toggles against the latest request, not the still-visible source palette.
   * Rapid activations reverse the existing mask; new waves start at the clicked
   * control's viewport center. The shared write is optional; the root is always
   * updated in memory when animation commits.
   */
  const toggleTheme = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const current =
        requested.current ??
        (document.documentElement.classList.contains("dark") ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      requested.current = next;
      setRequestedTheme(next);
      writeThemePreference(next);
      if (reveal.current?.kind === "ink" && reveal.current.setDirection(next === inkTarget.current))
        return;
      settleReveal();
      const fromTheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      if (next === fromTheme) {
        applyThemeImmediately(() => commitPalette(next));
        return;
      }
      const handle = startThemeReveal({
        fromTheme,
        toTheme: next,
        applyTheme: () => commitPalette(next),
        restoreTheme: () => commitPalette(fromTheme),
        origin: themeOriginFromEvent(event),
        lowMotion,
      });
      reveal.current = handle;
      inkTarget.current = handle.kind === "ink" ? next : null;
    },
    [commitPalette, lowMotion, settleReveal],
  );

  /** Adopts external intent without an origin; equal pinned choices leave the wave running. */
  const onPreference = useEffectEvent((preference: ThemePreference | null) => {
    const next: Theme | null = preference === "light" || preference === "dark" ? preference : null;
    if (next === requested.current) return;
    settleReveal();
    const palette = next ?? readSystemTheme();
    requested.current = next;
    setRequestedTheme(next);
    applyThemeImmediately(() => commitPalette(palette));
  });

  useEffect(() => subscribeThemePreference((preference) => onPreference(preference)), []);

  useEffect(() => {
    let colorScheme: MediaQueryList;
    try {
      colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }

    /**
     * Follows OS changes only while no explicit palette is pinned; settle a
     * pending reveal before applying an origin-less system update.
     */
    const onSystemColorChange = () => {
      if (requested.current !== null) return;
      const next = readSystemTheme();
      const current = document.documentElement.classList.contains("dark") ? "dark" : "light";
      if (next === current) return;
      settleReveal();
      applyThemeImmediately(() => commitPalette(next));
    };

    colorScheme.addEventListener("change", onSystemColorChange);
    return () => colorScheme.removeEventListener("change", onSystemColorChange);
  }, [commitPalette, settleReveal]);

  useEffect(() => {
    if (lowMotion && reveal.current?.kind === "ink") settleReveal();
  }, [lowMotion, settleReveal]);

  useEffect(() => () => settleReveal(), [settleReveal]);

  const value = useMemo(
    () => ({ requestedTheme, resolvedTheme, toggleTheme }),
    [requestedTheme, resolvedTheme, toggleTheme],
  );
  return <DocsThemeContext value={value}>{children}</DocsThemeContext>;
}
