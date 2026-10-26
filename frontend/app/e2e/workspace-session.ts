import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { activeBrandProfileName } from "./publication-fixtures";

export type GeneratedCredentials = Readonly<{ name: string; email: string; password: string }>;

/** A test's selected Brand Profile and owner credentials, not an extra login account. */
export interface IsolatedWorkspace {
  credentials: GeneratedCredentials;
  profileName: string;
}

const isolatedAuthPages = new WeakSet<Page>();

/** Gives loopback Worker browser actors distinct edge-IP fixtures; never changes external requests. */
async function isolateLocalAuthClient(page: Page) {
  if (isolatedAuthPages.has(page) || process.env.STAGING_E2E_BASE_URL) return;
  const origin = new URL(process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) return;
  const identifier = randomUUID().replaceAll("-", "").slice(0, 24);
  const address = `2001:db8:${Array.from({ length: 6 }, (_, index) => identifier.slice(index * 4, index * 4 + 4)).join(":")}`;
  await page.route(`${origin.origin}/api/auth/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": address } }),
  );
  isolatedAuthPages.add(page);
}

/** Uses the documented local-only owner fixture, with unique labels for each test's Brand Profile. */
export function ownerCredentials(): GeneratedCredentials {
  return {
    name: `E2E ${randomUUID().slice(0, 8)}`,
    email: "alpha@meltiply.local",
    password: "MeltiplyLocal1!",
  };
}

/** Grants the one optional purpose before boot so journeys start with an explicit saved decision. */
async function allowFunctionalConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const consent = encodeURIComponent(
      JSON.stringify({
        expires: Date.now() + 180 * 24 * 60 * 60 * 1_000,
        functional: true,
        v: 1,
      }),
    );
    document.cookie = `meltiply-consent=${consent}; Path=/; Max-Age=15552000; SameSite=Lax`;
  });
}

/**
 * Signs the seeded Installation Owner into the single shared Workspace.
 *
 * The shared Workspace and its seed fixtures are installation data, so a local
 * journey must not delete them. Auth tables, owner credentials, and other RLS
 * users are untouched. A second browser uses signIn, never a reset.
 */
export async function openOwnerWorkspace(page: Page, credentials: GeneratedCredentials) {
  if (process.env.STAGING_E2E_BASE_URL) throw new Error("Owner fixture reset is local-only");
  await signIn(page, credentials);
}

/** Signs the existing owner in through the actual form without resetting saved work or session state. */
export async function signIn(page: Page, credentials: GeneratedCredentials) {
  await allowFunctionalConsent(page);
  await isolateLocalAuthClient(page);
  await page.goto("/sign-in");
  await page.getByLabel(/email address/i).fill(credentials.email);
  await page.getByLabel(/^password$/i).fill(credentials.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
}

/** Waits for the hydrated Posts surface, not merely the route URL. */
export async function waitForWorkspace(page: Page) {
  await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible({ timeout: 30_000 });
}

/** Creates a uniquely named Brand Profile in the shared Workspace through the real Channels dialog. */
export async function openIsolatedOwnerWorkspace(page: Page): Promise<IsolatedWorkspace> {
  const credentials = ownerCredentials();
  await openOwnerWorkspace(page, credentials);
  await waitForWorkspace(page);
  await page.goto("/channels");
  await page.getByRole("button", { name: "Create Brand Profile", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Brand Profile", exact: true });
  const profileName = `${credentials.name} profile ${randomUUID().slice(0, 6)}`;
  await editor.getByLabel("Profile name", { exact: true }).fill(profileName);
  await editor.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(editor).not.toBeVisible({ timeout: 30_000 });
  await page.goto("/posts");
  await waitForWorkspace(page);
  return { credentials, profileName: await activeBrandProfileName(page, profileName) };
}
