import { hasCookieConsent, subscribeCookieConsent } from "./cookie-consent";
import {
  readInitialThemePreference,
  readThemePreference,
  readThemePreferenceFromDocument,
  subscribeThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "./theme-preference";
import { applyThemeImmediately, type Theme } from "./theme-transition";

/** State shared by every hydrated theme adapter. */
export interface ThemeControllerState {
  /** Explicit system/light/dark intent; missing stored intent resolves to System. */
  requestedTheme: ThemePreference;
  /** Palette currently committed to the document root. */
  theme: Theme;
}

/** Framework-agnostic owner for first-paint intent, OS changes, and consent-gated stores. */
export interface ThemeController {
  getSnapshot(): ThemeControllerState;
  getServerSnapshot(): ThemeControllerState;
  subscribe(listener: () => void): () => void;
  start(): () => void;
  setTheme(preference: ThemePreference): void;
  toggleTheme(): void;
}

const serverSnapshot: ThemeControllerState = {
  requestedTheme: "system",
  theme: "light",
};

/** Shared identity so React's server snapshot stays referentially stable. */
function getServerSnapshot(): ThemeControllerState {
  return serverSnapshot;
}

/** Subscribes no-op adapters created without a browser document. */
function noop(): void {
  // Nothing to release outside a browser.
}

/** Resolves a preference against the device palette; unknown values follow the OS. */
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

/** Commits one palette without per-component color fades; unchanged values stay untouched. */
function commitTheme(theme: Theme): void {
  applyThemeImmediately(() => {
    const root = document.documentElement;
    // Shared tokens accept both host conventions, so a data-theme surface
    // stays correct after hydration even though the app uses the class.
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  });
}

/** Reads the palette both host conventions may have committed. */
function committedTheme(): Theme {
  const root = document.documentElement;
  return root.classList.contains("dark") || root.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Creates one theme owner for a hydrated surface.
 *
 * The initial state comes from the intent the before-paint runtime carried in
 * `data-theme-preference`, falling back to the consent-gated stores for
 * embedded/test surfaces that run without the runtime. That intent resolves
 * against the live device palette so it matches the committed first paint.
 * User choices commit immediately and persist only with functional consent.
 * External store changes, consent acceptance/withdrawal, and live OS changes
 * flow through the same state owner; current-page intent survives a cleared
 * store while functional consent remains.
 *
 * @returns Controller with an externally-subscribable snapshot and start/stop
 *   lifecycle. `start` is idempotent and safe in effect cleanup.
 */
export function createThemeController(): ThemeController {
  if (typeof document === "undefined") {
    return {
      getSnapshot: getServerSnapshot,
      getServerSnapshot,
      subscribe: () => noop,
      start: () => noop,
      setTheme: noop,
      toggleTheme: noop,
    };
  }

  const initialPreference = readInitialThemePreference();
  let snapshot: ThemeControllerState = {
    requestedTheme: initialPreference ?? "system",
    theme: resolveTheme(initialPreference, prefersDarkScheme()),
  };
  const listeners = new Set<() => void>();
  let running = false;
  let stopRunning = noop;

  /** Notifies React and other subscribers only after a committed state change. */
  function publish(next: ThemeControllerState): void {
    if (next.requestedTheme === snapshot.requestedTheme && next.theme === snapshot.theme) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /** Resolves, commits, and publishes one requested preference. */
  function applyPreference(preference: ThemePreference): void {
    const next = resolveTheme(preference, prefersDarkScheme());
    const paletteChanged = next !== snapshot.theme;
    publish({ requestedTheme: preference, theme: next });
    if (paletteChanged) commitTheme(next);
  }

  /** Applies an explicit choice and records it for this document and navigation. */
  function setTheme(preference: ThemePreference): void {
    applyPreference(preference);
    writeThemePreference(preference);
  }

  /** Applies an external store revision without reviving a deliberately cleared page choice. */
  function applyExternalPreference(preference: ThemePreference | null): void {
    if (preference !== null && preference === snapshot.requestedTheme) return;
    if (
      preference === null &&
      hasCookieConsent("functional") &&
      readThemePreferenceFromDocument() !== null
    )
      return;
    applyPreference(preference ?? "system");
  }

  /** Commits a toggle against the palette the user currently sees. */
  function toggleTheme(): void {
    setTheme(snapshot.theme === "dark" ? "light" : "dark");
  }

  /** Starts browser subscriptions once and returns an idempotent disposer. */
  function start(): () => void {
    if (running) return stopRunning;
    running = true;
    let functionalConsent = hasCookieConsent("functional");
    const unsubscribeTheme = subscribeThemePreference(applyExternalPreference);
    const unsubscribeConsent = subscribeCookieConsent(() => {
      const nextFunctionalConsent = hasCookieConsent("functional");
      if (nextFunctionalConsent === functionalConsent) return;
      functionalConsent = nextFunctionalConsent;
      if (!nextFunctionalConsent) {
        applyExternalPreference(null);
        return;
      }
      const preference = readThemePreference();
      if (preference !== null) applyExternalPreference(preference);
      else if (readThemePreferenceFromDocument() !== null)
        writeThemePreference(snapshot.requestedTheme);
    });

    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", onSystemChange);
    } catch {
      media = null;
    }

    // Embedded tests can mount without the inline runtime; align the root once.
    if (committedTheme() !== snapshot.theme) commitTheme(snapshot.theme);
    else if (document.documentElement.style.colorScheme === "")
      document.documentElement.style.colorScheme = snapshot.theme;

    stopRunning = () => {
      running = false;
      unsubscribeTheme();
      unsubscribeConsent();
      media?.removeEventListener("change", onSystemChange);
      stopRunning = noop;
    };
    return stopRunning;
  }

  /** Keeps System intent live without overwriting explicit light/dark choices. */
  function onSystemChange(): void {
    if (snapshot.requestedTheme !== "system") return;
    applyPreference("system");
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    setTheme,
    toggleTheme,
  };
}
