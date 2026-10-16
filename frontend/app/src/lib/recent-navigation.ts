import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

const recentNavigationStorageKey = "meltiply.recent-navigation";
const recentNavigationLimit = 4;

/**
 * Reads the recent dashboard routes only after functional consent, returning an
 * empty list for missing, malformed, or unavailable browser storage.
 *
 * @returns Array of recent pathname strings (e.g. `["/assets", "/calendar"]`).
 */
export function loadRecentNavigation(): string[] {
  const value = readFunctionalStorage(recentNavigationStorageKey);
  if (!value) return [];

  try {
    const paths: unknown = JSON.parse(value);
    return Array.isArray(paths)
      ? paths
          .filter((path): path is string => typeof path === "string")
          .slice(0, recentNavigationLimit)
      : [];
  } catch {
    return [];
  }
}

/**
 * Prepends a visited route when functional consent permits storage, deduplicating
 * older entries and keeping the latest four for the Recents panel.
 *
 * @param pathname The route pathname to record.
 */
export function recordRecentNavigation(pathname: string): void {
  const next = [pathname, ...loadRecentNavigation().filter((path) => path !== pathname)].slice(
    0,
    recentNavigationLimit,
  );
  writeFunctionalStorage(recentNavigationStorageKey, JSON.stringify(next));
}
