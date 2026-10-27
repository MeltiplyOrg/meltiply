/*
 * Before-paint theme runtime shared by the app and public Astro sites.
 * `theme-bootstrap-source.ts` prepends the shared preference constants and
 * per-host options before embedding this source in a blocking inline script.
 *
 * The runtime is deliberately self-contained: a module import would defer
 * execution until after first paint. Hydrated controllers consume
 * `data-theme-preference` first and only fall back to the stores for embedded
 * surfaces that run without this script; after hydration the stores are
 * re-read for later external changes.
 */
(function (options) {
  var root = document.documentElement;
  var cookieName = options.themeCookieName;
  var queryParam = options.themeQueryParam;
  var preferenceAttribute = options.themePreferenceAttribute;
  var storageKey = options.themeStorageKey;

  /** Limits document intent and store values to the three supported preferences. */
  function isPreference(value) {
    return value === "light" || value === "dark" || value === "system";
  }

  /** Optional stores are readable only after ConsentBootstrap records functional consent. */
  function hasFunctionalConsent() {
    return root.hasAttribute("data-cookie-functional");
  }

  /**
   * Reads the newest persisted cookie value. Each cookie is decoded in
   * isolation so a malformed encoding cannot hide a valid record or prevent the
   * origin-local storage fallback.
   */
  function readCookiePreference() {
    if (!hasFunctionalConsent()) return null;
    var entries;
    try {
      entries = document.cookie.split(";");
    } catch {
      return null;
    }
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index].trim();
      if (entry.indexOf(cookieName + "=") !== 0) continue;
      try {
        var value = decodeURIComponent(entry.slice(cookieName.length + 1));
        if (isPreference(value)) return value;
      } catch {
        // A malformed cookie is skipped so localStorage can still supply a valid choice.
      }
    }
    return null;
  }

  /** Reads this origin's fallback choice; denied storage leaves the OS palette authoritative. */
  function readStoredPreference() {
    if (!hasFunctionalConsent()) return null;
    try {
      var stored = window.localStorage.getItem(storageKey);
      return isPreference(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  /** Resolves the shared cookie before origin-local storage, matching the hydrated reader. */
  function readPersistedPreference() {
    return readCookiePreference() || readStoredPreference();
  }

  /** Writes the validated choice through both optional stores; either denial keeps the page choice. */
  function persistPreference(preference) {
    try {
      window.localStorage.setItem(storageKey, preference);
    } catch {
      // Storage denial still leaves the cookie and the current-page palette usable.
    }
    try {
      var domain =
        location.hostname === "meltiply.com" || location.hostname.endsWith(".meltiply.com")
          ? "; Domain=meltiply.com"
          : "";
      var secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie =
        cookieName +
        "=" +
        preference +
        "; Path=/; Max-Age=31536000; SameSite=Lax" +
        secure +
        domain;
    } catch {
      // Cookie denial still leaves localStorage and the current-page palette usable.
    }
  }

  // A transferred choice is the newest cross-site intent, then the explicit
  // page intent carried through an Astro swap, then the consent-gated stores.
  var params = null;
  var preference = null;
  try {
    params = new URLSearchParams(window.location.search);
    preference = params.get(queryParam);
  } catch {
    // A missing URL parser leaves the page intent and stores authoritative.
  }
  if (!isPreference(preference)) preference = null;
  if (preference === null) {
    var pagePreference = root.getAttribute(preferenceAttribute);
    if (isPreference(pagePreference)) preference = pagePreference;
  }
  if (preference === null) preference = readPersistedPreference();

  if (preference !== null && hasFunctionalConsent()) persistPreference(preference);

  // Strip only the transfer parameter so other query params and the hash survive.
  if (params !== null && params.has(queryParam)) {
    params.delete(queryParam);
    var query = params.toString();
    try {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (query === "" ? "" : "?" + query) + window.location.hash,
      );
    } catch {
      // Environments without history access keep the parameter harmlessly.
    }
  }

  var prefersDark = false;
  try {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    // No media query support means the light default.
  }
  var dark = preference === "dark" || (preference !== "light" && prefersDark);
  if (preference !== null) root.setAttribute(preferenceAttribute, preference);
  else root.removeAttribute(preferenceAttribute);
  root.style.colorScheme = dark ? "dark" : "light";
  if (options.mode === "data-theme") {
    root.dataset.theme = dark ? "dark" : "light";
    root.classList.remove("dark");
  } else {
    root.classList.toggle("dark", dark);
    root.removeAttribute("data-theme");
  }

  // Transfer the current choice across origins. SSR links are navigable well
  // before any hydrated island installs a listener, so this capture-phase
  // handler is registered before first paint and re-reads the live intent on
  // every click rather than capturing the palette resolved at page load.
  var siteOrigins = {};
  for (var siteIndex = 0; siteIndex < options.siteUrls.length; siteIndex += 1) {
    try {
      siteOrigins[new URL(options.siteUrls[siteIndex]).origin] = true;
    } catch {
      // Skip entries that are not absolute URLs.
    }
  }
  var onThemeLinkClick = function (event) {
    var anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor === null) return;
    var url;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!anchor.hasAttribute("data-theme-link") && siteOrigins[url.origin] !== true) {
      return;
    }
    var current = root.getAttribute(preferenceAttribute);
    if (!isPreference(current)) current = readPersistedPreference();
    if (current === null) url.searchParams.delete(queryParam);
    else url.searchParams.set(queryParam, current);
    anchor.href = url.toString();
  };
  // A re-run (e.g. Astro client-side swaps) must not stack listeners:
  // dispatching the reset first lets the outgoing run detach its handler.
  document.dispatchEvent(new Event("meltiply:theme-link-reset"));
  document.addEventListener(
    "meltiply:theme-link-reset",
    function () {
      document.removeEventListener("click", onThemeLinkClick, true);
    },
    { once: true },
  );
  document.addEventListener("click", onThemeLinkClick, true);
})(window.__meltiplyThemeBootstrapOptions);
delete window.__meltiplyThemeBootstrapOptions;
