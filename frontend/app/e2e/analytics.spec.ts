import { expect, test } from "@playwright/test";

import { seedAnalyticsCohort } from "./analytics-fixtures";
import {
  activeBrandProfileName,
  controlledProviderAccountId,
  provisionControlledChannels,
} from "./publication-fixtures";
import { openIsolatedOwnerWorkspace } from "./workspace-session";

/**
 * Real-stack Analytics journey.
 *
 * Runs in the controlled-Provider acceptance project: the API advertises real
 * Instagram/Threads analytics capabilities there, and the fixture provisions
 * connected Channels. Stored snapshots are seeded directly because the feature
 * is read-only over sync output and the controlled Provider does not fetch
 * engagement counters.
 */
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

  // The Analytics route and its chart bundle are lazy: no loaded script on the
  // Posts surface may contain the comparison card or Recharts implementation.
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

  // KPI totals count cumulative snapshots at the range end. The launch Post
  // contributes Instagram + Threads + one unsupported TikTok destination.
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page.getByLabel("Published destinations: 14")).toBeVisible();
  await expect(
    page.getByText("Partial data: no analytics are available for TikTok."),
  ).toBeVisible();
  await expect(page.getByText(/Metrics are cumulative snapshots/)).toBeVisible();

  // The chart exposes the same values as a table and omits unsupported TikTok.
  const chartTable = page.locator("div.sr-only table").filter({ hasText: "Total engagement" });
  await expect(chartTable).toContainText("Instagram");
  await expect(chartTable).toContainText("3,820");
  await expect(chartTable).toContainText("Threads");
  await expect(chartTable).not.toContainText("TikTok");

  // Default ranking is views descending. Ten rows load; Load more reaches the
  // unsupported and not-yet-synced destinations that rank below them.
  const table = page.locator("div.hidden.lg\\:block table");
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(table.locator("tbody tr").first()).toContainText("Analytics E2E older");
  await expect(table.getByText("Partial")).toBeVisible();
  await expect(table.getByText("Not supported")).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(12);
  await expect(table.getByText("Not supported")).toHaveCount(4);
  await expect(table.getByText("Awaiting sync", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Metric headers re-rank. Shares tie between the launch and older Posts, and
  // the tie-break prefers the newer publication.
  await table.getByRole("button", { name: "Sort by Shares" }).click();
  await expect(page).toHaveURL(/metric=shares/);
  await expect(table.locator("tbody tr").first()).toContainText("Analytics E2E launch");

  // The compact filter builder owns range, platform, account, and format.
  const filterSummary = page.getByRole("toolbar").locator("summary");
  const ensureFiltersOpen = async () => {
    if (!(await page.getByRole("group", { name: "Filters" }).isVisible())) {
      await filterSummary.click();
    }
  };

  // Range changes are shareable and back returns to the previous view.
  await ensureFiltersOpen();
  await page.getByRole("button", { name: "Add Range filter" }).click();
  await page.getByRole("combobox", { name: "Range" }).click();
  await page.getByRole("option", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.getByLabel("Views: 3,180")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page).toHaveURL(/range=30d/);

  // One-platform filtering narrows KPIs, chart, and ranking.
  await ensureFiltersOpen();
  await page.getByRole("button", { name: "Add Platform filter" }).click();
  await page.getByRole("combobox", { name: "Platform" }).click();
  await page.getByRole("option", { name: "Threads" }).click();
  await expect(page).toHaveURL(/platform=threads/);
  await expect(page.getByLabel("Views: 200")).toBeVisible();
  await expect(page.getByLabel("Published destinations: 1")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  // One platform is the whole cohort: the comparison card would be a single
  // bar against empty space, so the page omits it.
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeHidden();
  await page.goBack();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeVisible();

  // Close the filter builder before the remaining toolbar checks and screenshots.
  if (await page.getByRole("group", { name: "Filters" }).isVisible()) {
    await filterSummary.click();
  }

  // Refresh re-reads stored metrics; it never implies a provider sync.
  await page.getByRole("button", { name: "Refresh analytics" }).click();
  await expect(page.getByText(/Last synced/)).toBeVisible();

  // Every ranking control is keyboard operable.
  await table.getByRole("button", { name: "Sort by Views" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/metric=views/);

  // Both palettes keep the chart and table legible. The before-paint bootstrap
  // prefers the shared theme cookie, so set the same explicit choice there.
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

  // Reduced-motion preference must not break the page or its chart.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await activeBrandProfileName(page);
  await expect(page.getByRole("heading", { name: "Engagement by platform" })).toBeVisible();
  await expect(page.getByLabel("Views: 4,080")).toBeVisible();

  // Phones keep the stacked rows and never force page-level horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await activeBrandProfileName(page);
  await expect(page.getByRole("heading", { name: "Top posts" })).toBeVisible();
  await expect(page.getByText("Analytics E2E older").last()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("analytics-phone.png"),
  });
});
