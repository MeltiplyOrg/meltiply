import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import {
  applyThemeImmediately,
  startThemeReveal,
  type ThemeRevealHandle,
  type ThemeTransitionOrigin,
} from "@meltiply/ui/theme-transition";

import { useMotionPreference } from "@meltiply/ui/motion-preference";

export type Theme = "light" | "dark";

/**
 * Resolves an explicit shared preference, including `"system"`, or follows the
 * operating-system palette when no preference is available.
 *
 * @param stored Shared preference value or null when none is available.
 * @param prefersDark Whether the operating system requests a dark palette.
 * @returns Resolved app theme: `"light"` or `"dark"`.
 */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/**
 * Checks whether the browser environment matches the `(prefers-color-scheme: dark)` media query.
 * Safely catches exceptions when `window.matchMedia` is unsupported in test or headless environments.
 *
 * @returns `true` if OS prefers dark mode, `false` otherwise.
 */
function prefersDarkScheme(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    // Media queries are unavailable in some embedded and test environments.
    return false;
  }
}

interface ThemeContextValue {
  /** Palette the user most recently selected; drives control selection state while a reveal is in flight. */
  requestedTheme: Theme;
  setTheme: (theme: Theme, origin?: ThemeTransitionOrigin) => void;
  /** Palette actually committed to `document.documentElement`; content-facing. */
  theme: Theme;
  toggleTheme: (origin?: ThemeTransitionOrigin) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  requestedTheme: "dark",
  setTheme: () => undefined,
  theme: "dark",
  toggleTheme: () => undefined,
});

/**
 * React context provider that adapts the shared `@meltiply/ui` live-wave theme
 * runtime to React. It exposes two distinct palettes:
 *
 * - `theme` — the committed palette. It is the only value mirrored onto
 *   `document.documentElement`'s `dark` class, and it changes exclusively at a
 *   reveal's endpoints (or instantly for origin-less changes), so content and
 *   the root never disagree mid-wave.
 * - `requestedTheme` — the newest user selection. Theme controls bind their
 *   pressed/selected state to it so repeated activations during a reveal read
 *   correctly, and `toggleTheme` derives the next target from it (via a ref)
 *   rather than from committed state, which keeps same-task spam toggles
 *   alternating instead of collapsing into repeated no-ops.
 * Initialization preserves the validated before-paint navigation choice even
 * without functional consent, so hydration cannot repaint it as the OS theme.
 *
 * `setTheme` updates the in-memory request and asks the shared preference
 * helper to persist only when functional consent allows it. While an ink reveal
 * is in flight a selection retargets that same wave via
 * `setDirection(next === inkTarget)`: selecting the wave's target continues it
 * forward, selecting the committed palette reverses it continuously, and a
 * completed wave is detected through `setDirection`'s `false` return so the
 * next selection starts fresh. Non-ink (blink) reveals carry no direction, so
 * a new selection settles them and falls through to the normal path.
 *
 * Origin-less calls settle the running wave toward the request and then apply
 * the palette instantly through `applyThemeImmediately`, leaving no wave
 * styles behind. When effective low motion turns on mid-reveal, a running ink
 * wave is settled toward the latest request while a running blink — which has
 * no spatial motion — is left to finish on its own. Unmount settles the wave
 * toward the latest request without touching React state, preserving the
 * requested root palette.
 *
 * @param props Component props containing child elements.
 * @returns Context provider element.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [theme, setThemeState] = useState(() =>
    resolveTheme(readInitialThemePreference(), prefersDarkScheme()),
  );
  const [requestedTheme, setRequestedThemeState] = useState<Theme>(theme);
  const { lowMotion } = useMotionPreference();

  const revealRef = useRef<ThemeRevealHandle | null>(null);
  /** Target theme of the active ink wave; `null` for blink or no wave. */
  const inkTargetRef = useRef<Theme | null>(null);
  /** Last palette written to the root class; mirrored from `theme` via the layout effect. */
  const committedRef = useRef(theme);
  /** Latest request, readable inside stable callbacks and reveal endpoints. */
  const requestedRef = useRef(theme);
  const lowMotionRef = useRef(lowMotion);
  const mountedRef = useRef(false);
  // A transferred explicit palette is also a selection: accepting functional
  // storage later should remember it just like a choice made in the app.
  const hasSelectedThemeRef = useRef(
    typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme-preference") === theme,
  );

  /**
   * Commits the CSS palette and native control color scheme, then React state.
   * The root write is synchronous because the shared runtime invokes endpoint
   * callbacks inside its paint sequence — the committed palette must be on the
   * DOM before the callback returns. `mountedRef` keeps deferred endpoint
   * callbacks (and unmount-time settles) from setting state on an unmounted
   * provider; ref and root updates still run so the visible palette never
   * lags the request.
   *
   * @param next Palette to commit.
   */
  const commitPalette = useCallback((next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.style.colorScheme = next;
    committedRef.current = next;
    if (mountedRef.current) {
      setThemeState(next);
    }
  }, []);

  /**
   * Applies a new palette selection in memory, persisting its preference only
   * when functional consent allows it. Origin-aware calls drive the shared
   * reveal; calls without an origin finish the newest request instantly.
   *
   * @param nextTheme Palette the user selected.
   * @param origin Viewport point the reveal expands from, when the selection
   *   came from a pointer/keyboard activation.
   */
  const setTheme = useCallback(
    (nextTheme: Theme, origin?: ThemeTransitionOrigin) => {
      requestedRef.current = nextTheme;
      if (mountedRef.current) {
        setRequestedThemeState(nextTheme);
      }
      hasSelectedThemeRef.current = true;
      writeThemePreference(nextTheme);

      const reveal = revealRef.current;
      if (reveal !== null) {
        const inkTarget = inkTargetRef.current;
        if (
          origin !== undefined &&
          inkTarget !== null &&
          reveal.setDirection(nextTheme === inkTarget)
        ) {
          // The same wave retargets continuously: `true` keeps rolling toward
          // the ink target, `false` rolls back toward the palette it started
          // from. Both keep the request as the newest selection. Origin-less
          // calls never land here — they must finish instantly, not animate.
          return;
        }
        // Finished/undirected reveals and origin-less requests settle the wave
        // toward the latest request so the commit lands immediately and no
        // superseded wave can repaint a stale palette afterwards.
        if (inkTarget !== null) reveal.setDirection(nextTheme === inkTarget);
        reveal.skip();
        revealRef.current = null;
        inkTargetRef.current = null;
      }
      if (committedRef.current === nextTheme) {
        return;
      }

      if (origin === undefined) {
        applyThemeImmediately(() => commitPalette(nextTheme));
        return;
      }

      const fromTheme = committedRef.current;
      const handle = startThemeReveal({
        fromTheme,
        toTheme: nextTheme,
        applyTheme: () => commitPalette(nextTheme),
        restoreTheme: () => commitPalette(fromTheme),
        origin,
        lowMotion: lowMotionRef.current,
      });
      revealRef.current = handle;
      inkTargetRef.current = handle.kind === "ink" ? nextTheme : null;
    },
    [commitPalette],
  );

  /**
   * Requests the palette opposite the latest request. Deriving the target from
   * `requestedRef` (not committed `theme`) makes consecutive activations
   * alternate even while a reveal is still animating toward the first choice.
   *
   * @param origin Activation point for the reveal, when called from an event.
   */
  const toggleTheme = useCallback(
    (origin?: ThemeTransitionOrigin) => {
      setTheme(requestedRef.current === "dark" ? "light" : "dark", origin);
    },
    [setTheme],
  );
  /**
   * Applies a shared preference update without writing it back. Cross-site
   * changes and consent withdrawal update this page's in-memory palette without
   * recreating the preference that was just cleared.
   *
   * @param preference New shared preference, or null to follow the OS palette.
   */
  const applyExternalPreference = useCallback(
    (preference: ThemePreference | null) => {
      // Local persistence publishes synchronously before a reveal exists;
      // its own pending choice must not turn the animation into an instant commit.
      if (preference === requestedRef.current) return;
      if (preference === null && hasSelectedThemeRef.current && hasCookieConsent("functional")) {
        return;
      }
      const nextTheme = resolveTheme(preference, prefersDarkScheme());
      requestedRef.current = nextTheme;
      if (mountedRef.current) setRequestedThemeState(nextTheme);
      const reveal = revealRef.current;
      if (reveal !== null) {
        if (inkTargetRef.current !== null) {
          reveal.setDirection(nextTheme === inkTargetRef.current);
        }
        reveal.skip();
        revealRef.current = null;
        inkTargetRef.current = null;
      }
      if (committedRef.current !== nextTheme) {
        applyThemeImmediately(() => commitPalette(nextTheme));
      }
    },
    [commitPalette],
  );

  /**
   * Synchronizes accepted preferences and resets to the OS only on an actual
   * withdrawal, not a first rejection of optional storage. An explicit page
   * choice remains live without consent and is persisted after acceptance.
   */
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
    lowMotionRef.current = lowMotion;
  }, [lowMotion]);

  useEffect(() => {
    if (lowMotion && revealRef.current?.kind === "ink") {
      // Low motion forbids spatial animation, so the running wave is settled
      // toward the newest request instead of left animating under an
      // accessibility preference. Blinks are allowed to finish naturally.
      revealRef.current.setDirection(requestedRef.current === inkTargetRef.current);
      revealRef.current.skip();
      revealRef.current = null;
      inkTargetRef.current = null;
    }
  }, [lowMotion]);

  /**
   * Mount bookkeeping plus unmount settle: a wave abandoned mid-flight commits
   * whichever palette the request pointed at last, directly on the root. This
   * both releases the runtime's paint suppression and leaves the document in
   * the palette the user asked for, without a React state write. A layout
   * effect keeps DOM writes out of the passive-effects phase.
   */
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const reveal = revealRef.current;
      if (reveal === null) return;
      const requested = requestedRef.current;
      if (inkTargetRef.current !== null) {
        reveal.setDirection(requested === inkTargetRef.current);
      }
      reveal.skip();
      revealRef.current = null;
      inkTargetRef.current = null;
      if (committedRef.current !== requested) {
        document.documentElement.classList.toggle("dark", requested === "dark");
        document.documentElement.style.colorScheme = requested;
        committedRef.current = requested;
      }
    };
  }, []);

  // Mirror the committed palette onto the root class. `commitPalette` already
  // writes it synchronously at reveal endpoints and instant swaps; this effect
  // additionally covers the initial mount and keeps state and DOM in lockstep.
  // `applyThemeImmediately` suppression prevents component colour transitions
  // from interpolating during the swap (counted suppression tolerates nesting
  // inside a running reveal).
  useLayoutEffect(() => {
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

/**
 * Accesses the committed palette, latest requested palette, and setters from
 * `ThemeContext`. Controls should render `requestedTheme` and call
 * `toggleTheme`/`setTheme` with a `ThemeTransitionOrigin` for animated
 * reveals; content that must match the painted page reads `theme`.
 *
 * @returns Object with `theme`, `requestedTheme`, `setTheme`, and `toggleTheme`.
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
