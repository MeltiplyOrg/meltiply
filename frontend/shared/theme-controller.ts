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

export interface ThemeControllerState {
  requestedTheme: ThemePreference;
  theme: Theme;
}

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

function getServerSnapshot(): ThemeControllerState {
  return serverSnapshot;
}

function noop(): void {}

export function resolveTheme(preference: ThemePreference | null, prefersDark: boolean): Theme {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}

function darkSchemeQuery(): MediaQueryList | null {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return null;
  }
}

function prefersDarkScheme(): boolean {
  return darkSchemeQuery()?.matches === true;
}

function commitTheme(theme: Theme): void {
  applyThemeImmediately(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  });
}

function committedTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

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

  function publish(next: ThemeControllerState): void {
    if (next.requestedTheme === snapshot.requestedTheme && next.theme === snapshot.theme) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function applyPreference(preference: ThemePreference): void {
    const next = resolveTheme(preference, prefersDarkScheme());
    const paletteChanged = next !== snapshot.theme;
    publish({ requestedTheme: preference, theme: next });
    if (paletteChanged) commitTheme(next);
  }

  function setTheme(preference: ThemePreference): void {
    applyPreference(preference);
    writeThemePreference(preference);
  }

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

  function toggleTheme(): void {
    setTheme(snapshot.theme === "dark" ? "light" : "dark");
  }

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

    const media = darkSchemeQuery();
    media?.addEventListener("change", onSystemChange);

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
