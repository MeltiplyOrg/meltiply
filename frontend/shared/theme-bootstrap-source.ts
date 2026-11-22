import {
  consentCookieName,
  functionalCookieNames,
  functionalStorageKeys,
  functionalStoragePrefixes,
  productionCookieDomain,
} from "./cookie-consent";
import {
  themeCookieName,
  themePreferenceAttribute,
  themeQueryParam,
  themeStorageKey,
} from "./theme-preference";

export const themeBootstrapMarker = "<!-- meltiply-theme-bootstrap -->";

export interface ThemeBootstrapSettings {
  siteUrls?: readonly string[];
}

export function renderThemeBootstrap(
  runtime: string,
  { siteUrls = [] }: ThemeBootstrapSettings = {},
): string {
  const options = JSON.stringify({
    siteOrigins: siteUrls.map((url) => new URL(url).origin),
    consentCookieName,
    functionalCookieNames,
    functionalStorageKeys,
    functionalStoragePrefixes,
    productionCookieDomain,
    themeCookieName,
    themePreferenceAttribute,
    themeQueryParam,
    themeStorageKey,
  }).replaceAll("<", "\\u003c");
  return `window.__meltiplyThemeBootstrapOptions = ${options};\n${runtime}`;
}
