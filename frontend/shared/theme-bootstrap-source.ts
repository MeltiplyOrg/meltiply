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
  /** Sites whose links receive the theme transfer parameter without `data-theme-link`. */
  siteUrls?: readonly string[];
}

/**
 * Builds the blocking inline script that resolves consent and the palette before first paint.
 * The output is safe to embed inside a `<script>` element.
 */
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
