import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { activeBrandProfileName } from "./publication-fixtures";
import { frontendOrigin } from "./ports";

export type GeneratedCredentials = Readonly<{ name: string; email: string; password: string }>;

export interface IsolatedWorkspace {
  credentials: GeneratedCredentials;
  profileName: string;
}

const isolatedAuthPages = new WeakSet<Page>();

async function isolateLocalAuthClient(page: Page) {
  if (isolatedAuthPages.has(page) || process.env.STAGING_E2E_BASE_URL) return;
  const apiOrigin = new URL(
    process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787",
  );
  const origins = [apiOrigin, new URL(frontendOrigin)]
    .filter((origin) => ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    .map((origin) => origin.origin);
  if (origins.length === 0) return;
  const identifier = randomUUID().replaceAll("-", "").slice(0, 24);
  const address = `2001:db8:${Array.from({ length: 6 }, (_, index) => identifier.slice(index * 4, index * 4 + 4)).join(":")}`;
  for (const origin of origins) {
    await page.route(`${origin}/api/auth/**`, (route) =>
      route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": address } }),
    );
  }
  isolatedAuthPages.add(page);
}

export function ownerCredentials(): GeneratedCredentials {
  return {
    name: `E2E ${randomUUID().slice(0, 8)}`,
    email: "alpha@meltiply.local",
    password: "MeltiplyLocal1!",
  };
}

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

export async function openOwnerWorkspace(page: Page, credentials: GeneratedCredentials) {
  if (process.env.STAGING_E2E_BASE_URL) throw new Error("Owner fixture reset is local-only");
  await signIn(page, credentials);
}

async function clearSignInRateLimits(): Promise<void> {
  const connectionString = process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL?.trim();
  if (!connectionString) return;
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/meltiply") {
    throw new Error("Sign-in budget reset requires the dedicated loopback test database");
  }
  const pool = new Pool({ connectionString });
  try {
    await pool.query("DELETE FROM auth_rate_limits WHERE action = 'sign-in'");
  } finally {
    await pool.end();
  }
}

export async function signIn(page: Page, credentials: GeneratedCredentials) {
  await allowFunctionalConsent(page);
  await isolateLocalAuthClient(page);
  await clearSignInRateLimits();
  await page.goto("/sign-in");
  await page.getByLabel(/email address/i).fill(credentials.email);
  await page.getByLabel(/^password$/i).fill(credentials.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
}

export async function waitForWorkspace(page: Page) {
  await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible({ timeout: 30_000 });
}

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
