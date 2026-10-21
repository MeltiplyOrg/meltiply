import { expect, test } from "@playwright/test";

import { ownerCredentials, signIn, openOwnerWorkspace } from "./workspace-session";

test.use({ screenshot: "off", trace: "off" });
test.setTimeout(90_000);

test("signs the owner out and back in through the Better Auth forms", async ({ page }) => {
  const credentials = ownerCredentials();

  await openOwnerWorkspace(page, credentials);
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("main")).toBeVisible();

  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menu", { name: "Account menu", exact: true })
    .getByRole("menuitem", { name: "Sign out", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });

  await signIn(page, credentials);
  await expect(page).toHaveURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("main")).toBeVisible();
});
