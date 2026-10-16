import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { activeBrandProfileName } from "./publication-fixtures";

export type GeneratedCredentials = Readonly<{ name: string; email: string; password: string }>;

/**
 * A Workspace that belongs to exactly one test: a freshly registered account,
 * one Brand Profile created through Channels, and that profile left selected
 * so profile-scoped composer mutations can run.
 */
export interface IsolatedWorkspace {
  /** Credentials a second browser context can sign in with. */
  credentials: GeneratedCredentials;
  /** Display name of the workspace's Brand Profile, for fixtures that resolve it by name. */
  profileName: string;
}

const isolatedAuthPages = new WeakSet<Page>();

/**
 * Gives each local browser actor its own IP bucket without changing auth limits.
 * Only loopback auth requests carry a unique documentation-range IPv6 address;
 * they still reach the real Worker and database. Staging/external traffic is
 * untouched, and reloads retain the page's identity.
 */
async function isolateLocalAuthClient(page: Page) {
  if (isolatedAuthPages.has(page) || process.env.STAGING_E2E_BASE_URL) return;
  const apiOrigin = new URL(
    process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787",
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(apiOrigin.hostname)) return;
  const identifier = randomUUID().replaceAll("-", "").slice(0, 24);
  const address = `2001:db8:${Array.from({ length: 6 }, (_, index) =>
    identifier.slice(index * 4, index * 4 + 4),
  ).join(":")}`;
  await page.route(`${apiOrigin.origin}/api/auth/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": address },
    }),
  );
  isolatedAuthPages.add(page);
}

/**
 * Builds unique sign-up credentials for one test run. A UUID suffix keeps the
 * email and display name collision-free across parallel workers and repeated
 * runs against a shared backend; the password embeds the same identifier plus
 * fixed characters so it satisfies the sign-up form's complexity rules.
 *
 * @returns Name, email, and password safe to submit to `/sign-up` once.
 */
export function generatedCredentials(): GeneratedCredentials {
  const identifier = randomUUID().replaceAll("-", "");
  return {
    name: `E2E ${identifier.slice(0, 8)}`,
    email: `meltiply-e2e-${identifier}@example.com`,
    password: `Meltiply!${identifier}a1`,
  };
}

/**
 * Grants functional consent before app boot for journeys that assert optional
 * preference persistence; analytics and marketing remain explicitly denied.
 *
 * @param page - Playwright page bound to the app under test.
 */
export async function allowFunctionalConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const consent = encodeURIComponent(
      JSON.stringify({
        analytics: false,
        expires: Date.now() + 180 * 24 * 60 * 60 * 1_000,
        functional: true,
        marketing: false,
        v: 1,
      }),
    );
    document.cookie = `meltiply-consent=${consent}; Path=/; Max-Age=15552000; SameSite=Lax`;
  });
}

/**
 * Drives the real `/sign-up` form through account creation. Fills each labelled
 * field and submits via the "Create account" button so the test exercises the
 * same client path a user takes; resolves after the click, so callers must wait
 * for the post-sign-up redirect (`waitForURL(/\/posts/)`) and the rendered
 * workspace ({@link waitForWorkspace}) before asserting.
 * Local browser actors use independent IP fixtures, preserving auth rate limits
 * without competing for the host's shared sign-up budget. Functional consent is
 * seeded explicitly so optional recovery assertions test consented persistence.
 *
 * @param page - Playwright page bound to the app under test.
 * @param credentials - Unique credentials from {@link generatedCredentials}.
 */
export async function signUp(page: Page, credentials: GeneratedCredentials) {
  await allowFunctionalConsent(page);
  await isolateLocalAuthClient(page);
  await page.goto("/sign-up");
  await page.getByLabel(/your name/i).fill(credentials.name);
  await page.getByLabel(/email address/i).fill(credentials.email);
  await page.getByLabel(/^password$/i).fill(credentials.password);
  await page.getByRole("button", { name: /create account/i }).click();
}

/**
 * Signs an existing account back in through the real `/sign-in` form.
 *
 * Used to prove that saved work is recoverable from a browser-local state that
 * never carried it: a second context starts without the auth session or optional
 * browser data; only the consent cookie is seeded for the recovery contract, so
 * anything recovered must have come from the server.
 * Local browser actors use their own IP fixture; production auth limits remain
 * unchanged and requests are not mocked.
 *
 * @param page - Playwright page bound to the app under test.
 * @param credentials - Credentials previously passed to {@link signUp}.
 */
export async function signIn(page: Page, credentials: GeneratedCredentials) {
  await allowFunctionalConsent(page);
  await isolateLocalAuthClient(page);
  await page.goto("/sign-in");
  await page.getByLabel(/email address/i).fill(credentials.email);
  await page.getByLabel(/^password$/i).fill(credentials.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
}

/**
 * Waits until the signed-in workspace has actually rendered, not just
 * navigated: `/posts` matches while the lazy `DashboardLayout`/`PostsPage`
 * chunks still download, leaving `RouteFallback` ("Loading Meltiply…") or the
 * previous route on screen and the sidebar controls absent. The Posts `h1`
 * only mounts inside the loaded chunks, so it is the readiness signal on the
 * posts route; the bound matches `waitForURL` so broken hydration fails fast.
 *
 * @param page - Playwright page bound to the app under test.
 */
export async function waitForWorkspace(page: Page) {
  await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible({ timeout: 30_000 });
}

/**
 * Registers a brand new account and scopes the session to its Brand Profile.
 *
 * Every test that owns this Workspace starts with an empty Posts list, an empty
 * Asset inventory, and no Channels, so nothing another test wrote can satisfy an
 * assertion. Registration provisions the organization, not a Brand Profile:
 * this helper creates one through the real Channels dialog, which selects the
 * new profile and opens account connection. Returning to Posts closes that flow;
 * the scoped profile then permits the composer to own media and save drafts.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns Credentials for a second browser context, plus the active profile name.
 */
export async function signUpIsolatedWorkspace(page: Page): Promise<IsolatedWorkspace> {
  const credentials = generatedCredentials();
  await signUp(page, credentials);
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await waitForWorkspace(page);
  await page.goto("/channels");
  await page.getByRole("button", { name: "Create Brand Profile", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Brand Profile", exact: true });
  await editor.getByLabel("Profile name", { exact: true }).fill(`${credentials.name} profile`);
  await editor.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(editor).not.toBeVisible({ timeout: 30_000 });
  await page.goto("/posts");
  await waitForWorkspace(page);
  return { credentials, profileName: await activeBrandProfileName(page) };
}
