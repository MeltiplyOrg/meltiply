import { expect, test } from "@playwright/test";
import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";
import {
  activeBrandProfileName,
  controlledProviderAccountId,
  editPostFromRow,
  provisionControlledChannels,
} from "./publication-fixtures";

/**
 * Exercises real owner-authenticated Posts, directory, Settings, keyboard search,
 * and mobile navigation. Screenshots cover the three toolbar-selected views:
 * Table, Grid, and Calendar, plus Brand Profiles and theme surfaces.
 */
test("keeps publishing work reachable through the redesigned workspace", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workspace = await openIsolatedOwnerWorkspace(page);
  await provisionControlledChannels(request, workspace.profileName, [
    {
      platform: "instagram",
      displayName: "Studio Instagram",
      providerUserId: controlledProviderAccountId("instagram"),
    },
    {
      platform: "threads",
      displayName: "Studio Threads",
      providerUserId: controlledProviderAccountId("threads"),
    },
  ]);
  await page.reload();
  await waitForWorkspace(page);
  await activeBrandProfileName(page);
  await page
    .locator("main header")
    .getByRole("button", { name: "Create post", exact: true })
    .click();
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
  await editPostFromRow(page, page.getByRole("row").filter({ hasText: "Studio update" }));
  await expect(page.getByPlaceholder(/what do you want to publish/i)).toHaveValue(
    "Studio update — ready for the next publishing window.",
  );
  await page.getByRole("button", { name: /back to posts/i }).click();

  const searchTrigger = page
    .getByRole("banner")
    .getByRole("button", { name: "Search and jump to", exact: true });
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
    page.getByRole("button", { name: `Clear ${workspace.profileName} filter`, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByRole("button", { name: workspace.profileName, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("aside").getByRole("button", { name: "Search and jump to", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await search.getByRole("textbox").fill("Channels");
  await search.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(page).toHaveURL(/\/channels(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Connected accounts" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Studio Instagram" })).toBeVisible();
  const connectionFilters = page.getByRole("group", { name: "Connection status", exact: true });
  await connectionFilters.getByRole("button", { name: "Expired", exact: true }).click();
  await expect(page.getByText("No accounts match the active filters.")).toBeVisible();
  await connectionFilters.getByRole("button", { name: "All statuses", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Studio Threads" })).toBeVisible();
  const connectionCell = page
    .getByRole("row")
    .filter({ hasText: "Studio Instagram" })
    .getByRole("cell")
    .nth(4);
  await expect(
    connectionCell.getByRole("button", { name: "Connected", exact: true }),
  ).toBeVisible();
  await expect(connectionCell).toHaveText("");
  await page.screenshot({ path: testInfo.outputPath("channels-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({ path: testInfo.outputPath("channels-user-1808.png"), fullPage: true });
  const filterSummary = page.locator("summary").filter({ hasText: /^Filter/ });
  await filterSummary.click();
  const filterPanel = page.getByRole("group", { name: "Filters", exact: true });
  await filterPanel.getByRole("button", { name: "Add Platform filter", exact: true }).click();
  await filterPanel.getByRole("button", { name: "All platforms", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Instagram", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("row").filter({ hasText: "Studio Threads" })).toHaveCount(0);
  if (!(await filterSummary.locator("..").evaluate((element) => element.hasAttribute("open"))))
    await filterSummary.click();
  await page.screenshot({
    path: testInfo.outputPath("channels-filter-builder.png"),
    fullPage: true,
  });
  await filterPanel.getByRole("button", { name: "Remove Platform filter", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Studio Threads" })).toBeVisible();
  await page.keyboard.press("Escape");
  await connectionCell.getByRole("button", { name: "Connected", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Connected");
  await page.screenshot({
    path: testInfo.outputPath("channels-health-tooltip.png"),
    fullPage: true,
  });
  await page.getByRole("heading", { name: "Channels", exact: true }).hover();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("tab", { name: /Brand Profiles/ }).click();
  await expect(page.getByRole("button", { name: "View channels" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("brand-profiles-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: /Accounts/ }).click();

  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.locator("aside").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings(?:\?|$)/);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({
    path: testInfo.outputPath("settings-light-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Security", exact: true }).click();
  const security = page.getByRole("region", { name: "Account security", exact: true });
  await expect(security.getByLabel("Current password", { exact: true })).toBeVisible();
  await expect(security.getByLabel("New password", { exact: true })).toBeVisible();
  await expect(
    security.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeVisible();
  await security.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await expect(security.getByRole("alert")).toContainText(
    "Enter your current password to continue.",
  );
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({
    path: testInfo.outputPath("settings-security-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.screenshot({ path: testInfo.outputPath("posts-light-desktop.png"), fullPage: true });

  await expect(
    page.locator("aside").getByRole("button", { name: "Table", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("aside").getByRole("button", { name: "Grid", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("aside").getByRole("button", { name: "Calendar", exact: true }),
  ).toHaveCount(0);
  const viewSelector = page.getByRole("group", { name: "Post view", exact: true });
  await expect(viewSelector.getByRole("button")).toHaveText(["Table", "Calendar", "Grid"]);
  for (const view of ["Grid", "Calendar", "Table"] as const) {
    const viewButton = viewSelector.getByRole("button", { name: view, exact: true });
    await viewButton.click();
    await expect(viewButton).toHaveAttribute("aria-pressed", "true");
    if (view === "Table") {
      const postsTable = page.getByRole("table", { name: "Posts table", exact: true });
      await expect(
        postsTable.getByRole("columnheader", { name: "Actions", exact: true }),
      ).toHaveCount(0);
      await expect(
        postsTable.getByRole("button", { name: "Post actions", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
      await page.getByRole("button", { name: "Columns" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Status" }).click();
      await expect(page.getByRole("columnheader", { name: "Status" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await page.screenshot({
      path: testInfo.outputPath(`posts-${view.toLowerCase()}-desktop.png`),
      fullPage: true,
    });
  }
  await page.locator("aside").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.reload();
  await waitForWorkspace(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath("posts-dark-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByRole("button", { name: "Open navigation menu", exact: true });
  await expect(mobileMenu).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("posts-dark-mobile.png"), fullPage: true });
  await mobileMenu.click();
  const mobileNavigation = page.getByRole("dialog", { name: "Workspace navigation", exact: true });
  await mobileNavigation.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("channels-mobile.png"), fullPage: true });
  await mobileMenu.click();
  await page
    .getByRole("dialog", { name: "Workspace navigation", exact: true })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settings-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(security.getByLabel("Current password", { exact: true })).toBeVisible();
  await expect(security.getByLabel("New password", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("settings-security-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
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
