import { expect, test } from "@playwright/test";

const authenticatedRoutes = [
  ["/posts", "Search posts..."],
  ["/channels", "Search accounts"],
] as const;

/**
 * Exercises each retained workspace route with an existing authenticated session.
 * The URL and route-specific search control prove the intended surface loaded,
 * without coupling readiness to incidental page-heading copy.
 */
test("loads every authenticated product route", async ({ page }) => {
  for (const [route, searchLabel] of authenticatedRoutes) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}(?:\\?|$)`));
    await expect(page.getByRole("textbox", { name: searchLabel, exact: true })).toBeVisible();
  }
});

/**
 * Exercises local Channels filtering without creating or modifying business data.
 * After navigating directly to Channels, search activates Reset; resetting must
 * clear the query in the visible toolbar.
 */
test("exercises safe authenticated controls without creating business data", async ({ page }) => {
  await page.goto("/channels");
  const search = page.getByRole("textbox", { name: "Search accounts", exact: true });
  await search.fill("staging-smoke-no-matching-account");
  await expect(search).toHaveValue("staging-smoke-no-matching-account");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(search).toHaveValue("");
});
