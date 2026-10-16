import createClient from "openapi-fetch";

import type { paths } from "./generated/schema";

export const apiVersionPath = "/api/v1";

/**
 * Factory creating a typed openapi-fetch client bound to the Meltiply v1 API surface.
 * Enforces that baseUrl is an origin without path, query, or fragment, and appends the canonical apiVersionPath (`/api/v1`).
 *
 * @param baseUrl - Base API origin URL (e.g., "https://api.meltiply.com").
 * @param fetchImpl - Optional custom fetch implementation (defaults to global fetch).
 * @returns Fully typed MeltiplyClient instance configured for the OpenAPI schema.
 * @throws {TypeError} When baseUrl contains a path, query, or hash.
 */
export function createMeltiplyClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const origin = new URL(baseUrl);
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Meltiply API base URL must be an origin without a path, query, or hash");
  }

  return createClient<paths>({
    baseUrl: `${origin.origin}${apiVersionPath}`,
    fetch: fetchImpl,
  });
}

export type MeltiplyClient = ReturnType<typeof createMeltiplyClient>;
