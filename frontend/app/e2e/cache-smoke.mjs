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

/** Observes retained capabilities across real SPA navigation, focus/reconnect and a fresh document in both palettes/sizes. */
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
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/platforms/capabilities") reads++;
    });
    await page.goto(`${origin}/posts`);
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
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
    await page.reload();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    await context.close();
  } finally {
    await browser.close();
  }
}
