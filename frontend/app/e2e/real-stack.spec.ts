import { expect, test } from "@playwright/test";

const protectedRoutes = ["/posts", "/channels", "/settings"] as const;

const retiredRoutes = [
  "/analytics",
  "/inbox",
  "/billing",
  "/agent",
  "/plugs",
  "/dashboard",
  "/home",
  "/distribute",
  "/calendar",
  "/composer",
  "/scheduled",
  "/drafts",
  "/media",
  "/assets",
  "/assets/e2e-missing-asset",
  "/upload",
  "/platforms",
  "/integrations",
  "/third-party",
  "/harness",
] as const;

function localApiOrigin(): string {
  return process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787";
}

test("reaches the real API health endpoint", async ({ request }) => {
  const response = await request.get(`${localApiOrigin()}/api/v1/health`);
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

/**
 * The product app owns only protected workspace routes; the marketing landing
 * page is a separate Astro project. The root path therefore follows the same
 * redirect chain as any unknown path (`/` → `/posts` → sign-in) rather than
 * rendering any landing content here.
 */
test("redirects the root path to sign-in without a session", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
});

test("keeps public registration closed after the owner exists", async ({ page }) => {
  await page.goto("/sign-up");
  await expect(page).toHaveURL(/\/sign-in(?:\/|$)/);
  await expect(page.getByLabel(/email address/i)).toBeVisible();
  await expect(page.getByLabel(/^password$/i)).toBeVisible();
  await expect(page.getByLabel(/setup secret/i)).toHaveCount(0);
  await expect(page.getByLabel(/your name/i)).toHaveCount(0);
});

for (const route of protectedRoutes) {
  test(`redirects ${route} to sign-in without a session`, async ({ page }) => {
    await page.goto(route);
    await expect(page).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
  });
}

for (const route of retiredRoutes) {
  test(`retired route ${route} follows unknown-route behaviour`, async ({ page }) => {
    await page.goto(route);
    // No alias or legacy page survives the cutover, so a retired path takes the
    // same `*` → `/posts` fallback as any unknown path. Without a session that
    // protected route redirects to sign-in: the marketing landing page lives in
    // the separate Astro project and is never served from this origin, so an
    // assertion on the landing heading here could never hold.
    await expect(page).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
  });
}

test("publishes browser-run health metrics for Grafana", async ({ request }) => {
  const port = process.env.MELTIPLY_E2E_METRICS_PORT?.trim() || "9464";
  await expect
    .poll(async () => {
      const response = await request.get(`http://127.0.0.1:${port}/metrics`);
      return response.status();
    })
    .toBe(200);
  const response = await request.get(`http://127.0.0.1:${port}/metrics`);
  const body = await response.text();
  expect(body).toContain("meltiply_frontend_e2e_tests_total");
  expect(body).toContain("meltiply_frontend_e2e_last_run_success");
});
