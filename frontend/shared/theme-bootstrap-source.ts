import {
  themeCookieName,
  themePreferenceAttribute,
  themeQueryParam,
  themeStorageKey,
} from "./theme-preference";

/** Marks the shared before-paint slot in the app's static HTML shell. */
export const themeBootstrapMarker = "<!-- meltiply-theme-bootstrap -->";

export interface ThemeBootstrapSettings {
  /** Root palette convention: the app and docs use the shared `.dark` class. */
  mode: "class" | "data-theme";
  /** Origins whose links receive the theme transfer parameter even without `data-theme-link`. */
  siteUrls?: readonly string[];
}

/**
 * Builds the blocking inline bootstrap embedded by both frontends.
 *
 * The runtime file remains plain JavaScript because it must execute before any
 * module graph loads. `settings` and the shared preference constants are
 * serialized as one literal; `<` is escaped so an origin can never terminate
 * the surrounding script element.
 *
 * @param runtime The checked-in `theme-bootstrap.js` source.
 * @param settings Per-host palette mode and transfer origins.
 * @returns Inline script content ready for `set:html` or an HTML shell marker.
 */
export function renderThemeBootstrap(runtime: string, settings: ThemeBootstrapSettings): string {
  const options = JSON.stringify({
    mode: settings.mode,
    siteUrls: settings.siteUrls ?? [],
    themeCookieName,
    themePreferenceAttribute,
    themeQueryParam,
    themeStorageKey,
  }).replace(/</g, "\\u003c");
  return `window.__meltiplyThemeBootstrapOptions = ${options};\n${runtime}`;
}
