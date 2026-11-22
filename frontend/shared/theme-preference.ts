import {
  hasCookieConsent,
  readFunctionalStorage,
  subscribeCookieConsent,
  writeFunctionalStorage,
  writeSiteCookie,
} from "./cookie-consent";

export type ThemePreference = "light" | "dark" | "system";

export const themeStorageKey = "meltiply.theme";
export const themeCookieName = "meltiply-theme";
/** Carries the preference to origins that cannot share the cookie; the bootstrap strips it before paint. */
export const themeQueryParam = "meltiply-theme";
/** Root attribute holding the explicit choice for the current document, independent of consent. */
export const themePreferenceAttribute = "data-theme-preference";

const preferenceChangeEvent = "meltiply:theme-preference";
const themeCookieLifetimeSeconds = 365 * 24 * 60 * 60;

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function decodeCookieValue(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function readCookiePreference(): ThemePreference | null {
  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1 || entry.slice(0, separator).trim() !== themeCookieName) continue;
    const value = decodeCookieValue(entry.slice(separator + 1).trim());
    if (isThemePreference(value)) return value;
  }
  return null;
}

/** Reads the persisted choice (shared cookie first, then origin storage); `null` without functional consent. */
export function readThemePreference(): ThemePreference | null {
  if (!hasCookieConsent("functional")) return null;
  const cookie = readCookiePreference();
  if (cookie !== null) return cookie;
  const stored = readFunctionalStorage(themeStorageKey);
  return isThemePreference(stored) ? stored : null;
}

export function readThemePreferenceFromDocument(): ThemePreference | null {
  const page = document.documentElement.getAttribute(themePreferenceAttribute);
  return isThemePreference(page) ? page : null;
}

export function readInitialThemePreference(): ThemePreference | null {
  return readThemePreferenceFromDocument() ?? readThemePreference();
}

/** Records the choice on the document; persists and broadcasts it only with functional consent. */
export function writeThemePreference(preference: ThemePreference): void {
  document.documentElement.setAttribute(themePreferenceAttribute, preference);
  if (!hasCookieConsent("functional")) return;
  writeFunctionalStorage(themeStorageKey, preference);
  writeSiteCookie(themeCookieName, preference, themeCookieLifetimeSeconds);
  window.dispatchEvent(new Event(preferenceChangeEvent));
}

/**
 * Reports changes to the persisted preference from local writes, other tabs, and sibling sites
 * (re-read on focus/visibility). Fires only when the resolved value changes. Withdrawing
 * functional consent also drops the document's explicit choice.
 */
export function subscribeThemePreference(
  listener: (preference: ThemePreference | null) => void,
): () => void {
  let last = readThemePreference();
  let functionalConsent = hasCookieConsent("functional");
  const check = () => {
    const nextFunctionalConsent = hasCookieConsent("functional");
    const root = document.documentElement;
    if (functionalConsent && !nextFunctionalConsent) root.removeAttribute(themePreferenceAttribute);
    functionalConsent = nextFunctionalConsent;
    const next = readThemePreference();
    if (next === last) return;
    last = next;
    if (next !== null) root.setAttribute(themePreferenceAttribute, next);
    listener(next);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === themeStorageKey) check();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") check();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", check);
  window.addEventListener(preferenceChangeEvent, check);
  document.addEventListener("visibilitychange", onVisibility);
  const unsubscribeConsent = subscribeCookieConsent(check);
  return () => {
    unsubscribeConsent();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", check);
    window.removeEventListener(preferenceChangeEvent, check);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
