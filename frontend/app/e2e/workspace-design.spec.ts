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
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const faces = await Promise.all(
          ["400 13px Geist", "500 13px Geist", "600 13px Geist", "400 13px 'Geist Mono'"].map(
            (font) => document.fonts.load(font),
          ),
        );
        return faces.every((family) => family.some((face) => face.status === "loaded"));
      }),
    )
    .toBe(true);
  const accountTrigger = page.getByRole("button", { name: "Account menu", exact: true });
  const footerSlots = await Promise.all(
    [
      page.locator("aside").getByRole("link", { name: "Help and resources", exact: true }),
      page.locator("aside").getByRole("button", { name: "Settings", exact: true }),
      accountTrigger,
    ].map(async (row) => {
      const box = await row.locator(":scope > :first-child").boundingBox();
      if (!box) throw new Error("Footer row is missing its leading icon slot");
      return box;
    }),
  );
  for (const slot of footerSlots) {
    expect(slot.width).toBeCloseTo(16, 0);
    expect(slot.x).toBeCloseTo(footerSlots[0].x, 0);
  }
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu", { name: "Account menu", exact: true });
  await expect(
    accountMenu.getByRole("menuitem", { name: "Account settings", exact: true }),
  ).toBeVisible();
  const quickTheme = accountMenu.getByRole("group", { name: "Theme", exact: true });
  await quickTheme.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("sidebar-account-menu-dark-desktop.png"),
    fullPage: true,
  });
  await expect(accountMenu).toBeVisible();
  await expect(quickTheme.getByRole("menuitemradio", { name: "Dark", exact: true })).toBeChecked();
  await quickTheme.getByRole("menuitemradio", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    quickTheme.getByRole("menuitemradio", { name: "System", exact: true }),
  ).toBeChecked();
  await quickTheme.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("sidebar-account-menu-desktop.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await accountTrigger.click();
  await expect(accountMenu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("sidebar-account-menu-collapsed.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await accountTrigger.click();
  await accountMenu.getByRole("menuitem", { name: "Account settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?section=account/);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [index, caption] of [
    "Studio update — ready for the next publishing window.",
    "Second draft — selection review.",
  ].entries()) {
    await page
      .locator("main header")
      .getByRole("button", { name: "Create post", exact: true })
      .click();
    await page.getByPlaceholder(/what do you want to publish/i).fill(caption);
    await page
      .getByRole("button", { name: /save( draft)?$/i })
      .first()
      .click();
    await expect(page.getByText(/Saved to your workspace at/i)).toBeVisible({ timeout: 30_000 });
    if (index === 0)
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("composer-desktop.png"),
        fullPage: true,
      });
    await page.getByRole("button", { name: /back to posts/i }).click();
  }
  const firstPost = page.getByRole("row").filter({ hasText: "Studio update" });
  await firstPost.getByRole("checkbox", { name: "Select post", exact: true }).check();
  const selectAllPosts = page.getByRole("checkbox", {
    name: "Select all visible posts",
    exact: true,
  });
  await expect(selectAllPosts).not.toBeChecked();
  await expect(selectAllPosts).toHaveJSProperty("indeterminate", false);
  const selectionPill = page.getByRole("region", { name: "Selection actions", exact: true });
  await expect(selectionPill).toContainText("1 selected");
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-selection-pill-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selectAllPosts.check();
  await expect(selectionPill).toContainText("2 selected");
  await expect(selectAllPosts).toBeChecked();
  await selectionPill.getByRole("button", { name: "Deselect", exact: true }).click();
  await expect(selectionPill).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Studio update" })).toBeVisible();
  const inspectTrigger = page
    .getByRole("row")
    .filter({ hasText: "Studio update" })
    .getByTitle("View details");
  await inspectTrigger.click();
  const inspector = page.getByRole("dialog", { name: "Post details", exact: true });
  await expect(
    inspector.getByText("Studio update — ready for the next publishing window.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("post-drawer-desktop.png"),
    fullPage: true,
  });
  await inspector.getByRole("button", { name: "Expand panel", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("post-drawer-expanded-desktop.png"),
    fullPage: true,
  });
  await inspector.getByRole("button", { name: "Restore side panel", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await expect(inspectTrigger).toBeFocused();
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
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("channels-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("channels-user-1808.png"),
    fullPage: true,
  });
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
    animations: "disabled",
    path: testInfo.outputPath("channels-filter-builder.png"),
    fullPage: true,
  });
  await filterPanel.getByRole("button", { name: "Remove Platform filter", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Studio Threads" })).toBeVisible();
  await page.keyboard.press("Escape");
  await connectionCell.getByRole("button", { name: "Connected", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Connected");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("channels-health-tooltip.png"),
    fullPage: true,
  });
  await page.getByRole("heading", { name: "Channels", exact: true }).hover();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("tab", { name: /Brand Profiles/ }).click();
  await expect(page.getByRole("button", { name: "View channels" })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("brand-profiles-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: /Accounts/ }).click();

  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.locator("aside").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings(?:\?|$)/);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.setViewportSize({ width: 1808, height: 984 });
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("settings-light-desktop.png"),
    fullPage: true,
  });
  for (const section of ["Language", "Account"] as const) {
    await page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("button", { name: section, exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: section === "Account" ? "Account and workspace" : section,
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`settings-${section.toLowerCase()}-desktop.png`),
      fullPage: true,
    });
  }
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
    animations: "disabled",
    path: testInfo.outputPath("settings-security-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-light-desktop.png"),
    fullPage: true,
  });

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
  // Directory filter reset returned to aggregate scope; scheduling needs one real owner.
  await activeBrandProfileName(page);
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
      animations: "disabled",
      path: testInfo.outputPath(`posts-${view.toLowerCase()}-desktop.png`),
      fullPage: true,
    });
    if (view === "Calendar") {
      const calendar = page.getByRole("region", { name: "Publishing calendar", exact: true });
      const period = calendar.getByRole("group", { name: "Calendar period", exact: true });
      await period.getByRole("button", { name: "Week", exact: true }).click();
      const currentWeek = await calendar.getByRole("heading").innerText();
      await calendar.getByRole("button", { name: "Next week", exact: true }).click();
      await expect(calendar.getByRole("heading")).not.toHaveText(currentWeek);
      await calendar.getByRole("button", { name: "Previous week", exact: true }).click();
      await expect(calendar.getByRole("heading")).toHaveText(currentWeek);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("posts-calendar-week-desktop.png"),
        fullPage: true,
      });
      await period.getByRole("button", { name: "Month", exact: true }).click();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateLabel = new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(tomorrow);
      await calendar.getByRole("group", { name: dateLabel, exact: true }).hover();
      await calendar
        .getByRole("button", { name: `Schedule post on ${dateLabel}`, exact: true })
        .click();
      const pad = (value: number) => String(value).padStart(2, "0");
      await expect(page.getByLabel("Schedule date and time", { exact: true })).toHaveValue(
        `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`,
      );
      await page.getByRole("button", { name: /back to posts/i }).click();
    }
  }
  await page.locator("aside").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.locator("aside").getByRole("button", { name: "Posts", exact: true }).click();
  await waitForWorkspace(page);
  await page.reload();
  await waitForWorkspace(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-dark-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenu = page.getByRole("button", { name: "Open navigation menu", exact: true });
  await expect(mobileMenu).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-dark-mobile.png"),
    fullPage: true,
  });
  await firstPost.getByRole("checkbox", { name: "Select post", exact: true }).check();
  await expect(selectionPill).toContainText("1 selected");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-selection-pill-dark-mobile.png"),
    fullPage: true,
  });
  await selectionPill.getByRole("button", { name: "Deselect", exact: true }).click();
  await inspectTrigger.click();
  await expect(inspector).toBeVisible();
  await expect(inspector).toBeFocused();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("post-drawer-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await viewSelector.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Publishing calendar", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-calendar-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("group", { name: "Calendar period", exact: true })
    .getByRole("button", { name: "Week", exact: true })
    .click();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("posts-calendar-week-mobile.png"),
    fullPage: true,
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await viewSelector.getByRole("button", { name: "Table", exact: true }).click();
  await mobileMenu.click();
  const mobileNavigation = page.getByRole("dialog", { name: "Workspace navigation", exact: true });
  await mobileNavigation.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("channels-mobile.png"),
    fullPage: true,
  });
  await mobileMenu.click();
  await page
    .getByRole("dialog", { name: "Workspace navigation", exact: true })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("settings-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(security.getByLabel("Current password", { exact: true })).toBeVisible();
  await expect(security.getByLabel("New password", { exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("settings-security-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await accountTrigger.click();
  await accountMenu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);

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
          animations: "disabled",
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
