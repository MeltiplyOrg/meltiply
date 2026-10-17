import { expect, test } from "@playwright/test";
import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

/**
 * Exercises the adapted shell against real owner sessions and saved Posts.
 * Guards keyboard jump/focus restoration, real profile scoping, view shortcuts,
 * theme persistence, mobile Settings, and sign-out reachability. Screenshots are
 * attached as hosted review evidence; no mock API or seeded reference UI is used.
 */
test("keeps publishing work reachable through the redesigned workspace", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workspace = await openIsolatedOwnerWorkspace(page);
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await page
    .getByPlaceholder(/what do you want to publish/i)
    .fill("Studio update — ready for the next publishing window.");
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await expect(page.getByText(/Saved to your workspace at/i)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("composer-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: /back to posts/i }).click();
  await expect(page.getByRole("row").filter({ hasText: "Studio update" })).toBeVisible();

  const header = page.locator("header.workspace-topbar");
  const searchTrigger = header.getByRole("button", { name: "Search and jump to", exact: true });
  await searchTrigger.click();
  const search = page.getByRole("dialog", { name: "Search and jump to", exact: true });
  await expect(search.getByRole("textbox")).toBeFocused();
  await search.getByRole("textbox").fill("nothing-matches-this-query");
  await expect(search.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchTrigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await search.getByRole("textbox").fill(workspace.profileName);
  await search.getByRole("button", { name: workspace.profileName, exact: true }).click();
  await expect(
    page.locator("aside").getByRole("button", { name: workspace.profileName, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+k");
  await search.getByRole("textbox").fill("Channels");
  await search.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(page).toHaveURL(/\/channels(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("channels-desktop.png"), fullPage: true });

  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await header.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({
    path: testInfo.outputPath("settings-light-desktop.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("posts-light-desktop.png"), fullPage: true });
  for (const view of ["Grid", "Calendar", "List"] as const) {
    await page.locator("aside").getByRole("button", { name: view, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view.toLowerCase()}`));
    await page.screenshot({
      path: testInfo.outputPath(`posts-${view.toLowerCase()}-desktop.png`),
      fullPage: true,
    });
  }
  await header.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await page.reload();
  await waitForWorkspace(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath("posts-dark-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open navigation menu", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("posts-dark-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Workspace navigation", exact: true })
    .getByRole("button", { name: "Channels", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("channels-mobile.png"), fullPage: true });
  await header.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("tab", { name: "Account", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png"), fullPage: true });
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await settings.getByRole("button", { name: "Light", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  const publicUrl = process.env.MELTIPLY_E2E_PUBLIC_URL;
  if (publicUrl) {
    await expect
      .poll(
        async () => {
          try {
            return (await page.request.get(publicUrl)).ok();
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    for (const size of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const route of ["/", "/docs/settings"]) {
        await page.goto(new URL(route, publicUrl).href);
        await expect(page.locator("main").first()).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(
            `public-${route === "/" ? "landing" : "settings"}-${size.width}.png`,
          ),
          fullPage: true,
        });
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
      }
    }
  }
});
