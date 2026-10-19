import { expect, test, type Locator, type Page } from "@playwright/test";

import { ownerCredentials, signIn, openOwnerWorkspace } from "./workspace-session";

test.use({ screenshot: "off", trace: "off" });
test.setTimeout(90_000);

test("signs the owner out and back in through the Better Auth forms", async ({ page }) => {
  const credentials = ownerCredentials();

  await openOwnerWorkspace(page, credentials);
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("main")).toBeVisible();

  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menu", { name: "Account menu", exact: true })
    .getByRole("menuitem", { name: "Sign out", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });

  await signIn(page, credentials);
  await expect(page).toHaveURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("main")).toBeVisible();
});

/**
 * Resolves the theme tokens this regression guards with a temporary inline-style
 * probe, removed after reading the browser's computed colors. Assertions track
 * the palette rather than pinning pixel geometry or browser color serialization.
 *
 * @param page - Playwright page already showing the app shell.
 */
async function themeTokens(page: Page): Promise<{
  strongInk: string;
  mutedInk: string;
  surfaceFill: string;
  primaryFill: string;
}> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (property: string, value: string) => {
      probe.style.setProperty(property, value);
      return getComputedStyle(probe).getPropertyValue(property);
    };
    try {
      return {
        strongInk: read("color", "var(--ink)"),
        mutedInk: read("color", "var(--ink-3)"),
        surfaceFill: read("background-color", "var(--surface)"),
        primaryFill: read("background-color", "var(--primary)"),
      };
    } finally {
      probe.remove();
    }
  });
}

/**
 * Collects the opaque backgrounds painted inside a control's subtree. An
 * inactive view-mode button must paint nothing: the "no fill" half of the
 * muted treatment, which also catches a `bg-primary`/pill leak that a
 * text-color-only check would miss. Callers wrap this in `expect.poll`
 * because the active-mode pill still animates in on the click frame.
 *
 * @param control - Root element whose subtree is scanned (itself included).
 */
async function opaqueFills(control: Locator): Promise<string[]> {
  return control.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .map((element) => getComputedStyle(element).backgroundColor)
      .filter((color) => color !== "rgba(0, 0, 0, 0)" && color !== "transparent"),
  );
}

/**
 * Asserts the resting "inactive" chrome shared by view-mode buttons and the
 * density stepper's utility buttons: transparent background with muted
 * (`--ink-3`) ink, and no opaque fill anywhere in the subtree.
 *
 * @param control - Inactive button to inspect.
 * @param mutedInk - Resolved `--ink-3` color from {@link themeTokens}.
 */
async function expectInactiveChrome(control: Locator, mutedInk: string) {
  await expect(control).toHaveCSS("color", mutedInk);
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(() => opaqueFills(control)).toEqual([]);
}

/**
 * Keeps inactive posts view modes muted in dark mode, checking the rendered
 * chrome rather than a pixel baseline so font/geometry drift in the browser
 * build cannot mask or fake the contract.
 *
 * Grid mode is activated first so the column-density stepper renders inside
 * the same control; List and Calendar buttons plus the stepper's utility
 * buttons must keep muted ink and no fill, while the active Grid button earns
 * the strong ink and its `bg-surface` pill. A `default` Button variant leaking
 * into an inactive or utility control flips the primary fill onto it and
 * fails {@link expectInactiveChrome}.
 * Sampling occurs with the pointer away from the controls, so the resting-state
 * contract is not confused with a legitimate hover fill after activation.
 */
test("keeps inactive posts view modes muted in dark mode", async ({ page }) => {
  await openOwnerWorkspace(page, ownerCredentials());
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.getByTitle("Grid View").click();
  await page.mouse.move(0, 0);

  const tokens = await themeTokens(page);
  // Token sanity: the assertions below only discriminate when the muted ink,
  // the strong ink, and the primary fill genuinely differ under the dark theme.
  expect(tokens.mutedInk).not.toBe(tokens.strongInk);
  expect(tokens.primaryFill).not.toBe("rgba(0, 0, 0, 0)");

  for (const title of ["List View", "Calendar View"] as const) {
    await expectInactiveChrome(page.getByTitle(title), tokens.mutedInk);
  }
  for (const title of ["Decrease grid columns", "Increase grid columns"] as const) {
    await expectInactiveChrome(page.getByTitle(title), tokens.mutedInk);
  }

  // The active mode keeps the visible contrast the inactive ones lack: strong
  // ink, still transparent itself, and exactly one opaque fill — the pill.
  const active = page.getByTitle("Grid View");
  await expect(active).toHaveCSS("color", tokens.strongInk);
  await expect(active).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(() => opaqueFills(active)).toEqual([tokens.surfaceFill]);
});
