export type ConsentCategory = "functional";

export interface CookieConsent {
  functional: boolean;
}

export const consentCookieName = "meltiply-consent";
export const consentLifetimeSeconds = 180 * 24 * 60 * 60;
export const productionCookieDomain = "meltiply.com";
export const functionalCookieNames = ["meltiply-theme"] as const;
export const functionalStorageKeys = [
  "meltiply.theme",
  "meltiply.language",
  "meltiply.devbox",
  "meltiply.onboarding.setup",
] as const;
export const functionalStoragePrefixes = [
  "meltiply.composer.",
  "meltiply.upload.v1.",
  "meltiply.upload.create.v1.",
] as const;
const consentChangeEvent = "meltiply:cookie-consent";
let volatileConsent: CookieConsent | null = null;

function withBrowserStorage<T>(access: () => T, blocked: T): T {
  try {
    return access();
  } catch {
    // localStorage and document.cookie throw a SecurityError when the browser blocks site data.
    return blocked;
  }
}

/** Writes a root-path cookie shared across production subdomains and host-scoped elsewhere. */
export function writeSiteCookie(name: string, value: string, maxAgeSeconds: number): void {
  const { hostname, protocol } = window.location;
  const secure = protocol === "https:" ? "; Secure" : "";
  const domain =
    hostname === productionCookieDomain || hostname.endsWith(`.${productionCookieDomain}`)
      ? `; Domain=${productionCookieDomain}`
      : "";
  withBrowserStorage(() => {
    document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}${domain}`;
  }, undefined);
}

function parseConsent(raw: string): CookieConsent | null {
  const value: unknown = JSON.parse(decodeURIComponent(raw));
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== 1 ||
    !("expires" in value) ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    value.expires <= Date.now() ||
    !("functional" in value) ||
    typeof value.functional !== "boolean"
  )
    return null;
  return { functional: value.functional };
}

/** Reads the essential consent record; malformed, expired, or unversioned records grant nothing. */
export function readCookieConsent(): CookieConsent | null {
  if (typeof document === "undefined") return null;
  if (volatileConsent !== null) return volatileConsent;
  return withBrowserStorage(() => {
    const prefix = `${consentCookieName}=`;
    const entry = document.cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    return entry === undefined ? null : parseConsent(entry.slice(prefix.length));
  }, null);
}

export function hasCookieConsent(category: ConsentCategory): boolean {
  return readCookieConsent()?.[category] === true;
}

/** Removes the inventoried optional records on this origin; authentication data is untouched. */
export function clearFunctionalStorage(): void {
  withBrowserStorage(() => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (
        key !== null &&
        (functionalStorageKeys.some((item) => item === key) ||
          functionalStoragePrefixes.some((prefix) => key.startsWith(prefix)))
      )
        window.localStorage.removeItem(key);
    }
  }, undefined);
  for (const name of functionalCookieNames) writeSiteCookie(name, "", 0);
}

function syncConsentAttributes(consent: CookieConsent | null): void {
  const root = document.documentElement;
  root.toggleAttribute("data-cookie-functional", consent?.functional === true);
  root.toggleAttribute("data-cookie-decided", consent !== null);
  if (consent?.functional !== true) clearFunctionalStorage();
}

/** Saves an explicit choice; when the browser refuses the cookie the choice holds for this page only. */
export function writeCookieConsent(consent: CookieConsent): void {
  const encoded = encodeURIComponent(
    JSON.stringify({ v: 1, ...consent, expires: Date.now() + consentLifetimeSeconds * 1000 }),
  );
  writeSiteCookie(consentCookieName, encoded, consentLifetimeSeconds);
  const persisted = withBrowserStorage(
    () =>
      document.cookie
        .split(";")
        .some((entry) => entry.trim() === `${consentCookieName}=${encoded}`),
    false,
  );
  volatileConsent = persisted ? null : consent;
  syncConsentAttributes(consent);
  window.dispatchEvent(new Event(consentChangeEvent));
}

export function readFunctionalStorage(key: string): string | null {
  if (!hasCookieConsent("functional")) return null;
  return withBrowserStorage(() => window.localStorage.getItem(key), null);
}

/** Persists optional data only with consent; removing a record (`null`) is always permitted. */
export function writeFunctionalStorage(key: string, value: string | null): void {
  if (value !== null && !hasCookieConsent("functional")) return;
  withBrowserStorage(() => {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }, undefined);
}

/**
 * Observes choices made on this page and, on focus or visibility, on sibling sites. The listener
 * runs only when the decision changes; leaving functional consent clears this origin's records.
 */
export function subscribeCookieConsent(listener: () => void): () => void {
  let previous = readCookieConsent();
  syncConsentAttributes(previous);
  const check = () => {
    const current = readCookieConsent();
    if (current?.functional === previous?.functional) return;
    previous = current;
    syncConsentAttributes(current);
    listener();
  };
  const visible = () => {
    if (document.visibilityState === "visible") check();
  };
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
