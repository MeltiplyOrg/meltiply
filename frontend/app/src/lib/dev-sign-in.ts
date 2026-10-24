/**
 * Seeded Installation Owner credentials for local development sign-in, matching
 * `scripts/cloudflare-local/postgres/seed.sql` and the root README.
 *
 * `vite.config.ts` replaces this whole module with an inert stub in every
 * build, so the fixture cannot reach staging or production artifacts. The
 * sign-in form additionally checks `isDevMode()` before applying it.
 */
export const localDevOwnerSignIn = {
  email: "alpha@meltiply.local",
  password: "MeltiplyLocal1!",
} as const;
