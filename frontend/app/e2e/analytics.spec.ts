import { expect, test } from "@playwright/test";

import { seedAnalyticsCohort } from "./analytics-fixtures";
import {
  activeBrandProfileName,
  controlledProviderAccountId,
  provisionControlledChannels,
} from "./publication-fixtures";
import { openIsolatedOwnerWorkspace } from "./workspace-session";

test("keeps analytics honest across scope, range, platform, and ranking changes", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workspace = await openIsolatedOwnerWorkspace(page);
  await provisionControlledChannels(request, workspace.profileName, [
    {
      platform: "instagram",
      displayName: "Analytics Instagram",
      providerUserId: controlledProviderAccountId("instagram"),
    },
    {
      platform: "threads",
      displayName: "Analytics Threads",
      providerUserId: controlledProviderAccountId("threads"),
    },
  ]);
  await seedAnalyticsCohort(workspace.profileName);

  const analyticsChunk = await page.evaluate(async () => {
    const scripts = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.endsWith(".js"));
    for (const url of scripts) {
      const text = await fetch(url).then((response) => response.text());
      if (text.includes("recharts")) return url;
    }
    return null;
  });
  expect(analyticsChunk, "Posts must not download the Analytics chart chunk").toBeNull();

  const sidebar = page.locator("aside nav");
  await sidebar.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(page).toHaveURL(/\/analytics(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText(`${workspace.profileName} · Performance`)).toBeVisible();

  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page.getByLabel("Published destinations: 14")).toBeVisible();
  await expect(page.getByText(/Metrics are cumulative snapshots/)).toBeVisible();

  const chartTable = page.locator("div.sr-only table").filter({ hasText: "Total engagement" });
  await expect(chartTable).toContainText("Instagram");
  await expect(chartTable).toContainText("3,820");
  await expect(chartTable).toContainText("Threads");
  await expect(chartTable.getByRole("row", { name: /TikTok/ })).toContainText("60");

  const table = page.locator("div.hidden.lg\\:block table");
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(table.locator("tbody tr").first()).toContainText("Analytics E2E older");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(12);
  const tiktokOnly = table.getByRole("row", { name: /Analytics E2E TikTok only/ });
  await expect(tiktokOnly).toContainText("50");
  await expect(table.getByText("Not supported")).toHaveCount(0);
  await expect(table.getByText("Awaiting sync", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await table.getByRole("button", { name: "Sort by Shares" }).click();
  await expect(page).toHaveURL(/metric=shares/);
  await expect(table.locator("tbody tr").first()).toContainText("Analytics E2E launch");

  const filterSummary = page.getByRole("toolbar").locator("summary");
  const ensureFiltersOpen = async () => {
    if (!(await page.getByRole("group", { name: "Filters" }).isVisible())) {
      await filterSummary.click();
    }
  };

  await ensureFiltersOpen();
  await page.getByRole("button", { name: "Add Range filter" }).click();
  await page.getByRole("combobox", { name: "Range" }).click();
  await page.getByRole("option", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.getByLabel("Views: 3,180")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page).toHaveURL(/range=30d/);

  await ensureFiltersOpen();
  await page.getByRole("button", { name: "Add Platform filter" }).click();
  await page.getByRole("combobox", { name: "Platform" }).click();
  await page.getByRole("option", { name: "Threads" }).click();
  await expect(page).toHaveURL(/platform=threads/);
  await expect(page.getByLabel("Views: 200")).toBeVisible();
  await expect(page.getByLabel("Published destinations: 1")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeHidden();
  await page.goBack();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeVisible();

  if (await page.getByRole("group", { name: "Filters" }).isVisible()) {
    await filterSummary.click();
  }

  await page.getByRole("button", { name: "Refresh analytics" }).click();
  await expect(page.getByText(/Last synced/)).toBeVisible();

  await table.getByRole("button", { name: "Sort by Views" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/metric=views/);

  await page.evaluate(() => {
    localStorage.setItem("meltiply.theme", "light");
    document.cookie = "meltiply-theme=light; Path=/; Max-Age=31536000; SameSite=Lax";
  });
  await page.reload();
  await activeBrandProfileName(page, workspace.profileName);
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("analytics-light.png"),
  });
  await page.evaluate(() => {
    localStorage.setItem("meltiply.theme", "dark");
    document.cookie = "meltiply-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax";
  });
  await page.reload();
  await activeBrandProfileName(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("analytics-dark.png"),
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await activeBrandProfileName(page);
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeVisible();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await activeBrandProfileName(page);
  await expect(page.getByRole("heading", { name: "Top posts" })).toBeVisible();
  await expect(page.getByText("Analytics E2E older").last()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const heatmap = page.locator("[data-best-time-heatmap]");
  await expect(heatmap).toBeVisible();
  await expect
    .poll(() => heatmap.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("analytics-phone.png"),
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await expect
    .poll(() => heatmap.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  const narrowOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(narrowOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("analytics-phone-320.png"),
  });
});
