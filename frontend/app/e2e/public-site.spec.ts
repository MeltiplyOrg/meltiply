import { expect, test, type Page } from "@playwright/test";

/**
 * Release-readiness verification for the separate public Astro project.
 *
 * These journeys use the static production preview documented in the
 * `frontend-ui` lane (`MELTIPLY_E2E_PUBLIC_URL`). They prove the landing page's
 * interactive sample stays visibly illustrative and cannot persist, that the
 * guides and their build-time search navigate, and that theme, keyboard, mobile,
 * and reduced-motion behavior match the workspace contract. The app owns the
 * actual publishing journeys; this file never claims the sample publishes.
 */

const publicUrl = process.env.MELTIPLY_E2E_PUBLIC_URL?.trim();

/** Consent is the only way the public site persists the theme; grant it before boot. */
async function allowFunctionalConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const consent = encodeURIComponent(
      JSON.stringify({
        expires: Date.now() + 180 * 24 * 60 * 60 * 1_000,
        functional: true,
        v: 1,
      }),
    );
    document.cookie = `meltiply-consent=${consent}; Path=/; Max-Age=15552000; SameSite=Lax`;
  });
}

/** Joins the public preview origin for a route without assuming a trailing slash. */
function publicPath(baseUrl: string, pathname: string): string {
  return new URL(pathname, baseUrl).href;
}

test.describe("public site verification", () => {
  test.skip(!publicUrl, "MELTIPLY_E2E_PUBLIC_URL is required for the public-site journeys");

  test.beforeEach(async ({ page }) => {
    await allowFunctionalConsent(page);
  });

  test("keeps landing navigation, samples, and phone disclosure honest", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const origin = publicUrl!;

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(publicPath(origin, "/"));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Finally, in sync.");

    // The skip link is first in keyboard order and targets the real main region.
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to content", exact: true });
    await expect(skipLink).toBeFocused();
    await skipLink.press("Enter");
    await expect(page.locator("#main")).toBeVisible();

    // Marketing navigation reaches the sections it advertises.
    for (const section of ["product", "features", "workflow"]) {
      await page.locator(`a[href="#${section}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(`#${section}$`));
      await expect(page.locator(`#${section}`)).toBeInViewport();
    }

    // The sample is labeled twice: as sample content and as an illustrative workflow.
    await expect(page.getByText("Interactive demo · sample content")).toBeVisible();
    await expect(page.getByText("Illustrative workflow").first()).toBeVisible();
    await expect(page.getByTitle("Demo connection").first()).toBeVisible();
    await expect(page.getByText("Demo account", { exact: true })).toBeVisible();

    // Demo tabs are keyboard-complete and lazily hidden, never unmounted.
    const postsTab = page.getByRole("tab", { name: "Posts", exact: true });
    const channelsTab = page.getByRole("tab", { name: "Channels", exact: true });
    const postsPanel = page.getByRole("tabpanel", { name: "Posts", exact: true });
    const channelsPanel = page.getByRole("tabpanel", { name: "Channels", exact: true });
    await expect(postsTab).toHaveAttribute("aria-selected", "true");
    await expect(postsPanel).toBeVisible();
    await channelsTab.click();
    await expect(channelsTab).toHaveAttribute("aria-selected", "true");
    await expect(channelsPanel).toBeVisible();
    await expect(postsPanel).toBeHidden();
    await page.keyboard.press("ArrowLeft");
    await expect(postsTab).toBeFocused();
    await expect(postsTab).toHaveAttribute("aria-selected", "true");
    await expect(postsPanel).toBeVisible();

    // The sample's only actions open the real app at sign-in; it has no API or form.
    const sampleActions = page.locator(".preview-main a.button");
    expect(await sampleActions.count()).toBeGreaterThan(0);
    for (const href of await sampleActions.evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).href),
    )) {
      const url = new URL(href);
      expect(url.origin).not.toBe(new URL(origin).origin);
      expect(url.pathname).toBe("/sign-in");
    }
    expect(await page.locator(".preview-main form, .preview-main input").count()).toBe(0);

    // Theme intent survives reload, and the capture-phase transfer adds the live
    // choice when the sample's action actually navigates toward the app.
    const toDark = page.getByRole("button", { name: "Switch to dark theme", exact: true });
    await toDark.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(
      page.getByRole("button", { name: "Switch to light theme", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const transferredHref = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLAnchorElement>(".preview-main a.button");
      if (!anchor) return null;
      let href = "";
      anchor.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          href = anchor.href;
        },
        { once: true },
      );
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return href;
    });
    expect(new URL(transferredHref!).searchParams.get("meltiply-theme")).toBe("dark");
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath("public-landing-dark-1440.png"),
    });

    // Phones keep the same sample, a keyboard-operable disclosure, and no overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const menu = page.locator(".menu-toggle");
    await expect(menu).toHaveAttribute("aria-label", "Open navigation");
    await menu.click();
    const mobileNav = page.getByRole("navigation", { name: "Mobile navigation", exact: true });
    await expect(mobileNav).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("aria-label", "Close navigation");
    await page.keyboard.press("Escape");
    await expect(mobileNav).toBeHidden();
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveAttribute("aria-label", "Open navigation");
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath("public-landing-dark-390.png"),
    });
  });

  test("navigates guides and the build-time search across themes", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const origin = publicUrl!;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(publicPath(origin, "/"));
    await page
      .getByRole("navigation", { name: "Footer navigation" })
      .getByRole("link", {
        name: "Docs",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/docs\/?$/);
    await expect(page.getByRole("heading", { level: 1, name: "Meltiply Docs" })).toBeVisible();

    // The shared sidebar lists the approved guides and marks the current one.
    const channelsLink = page.locator("a.docs-nav-item", { hasText: "Channels" }).first();
    await expect(channelsLink).toBeVisible();
    await channelsLink.click();
    await expect(page).toHaveURL(/\/docs\/channels\/?$/);
    await expect(page.getByRole("heading", { level: 1, name: "Channels" })).toBeVisible();
    await expect(channelsLink).toHaveAttribute("aria-current", "page");

    // The build-time index is the documented public search, reachable by keyboard.
    const searchTrigger = page.getByRole("button", { name: "Search documentation", exact: true });
    await searchTrigger.focus();
    await searchTrigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Search", exact: true }).fill("resource limits");
    const result = dialog.getByRole("option", { name: /^Docs\s+Resource usage$/ }).first();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.click();
    await expect(page).toHaveURL(/\/docs\/resource-limits(?:\/|#|$)/);
    await expect(page.getByRole("heading", { level: 1, name: "Resource usage" })).toBeVisible();

    // Search dismissal restores the trigger after a same-origin swap.
    await searchTrigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(searchTrigger).toBeFocused();

    // The article's Markdown alternate and agent index are real resources.
    const markdownHref = await page.locator(".docs-agent-metadata a").last().getAttribute("href");
    expect(markdownHref).toMatch(/^\/docs\/resource-limits\.md$/);
    const markdown = await page.request.get(publicPath(origin, markdownHref!));
    expect(markdown.status()).toBe(200);
    expect(await markdown.text()).toContain("# Resource usage");
    const index = await page.request.get(publicPath(origin, "/llms.txt"));
    expect(index.status()).toBe(200);
    await expect(index.text()).resolves.toContain("/docs/resource-limits.md");

    // Theme choice crosses the persistent docs/landing boundary and survives there.
    const toggle = page
      .locator(".docs-prefs")
      .getByRole("button", { name: /Switch to dark theme/ });
    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("link", { name: "Meltiply.com", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${new URL(origin).origin}/?$`));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath("public-docs-dark-1440.png"),
    });

    // Unknown guide paths keep the public 404 and its way back.
    await page.goto(publicPath(origin, "/docs/not-a-guide"));
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await page.getByRole("link", { name: "Back to docs", exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/?$/);

    // Guide reading stays inside the phone viewport in the dark palette.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(publicPath(origin, "/docs/channels"));
    await expect(page.getByRole("heading", { level: 1, name: "Channels" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath("public-docs-dark-390.png"),
    });
  });

  test("honors native reduced motion for the interactive sample", async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(publicPath(publicUrl!, "/"));
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    const channelsTab = page.getByRole("tab", { name: "Channels", exact: true });
    await channelsTab.click();
    const channelsPanel = page.getByRole("tabpanel", { name: "Channels", exact: true });
    await expect(channelsPanel).toBeVisible();
    // The shared effect owner returns before creating WAAPI animations under
    // native reduced motion; the panel's content therefore commits immediately.
    await expect
      .poll(() =>
        channelsPanel.evaluate(
          (panel) =>
            panel.getAnimations().length === 0 &&
            (panel.parentElement?.getAnimations().length ?? 0) === 0,
        ),
      )
      .toBe(true);
  });
});
