import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

/** Signs the seeded local Installation Owner in through the real form; returns only cookies and suppresses sensitive form errors. */
export async function managedOwnerCookie(origin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel("Email address", { exact: true }).fill("alpha@meltiply.local");
    await page.getByLabel("Password", { exact: true }).fill("MeltiplyLocal1!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/posts/, { timeout: 30_000 });
    return (await context.cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  } catch {
    throw new Error("Managed-runtime owner sign-in failed; sensitive form details suppressed");
  } finally {
    await browser.close();
  }
}

/** Observes warm private reads, shared Analytics cohorts and explicit Refresh through real SPA controls in both palettes/sizes. */
export async function capabilityNavigation({ origin, cookie, label }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(
      cookie.split("; ").map((pair) => {
        const split = pair.indexOf("=");
        return { name: pair.slice(0, split), value: pair.slice(split + 1), url: origin };
      }),
    );
    const page = await context.newPage();
    let reads = 0;
    let channelReads = 0;
    let profileReads = 0;
    const analyticsReads = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/platforms/capabilities") reads++;
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/platforms") channelReads++;
      if (url.pathname === "/api/v1/brand-profiles" && !url.searchParams.has("deleted"))
        profileReads++;
      if (["/api/v1/analytics/dashboard", "/api/v1/analytics/posts"].includes(url.pathname))
        analyticsReads.push(url);
    });
    await page.goto(`${origin}/posts`);
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    await expect.poll(() => analyticsReads.length).toBe(2);
    assert.equal(
      analyticsReads[0].searchParams.get("start"),
      analyticsReads[1].searchParams.get("start"),
    );
    assert.equal(
      analyticsReads[0].searchParams.get("end"),
      analyticsReads[1].searchParams.get("end"),
    );
    const warmChannels = channelReads;
    const warmProfiles = profileReads;
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await page.evaluate(() => {
      globalThis.dispatchEvent(new Event("focus"));
      globalThis.dispatchEvent(new Event("online"));
    });
    for (const dark of [false, true]) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(
          (enabled) => globalThis.document.documentElement.classList.toggle("dark", enabled),
          dark,
        );
        await page.screenshot({
          path: `artifacts/cache/${label}-${dark ? "dark" : "light"}-${width}.png`,
          fullPage: true,
        });
      }
    }
    assert.equal(reads, 1, "SPA navigation/focus/reconnect must retain successful capabilities");
    assert.equal(channelReads, warmChannels, "Warm navigation/focus must not reload Channels");
    assert.equal(
      profileReads,
      warmProfiles,
      "Warm navigation/focus must not reload Brand Profiles",
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh analytics", exact: true });
    await expect(refresh).toBeEnabled();
    assert.equal(analyticsReads.length, 2, "Warm Analytics navigation must reuse both projections");
    for (const dark of [false, true]) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(
          (enabled) => document.documentElement.classList.toggle("dark", enabled),
          dark,
        );
        const previous = analyticsReads.at(-1).searchParams.get("end");
        const expected = analyticsReads.length + 2;
        await refresh.click();
        await expect.poll(() => analyticsReads.length).toBe(expected);
        await expect(refresh).toBeEnabled();
        const [dashboard, ranked] = analyticsReads.slice(-2);
        assert.equal(dashboard.searchParams.get("start"), ranked.searchParams.get("start"));
        assert.equal(dashboard.searchParams.get("end"), ranked.searchParams.get("end"));
        assert.notEqual(
          dashboard.searchParams.get("end"),
          previous,
          "Refresh must advance the shared cohort",
        );
        await page.screenshot({
          path: `artifacts/cache/${label}-analytics-${dark ? "dark" : "light"}-${width}.png`,
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    console.log(
      JSON.stringify({
        scenario: "browser-private-cache",
        label,
        warm_channel_reads: warmChannels,
        warm_profile_reads: warmProfiles,
        warm_analytics_reads: 2,
        explicit_refreshes: 4,
        palettes: ["light", "dark"],
        widths: [1280, 390],
      }),
    );
    await context.close();
  } finally {
    await browser.close();
  }
}
