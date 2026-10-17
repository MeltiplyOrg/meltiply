import { expect, test, type Page } from "@playwright/test";

import { animatedGifFixture, attachmentTitle, pngFixture } from "./media-fixtures";
import {
  ownerCredentials,
  openOwnerWorkspace,
  openIsolatedOwnerWorkspace,
  waitForWorkspace,
} from "./workspace-session";

test.use({ screenshot: "off", trace: "off" });
test.setTimeout(90_000);

/**
 * Finds an attachment's lifecycle strip across filename → persisted-title
 * normalization, mirroring the composer spec's convention: `hasText` on the
 * persisted title matches both the raw filename shown during "Preparing" and
 * the extensionless title rendered once the attachment row persists, so the
 * same locator survives the transition. Position and phase remain the
 * consumer-visible assertions; extension presentation is deliberately not
 * pinned.
 *
 * @param page - Playwright page bound to the app under test.
 * @param fileName - Attachment file name to scope to.
 */
function attachmentStrip(page: Page, fileName: string) {
  return page.getByRole("status").filter({ hasText: attachmentTitle(fileName) });
}

/**
 * Exercises the signed-in display preference at the navigation shell: a manual choice
 * must survive Posts → Channels navigation, sidebar collapse, reload and the mobile
 * layout without changing the independently selected theme. The button's accessible
 * state is the contract; the OS preference must still win when manual mode is off.
 */
test("keeps low motion across workspace navigation and honors the device preference", async ({
  page,
}) => {
  await openOwnerWorkspace(page, ownerCredentials());
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await waitForWorkspace(page);

  const lowMotion = page.getByRole("button", { name: "Low motion" });
  await expect(lowMotion).toHaveAttribute("aria-pressed", "false");

  // Keyboard navigation & activation (Story 8): focus and toggle via Space
  await lowMotion.focus();
  await expect(lowMotion).toBeFocused();
  await page.keyboard.press("Space");
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");

  // Theme independence (Story 15): reducing motion leaves theme switching intact
  const themeButton = page.getByRole("button", { name: /switch to (dark|light) mode/i });
  await themeButton.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");
  await themeButton.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(page).toHaveURL(/\/channels(?:\?|$)/);
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");
  // Collapsing must drop the control from every interaction channel immediately,
  // even while its exit animation is still fading: it stays mounted but inert.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(lowMotion).toHaveCount(0);
  const collapsedLowMotion = page.locator('button[aria-label="Low motion"]');
  await expect(collapsedLowMotion).toBeAttached();
  await expect(collapsedLowMotion).toHaveAttribute("inert", "");
  await expect(collapsedLowMotion).toHaveAttribute("aria-hidden", "true");
  await expect(collapsedLowMotion).toHaveAttribute("tabindex", "-1");

  // Keyboard: Tab from the theme control skips the hidden button entirely.
  await themeButton.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeFocused();

  // Pointer: a click landing on the control's former spot passes through to the
  // surface beneath and must not flip the preference.
  await collapsedLowMotion.click({ position: { x: 2, y: 14 }, force: true });
  await expect(collapsedLowMotion).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");

  // Quick search label must be at its resting geometry under low motion: the
  // first observed box after expansion is already final, so an identical box
  // two frames later proves no travel happened — an observable-position check,
  // not a Motion/CSS implementation detail.
  const searchLabel = page.locator("aside").getByText("Search", { exact: true });
  await expect(searchLabel).toBeVisible();
  const searchLabelBox = await searchLabel.boundingBox();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(await searchLabel.boundingBox()).toEqual(searchLabelBox);

  await page.reload();
  // Reload re-hydrates the whole app on whichever route was active (/channels
  // here), so the Posts heading is wrong: the sidebar control itself is the
  // route-agnostic signal that the shell chunk finished loading.
  await expect(lowMotion).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lowMotion).not.toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await lowMotion.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "false");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(lowMotion).toHaveAttribute("aria-pressed", "false");
  await expect(lowMotion).toHaveAttribute("title", /device.*reduced motion/i);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(lowMotion).not.toHaveAttribute("title", /device.*reduced motion/i);
});

/**
 * Guards the unsaved-draft contract: toggling Low motion on and off must never
 * remount the Posts view wrapper, so text typed into the composer survives both
 * directions of the preference switch. Uses the real signed-in shell — no
 * backend mocking — and asserts the textarea's live value, the user-visible
 * draft state.
 */
test("keeps an unsaved composer draft when toggling low motion on and off", async ({ page }) => {
  await openOwnerWorkspace(page, ownerCredentials());
  await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await waitForWorkspace(page);

  await page.getByRole("button", { name: "Create post" }).click();
  const composer = page.getByPlaceholder(/what do you want to publish/i);
  await expect(composer).toBeVisible();
  await composer.fill("Draft kept across low-motion toggles");

  const lowMotion = page.getByRole("button", { name: "Low motion" });
  await lowMotion.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");
  await expect(composer).toHaveValue("Draft kept across low-motion toggles");

  await lowMotion.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "false");
  await expect(composer).toHaveValue("Draft kept across low-motion toggles");
});

/**
 * Guards the cutover's accessibility promise for composer-owned media under Low
 * motion: reducing motion must not remove or reorder attachments, and the honest
 * progress and saved feedback must still reach the creator. Runs the real upload
 * and native processing against the real stack — no mocked phases — and asserts
 * only the user-visible strip and saved-status copy.
 */
test("keeps composer media and its feedback working under low motion", async ({ page }) => {
  // Real signed uploads plus native processing run inside this case, so it needs
  // more headroom than the shell-only checks above it.
  test.setTimeout(240_000);
  await openIsolatedOwnerWorkspace(page);

  await page.getByRole("button", { name: "Create post" }).click();
  const composer = page.getByPlaceholder(/what do you want to publish/i);
  await expect(composer).toBeVisible();
  const caption = "Low motion media journey";
  await composer.fill(caption);

  const lowMotion = page.getByRole("button", { name: "Low motion" });
  await lowMotion.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "true");

  const png = pngFixture();
  const gif = animatedGifFixture();
  await page.locator('input[type="file"]').setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);

  // Strips show the raw filename briefly while "Preparing", then the persisted
  // extensionless title once the attachment row exists; `attachmentStrip` keeps
  // the same locator addressable across that normalization.
  const pngStrip = attachmentStrip(page, png.name);
  await expect(pngStrip).toContainText("Ready", { timeout: 180_000 });
  const gifStrip = attachmentStrip(page, gif.name);
  await expect(gifStrip).toContainText("Ready", { timeout: 180_000 });

  // Reorder and save: the creator's arrangement and the saved signal are
  // unaffected by the accessibility preference.
  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await expect(page.getByText(/Saved to your workspace at/i)).toBeVisible({ timeout: 60_000 });

  // Toggling the preference off must not disturb the saved composition.
  await lowMotion.click();
  await expect(lowMotion).toHaveAttribute("aria-pressed", "false");
  await expect(composer).toHaveValue(caption);
  await expect(attachmentStrip(page, gif.name)).toContainText("1. ");
  await expect(attachmentStrip(page, png.name)).toContainText("2. ");
});
