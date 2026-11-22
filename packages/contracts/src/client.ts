import createClient from "openapi-fetch";

import type { paths } from "./generated/schema";

export const apiVersionPath = "/api/v1";

/**
 * Factory creating a typed openapi-fetch client bound to the Meltiply v1 API surface.
 * Enforces that baseUrl is an origin without path, query, or fragment, and appends the canonical apiVersionPath (`/api/v1`).
 */
export function createMeltiplyClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const origin = new URL(baseUrl);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.origin === "null" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError("Meltiply API base URL must be an origin without a path, query, or hash");
  }

  return createClient<paths>({
    baseUrl: `${origin.origin}${apiVersionPath}`,
    fetch: fetchImpl,
  });
}

export type MeltiplyClient = ReturnType<typeof createMeltiplyClient>;
