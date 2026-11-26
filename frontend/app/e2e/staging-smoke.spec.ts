import { expect, test } from "@playwright/test";

const authenticatedRoutes = [
  ["/posts", "Search posts..."],
  ["/channels", "Search accounts"],
] as const;

test("loads every authenticated product route", async ({ page }) => {
  for (const [route, searchLabel] of authenticatedRoutes) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}(?:\\?|$)`));
    await expect(page.getByRole("textbox", { name: searchLabel, exact: true })).toBeVisible();
  }
});

test("exercises safe authenticated controls without creating business data", async ({ page }) => {
  await page.goto("/channels");
  const search = page.getByRole("textbox", { name: "Search accounts", exact: true });
  await search.fill("staging-smoke-no-matching-account");
  await expect(search).toHaveValue("staging-smoke-no-matching-account");
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(search).toHaveValue("");
});
