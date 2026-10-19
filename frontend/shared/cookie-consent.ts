export type ConsentCategory = "functional" | "analytics" | "marketing";

/** Optional purposes are independent; essential authentication and consent storage are not toggles. */
export interface CookieConsent {
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

export const consentCookieName = "meltiply-consent";
export const consentLifetimeSeconds = 180 * 24 * 60 * 60;
export const functionalStorageKeys = [
  "meltiply.theme",
  "meltiply.language",
  "meltiply.recent-navigation",
  "meltiply.devbox",
] as const;
export const functionalStoragePrefixes = [
  "meltiply.composer.",
  "meltiply.upload.v1.",
  "meltiply.upload.create.v1.",
] as const;
const consentChangeEvent = "meltiply:cookie-consent";
let volatileConsent: CookieConsent | null = null;

/** Reads only the essential consent cookie; malformed, expired, or obsolete records grant no optional purposes. */
export function readCookieConsent(): CookieConsent | null {
  if (typeof document === "undefined") return null;
  if (volatileConsent !== null) return volatileConsent;
  try {
    const entry = document.cookie
      .split(";")
      .find((item) => item.trim().startsWith(`${consentCookieName}=`));
    if (!entry) return null;
    const value: unknown = JSON.parse(
      decodeURIComponent(entry.trim().slice(consentCookieName.length + 1)),
    );
    if (typeof value !== "object" || value === null) return null;
    if (
      !("v" in value) ||
      value.v !== 1 ||
      !("expires" in value) ||
      typeof value.expires !== "number" ||
      !Number.isFinite(value.expires) ||
      value.expires <= Date.now()
    )
      return null;
    if (
      !("functional" in value) ||
      typeof value.functional !== "boolean" ||
      !("analytics" in value) ||
      typeof value.analytics !== "boolean" ||
      !("marketing" in value) ||
      typeof value.marketing !== "boolean"
    )
      return null;
    return {
      functional: value.functional,
      analytics: value.analytics,
      marketing: value.marketing,
    };
  } catch {
    return null;
  }
}

/** Denies optional storage/tracking until a valid, explicit choice permits that purpose. */
export function hasCookieConsent(category: ConsentCategory): boolean {
  return readCookieConsent()?.[category] === true;
}

/** Removes only inventoried optional data on this origin and both scopes of the public theme cookie; auth is untouched. */
export function clearFunctionalStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (
        key !== null &&
        (functionalStorageKeys.some((item) => item === key) ||
          functionalStoragePrefixes.some((prefix) => key.startsWith(prefix)))
      )
        window.localStorage.removeItem(key);
    }
  } catch {
    // A restricted store cannot be cleaned, but gated readers never use it.
  }
  try {
    document.cookie = "meltiply-theme=; Path=/; Max-Age=0; SameSite=Lax";
    if (
      window.location.hostname === "meltiply.com" ||
      window.location.hostname.endsWith(".meltiply.com")
    )
      document.cookie =
        "meltiply-theme=; Domain=meltiply.com; Path=/; Max-Age=0; SameSite=Lax; Secure";
  } catch {
    // Blocked cookies cannot be removed; consent-gated readers ignore them.
  }
}

/** Saves an explicit choice for 180 days across production subdomains; denied cookie writes retain it only on this page. */
export function writeCookieConsent(consent: CookieConsent): void {
  const encoded = encodeURIComponent(
    JSON.stringify({
      v: 1,
      ...consent,
      expires: Date.now() + consentLifetimeSeconds * 1000,
    }),
  );
  volatileConsent = consent;
  try {
    const host = window.location.hostname;
    const domain =
      host === "meltiply.com" || host.endsWith(".meltiply.com") ? "; Domain=meltiply.com" : "";
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${consentCookieName}=${encoded}; Path=/; Max-Age=${consentLifetimeSeconds}; SameSite=Lax${secure}${domain}`;
    if (
      document.cookie.split(";").some((entry) => entry.trim() === `${consentCookieName}=${encoded}`)
    )
      volatileConsent = null;
  } catch {
    // Keep this page's decision when browser policy refuses persistence.
  }
  document.documentElement.toggleAttribute("data-cookie-functional", consent.functional);
  document.documentElement.setAttribute("data-cookie-decided", "");
  if (!consent.functional) clearFunctionalStorage();
  window.dispatchEvent(new Event(consentChangeEvent));
}

/** Reads a functional preference only after consent; blocked/absent storage returns null without changing current-page state. */
export function readFunctionalStorage(key: string): string | null {
  if (!hasCookieConsent("functional")) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persists optional convenience data only with consent; deleting an old record is always permitted. */
export function writeFunctionalStorage(key: string, value: string | null): void {
  if (value !== null && !hasCookieConsent("functional")) return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // In-memory controls and server-backed work remain usable without storage.
  }
}

/** Observes choices on this page and sibling-site changes on focus/visibility; withdrawal removes this origin's old optional records. */
export function subscribeCookieConsent(listener: () => void): () => void {
  let previous = JSON.stringify(readCookieConsent());
  const check = () => {
    const current = readCookieConsent();
    document.documentElement.toggleAttribute(
      "data-cookie-functional",
      current?.functional === true,
    );
    document.documentElement.toggleAttribute("data-cookie-decided", current !== null);
    if (current?.functional !== true) clearFunctionalStorage();
    const serialized = JSON.stringify(current);
    if (serialized === previous) return;
    previous = serialized;
    listener();
  };
  const visible = () => {
    if (document.visibilityState === "visible") check();
  };
  check();
  window.addEventListener(consentChangeEvent, check);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener(consentChangeEvent, check);
    window.removeEventListener("focus", check);
    window.removeEventListener("pageshow", check);
    document.removeEventListener("visibilitychange", visible);
  };
}
