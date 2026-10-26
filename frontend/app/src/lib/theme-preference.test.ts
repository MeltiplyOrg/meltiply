// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { consentCookieName, writeCookieConsent } from "@meltiply/ui/cookie-consent";
import {
  readInitialThemePreference,
  readThemePreference,
  subscribeThemePreference,
  themeCookieName,
  themePreferenceAttribute,
  themeStorageKey,
  writeThemePreference,
} from "@meltiply/ui/theme-preference";

/** Isolates page-only requests and optional stores so no scenario inherits another visitor's choice. */
function clearPreferences(): void {
  document.documentElement.removeAttribute(themePreferenceAttribute);
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  document.cookie = `${themeCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
}

beforeEach(clearPreferences);
afterEach(clearPreferences);

/** Navigation choices remain usable without storage, reject invalid palettes, and stop reviving withdrawn persisted intent. */
describe("page-only theme intent", () => {
  it("keeps an explicit choice available for navigation without granting consent or persisting it", () => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    writeThemePreference("light");
    expect(readInitialThemePreference()).toBe("light");
    expect(readThemePreference()).toBeNull();
    expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
    expect(
      document.cookie.split(";").some((entry) => entry.trim().startsWith(`${themeCookieName}=`)),
    ).toBe(false);
  });

  it("uses a valid incoming choice before older storage but rejects malformed page intent", () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    writeThemePreference("dark");
    document.documentElement.setAttribute(themePreferenceAttribute, "light");
    expect(readInitialThemePreference()).toBe("light");
    document.documentElement.setAttribute(themePreferenceAttribute, "invalid");
    expect(readInitialThemePreference()).toBe("dark");
  });

  it("falls back to valid origin storage when the encoded cookie is malformed", () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    document.cookie = `${themeCookieName}=%E0%A4%A; Path=/`;
    window.localStorage.setItem(themeStorageKey, "dark");
    expect(readThemePreference()).toBe("dark");
    expect(readInitialThemePreference()).toBe("dark");
  });

  it("keeps current-page intent when stores are cleared but functional consent remains", () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    writeThemePreference("dark");
    document.documentElement.setAttribute(themePreferenceAttribute, "dark");
    const unsubscribe = subscribeThemePreference(() => undefined);
    try {
      document.cookie = `${themeCookieName}=; Path=/; Max-Age=0`;
      window.localStorage.removeItem(themeStorageKey);
      window.dispatchEvent(new Event("focus"));
      expect(readInitialThemePreference()).toBe("dark");
    } finally {
      unsubscribe();
    }
  });

  it("clears persisted page intent when functional consent is withdrawn", () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    writeThemePreference("dark");
    const unsubscribe = subscribeThemePreference(() => undefined);
    try {
      writeCookieConsent({ functional: false, analytics: false, marketing: false });
      expect(readInitialThemePreference()).toBeNull();
      expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
