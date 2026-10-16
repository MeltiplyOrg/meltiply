import { useLocation, useSearchParams as useRouterSearchParams } from "react-router";

/**
 * Returns the current URL pathname from the React Router location.
 * Provides a Next.js-compatible hook interface over React Router's `useLocation`.
 *
 * @returns The current route pathname string (e.g. `/assets`, `/home`).
 */
export function usePathname(): string {
  return useLocation().pathname;
}

/**
 * Returns a read-only instance of the current query string's `URLSearchParams`.
 * Provides a Next.js-compatible hook interface over React Router's `useSearchParams`.
 *
 * @returns Current `URLSearchParams` object.
 */
export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}
