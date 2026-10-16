import {
  hasCookieConsent,
  readFunctionalStorage,
  writeFunctionalStorage,
  subscribeCookieConsent,
} from "./cookie-consent";

/**
 * Shared color-scheme preference for all Meltiply sites. Explicit choices
 * remain available in the current document and through marked navigation
 * links, including preview origins. Functional consent permits persistence to
 * `meltiply.theme` and the domain-scoped cookie; navigation never grants consent.
 */

/** Explicit palette choice; `"system"` records a deliberate OS-following choice. */
export type ThemePreference = "light" | "dark" | "system";

/** Consent-gated localStorage key shared by every Meltiply theme controller. */
export const themeStorageKey = "meltiply.theme";

/**
 * Cookie holding the newest explicit choice. Written with `Domain=meltiply.com`
 * only on `meltiply.com` hosts so preview origins stay host-scoped instead of
 * targeting arbitrary registrable domains.
 */
export const themeCookieName = "meltiply-theme";

/**
 * Query parameter carrying the preference across origins that cannot share
 * cookies (e.g. trycloudflare previews). Only links marked `data-theme-link`
 * receive it, and the bootstrap removes it before paint.
 */
export const themeQueryParam = "meltiply-theme";

/** Carries explicit page intent through bootstrap and controller hydration without optional storage. */
export const themePreferenceAttribute = "data-theme-preference";

const preferenceChangeEvent = "meltiply:theme-preference";

/** Limits the effective preference to the three persisted vocabulary values. */
function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Reads the shared preference cookie. Tolerates `document.cookie` being
 * unavailable and ignores malformed encodings instead of treating them as a
 * stored choice.
 */
function readCookiePreference(): ThemePreference | null {
  try {
    for (const entry of document.cookie.split(";")) {
      const separator = entry.indexOf("=");
      if (separator === -1) continue;
      if (entry.slice(0, separator).trim() !== themeCookieName) continue;
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      return isThemePreference(value) ? value : null;
    }
  } catch {
    // Reading cookies can throw in sandboxed contexts.
  }
  return null;
}

/**
 * Reads the origin-local stored choice. `null` also covers a cleared or
 * corrupted key so callers fall back to the OS palette.
 */
function readStoredPreference(): ThemePreference | null {
  const stored = readFunctionalStorage(themeStorageKey);
  return isThemePreference(stored) ? stored : null;
}

/**
 * Resolves the shared cookie before origin-local storage only with functional
 * consent. Missing or withdrawn consent returns null, leaving the OS default
 * authoritative instead of reviving an old optional preference.
 */
export function readThemePreference(): ThemePreference | null {
  if (!hasCookieConsent("functional")) return null;
  return readCookiePreference() ?? readStoredPreference();
}

/**
 * Initializes a controller from a validated before-paint navigation choice,
 * then consent-gated stores. The page-only choice survives hydration even when
 * optional storage is forbidden or denied; it never grants cookie consent.
 */
export function readInitialThemePreference(): ThemePreference | null {
  const page =
    typeof document === "undefined"
      ? null
      : document.documentElement.getAttribute(themePreferenceAttribute);
  return isThemePreference(page) ? page : readThemePreference();
}

/**
 * Records explicit intent for this document and its navigation links.
 * Only functional consent permits cookie/localStorage writes and notification
 * of persisted preference changes; callers keep their own live palette state.
 */
export function writeThemePreference(preference: ThemePreference): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute(themePreferenceAttribute, preference);
  }
  if (!hasCookieConsent("functional")) return;
  writeFunctionalStorage(themeStorageKey, preference);
  try {
    const host = window.location.hostname;
    const domain =
      host === "meltiply.com" || host.endsWith(".meltiply.com") ? "; Domain=meltiply.com" : "";
    document.cookie = `${themeCookieName}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax; Secure${domain}`;
  } catch {
    // Cookie writes can be denied; localStorage above still carries the choice.
  }
  window.dispatchEvent(new Event(preferenceChangeEvent));
}

/**
 * Subscribes to explicit local writes and changes made elsewhere: another tab
 * writing the storage key, a full storage clear, or regaining focus/visibility
 * after a sibling origin updates the cookie. Fires only when the resolved
 * preference changes, so no-op writes never loop; local writes keep the
 * comparison baseline current for subsequent external changes.
 *
 * @param listener Receives the new effective preference, or `null` when every
 *   store was cleared (the OS palette becomes authoritative again).
 * @returns Unsubscribe function removing all listeners.
 */
export function subscribeThemePreference(
  listener: (preference: ThemePreference | null) => void,
): () => void {
  let last = readThemePreference();
  const check = () => {
    const next = readThemePreference();
    if (next === last) return;
    last = next;
    if (next === null) document.documentElement.removeAttribute(themePreferenceAttribute);
    else document.documentElement.setAttribute(themePreferenceAttribute, next);
    listener(next);
  };
  const onStorage = (event: StorageEvent) => {
    // A `null` key means a bulk clear, which can erase our key too.
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
