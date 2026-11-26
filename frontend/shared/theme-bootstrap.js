(function (options) {
  var root = document.documentElement;
  var cookieName = options.themeCookieName;
  var queryParam = options.themeQueryParam;
  var preferenceAttribute = options.themePreferenceAttribute;
  var storageKey = options.themeStorageKey;
  var onProductionDomain =
    location.hostname === options.productionCookieDomain ||
    location.hostname.endsWith("." + options.productionCookieDomain);

  function guarded(access, blocked) {
    try {
      return access();
    } catch {
      // localStorage and document.cookie throw a SecurityError when the browser blocks site data.
      return blocked;
    }
  }

  function writeCookie(name, value, maxAgeSeconds) {
    document.cookie =
      name +
      "=" +
      value +
      "; Path=/; Max-Age=" +
      maxAgeSeconds +
      "; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "") +
      (onProductionDomain ? "; Domain=" + options.productionCookieDomain : "");
  }

  function readCookie(name) {
    var entries = document.cookie.split(";");
    var values = [];
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index].trim();
      if (entry.indexOf(name + "=") === 0) values.push(entry.slice(name.length + 1));
    }
    return values;
  }

  function readConsent() {
    return guarded(function () {
      var raw = readCookie(options.consentCookieName)[0];
      if (raw === undefined) return null;
      var value = JSON.parse(decodeURIComponent(raw));
      return value &&
        value.v === 1 &&
        typeof value.expires === "number" &&
        Number.isFinite(value.expires) &&
        value.expires > Date.now() &&
        typeof value.functional === "boolean"
        ? value
        : null;
    }, null);
  }

  function clearFunctionalStorage() {
    guarded(function () {
      for (var index = localStorage.length - 1; index >= 0; index -= 1) {
        var key = localStorage.key(index);
        var optional =
          key !== null &&
          (options.functionalStorageKeys.indexOf(key) !== -1 ||
            options.functionalStoragePrefixes.some(function (prefix) {
              return key.indexOf(prefix) === 0;
            }));
        if (optional) localStorage.removeItem(key);
      }
    });
    guarded(function () {
      options.functionalCookieNames.forEach(function (name) {
        writeCookie(name, "", 0);
      });
    });
  }

  var consent = readConsent();
  var functional = consent !== null && consent.functional === true;
  root.toggleAttribute("data-cookie-decided", consent !== null);
  root.toggleAttribute("data-cookie-functional", functional);
  if (!functional) clearFunctionalStorage();

  function isPreference(value) {
    return value === "light" || value === "dark" || value === "system";
  }

  function readPersistedPreference() {
    if (!functional) return null;
    var cookies = guarded(function () {
      return readCookie(cookieName);
    }, []);
    for (var index = 0; index < cookies.length; index += 1) {
      var value = guarded(function () {
        return decodeURIComponent(cookies[index]);
      }, null);
      if (isPreference(value)) return value;
    }
    var stored = guarded(function () {
      return localStorage.getItem(storageKey);
    }, null);
    return isPreference(stored) ? stored : null;
  }

  var params = new URLSearchParams(location.search);
  var preference = params.get(queryParam);
  if (!isPreference(preference)) preference = root.getAttribute(preferenceAttribute);
  if (!isPreference(preference)) preference = readPersistedPreference();

  if (preference !== null && functional) {
    guarded(function () {
      localStorage.setItem(storageKey, preference);
    });
    guarded(function () {
      writeCookie(cookieName, preference, 31536000);
    });
  }

  if (params.has(queryParam)) {
    params.delete(queryParam);
    var query = params.toString();
    history.replaceState(
      null,
      "",
      location.pathname + (query === "" ? "" : "?" + query) + location.hash,
    );
  }

  var prefersDark = false;
  try {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    prefersDark = false;
  }
  var dark = preference === "dark" || (preference !== "light" && prefersDark);
  if (preference !== null) root.setAttribute(preferenceAttribute, preference);
  else root.removeAttribute(preferenceAttribute);
  root.style.colorScheme = dark ? "dark" : "light";
  root.classList.toggle("dark", dark);

  // Server-rendered links are clickable before any island hydrates, so the transfer listener is
  // installed here and reads the live choice on each click.
  var onThemeLinkClick = function (event) {
    var anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor === null) return;
    if (anchor.protocol !== "http:" && anchor.protocol !== "https:") return;
    if (
      !anchor.hasAttribute("data-theme-link") &&
      options.siteOrigins.indexOf(anchor.origin) === -1
    )
      return;
    var current = root.getAttribute(preferenceAttribute);
    if (!isPreference(current)) current = readPersistedPreference();
    var parameters = new URLSearchParams(anchor.search);
    if (current === null) parameters.delete(queryParam);
    else parameters.set(queryParam, current);
    anchor.search = parameters.toString();
  };
  // Astro client-side swaps re-run this script; the reset lets the previous run detach first.
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
