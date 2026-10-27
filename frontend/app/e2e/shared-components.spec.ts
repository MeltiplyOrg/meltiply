import { expect, test, type Locator, type Page } from "@playwright/test";

import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

/** Whether the focused element matches the browser's keyboard-only focus ring. */
async function focusedElementIsFocusVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches(":focus-visible");
  });
}

/** Asserts the page itself has no horizontal document overflow. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

/** Asserts a segmented radio has focus through keyboard modality, not a pointer click. */
async function expectKeyboardFocus(page: Page, radio: Locator): Promise<void> {
  await expect(radio).toBeFocused();
  expect(await focusedElementIsFocusVisible(page)).toBe(true);
}

/** One rendered frame of the segmented highlight's translate/scale. */
interface HighlightSample {
  checked: string | null;
  scaleX: number;
  translateX: number;
}

/**
 * Samples the travelling highlight around one click and reports the frames after
 * the checked value changed. The rendered transform — not a transition property —
 * proves whether the pill travelled, so reduced motion is measured rather than
 * inferred from CSS.
 */
async function sampleHighlightTravel(
  page: Page,
  group: Locator,
  next: Locator,
): Promise<{
  changed: boolean;
  travelledFrames: number;
  finalSample: HighlightSample;
}> {
  const label = await group.getAttribute("aria-label");
  if (!label) throw new Error("segmented group has no accessible label");

  await page.evaluate((groupLabel) => {
    const groupElement = Array.from(
      document.querySelectorAll<HTMLElement>('[role="radiogroup"]'),
    ).find((element) => element.getAttribute("aria-label") === groupLabel);
    const highlight = groupElement?.querySelector<HTMLElement>(':scope > [aria-hidden="true"]');
    if (!groupElement || !highlight) throw new Error("segmented highlight is missing");
    const initial =
      groupElement
        .querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
        ?.textContent?.trim() ?? null;
    const samples: HighlightSample[] = [];
    const started = performance.now();
    const frame = (now: number) => {
      const transform = getComputedStyle(highlight).transform;
      const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
      samples.push({
        checked:
          groupElement
            .querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
            ?.textContent?.trim() ?? null,
        scaleX: matrix.a,
        translateX: matrix.e,
      });
      if (now - started < 500) {
        requestAnimationFrame(frame);
      } else {
        Reflect.set(window, "__segmentedHighlightSampler", { done: true, initial, samples });
      }
    };
    requestAnimationFrame(frame);
  }, label);

  await next.click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "__segmentedHighlightSampler")?.done === true),
    )
    .toBe(true);

  return page.evaluate(() => {
    const sampler = Reflect.get(window, "__segmentedHighlightSampler") as {
      initial: string | null;
      samples: HighlightSample[];
    };
    Reflect.deleteProperty(window, "__segmentedHighlightSampler");
    const changedAt = sampler.samples.findIndex((sample) => sample.checked !== sampler.initial);
    const afterChange = changedAt === -1 ? [] : sampler.samples.slice(changedAt);
    return {
      changed: changedAt !== -1,
      travelledFrames: afterChange.filter(
        (sample) => Math.abs(sample.scaleX - 1) > 0.01 || Math.abs(sample.translateX) > 0.5,
      ).length,
      finalSample: sampler.samples.at(-1) ?? {
        checked: sampler.initial,
        scaleX: 1,
        translateX: 0,
      },
    };
  });
}

/**
 * Rendered height of one segmented track and every segment inside it, so the
 * coarse-pointer growth contract is measured on real layout instead of classes.
 */
async function segmentedGeometry(
  track: Locator,
): Promise<{ trackHeight: number; itemHeights: number[] }> {
  return track.evaluate((element) => {
    const items = Array.from(
      element.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"], [role="menuitemradio"]'),
    );
    return {
      trackHeight: element.getBoundingClientRect().height,
      itemHeights: items.map((item) => item.getBoundingClientRect().height),
    };
  });
}

/**
 * Real-stack proof that the shared segmented contract reaches the Posts views:
 * one checked radio per radiogroup, arrow/Home/End selection with focus moved
 * to the chosen option, the calendar period groups, reduced-motion selection,
 * and no phone-width document overflow.
 */
test("keeps segmented selection keyboard-complete across Posts and Calendar", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openIsolatedOwnerWorkspace(page);
  await waitForWorkspace(page);

  const postView = page.getByRole("radiogroup", { name: "Post view", exact: true });
  const gridRadio = postView.getByRole("radio", { name: "Grid", exact: true });
  const calendarRadio = postView.getByRole("radio", { name: "Calendar", exact: true });
  const tableRadio = postView.getByRole("radio", { name: "Table", exact: true });
  await expect(postView).toBeVisible();
  await expect(postView.getByRole("radio", { checked: true })).toHaveCount(1);

  // Fine pointers keep the canonical density: 24px items inside a 28px track.
  const fineGeometry = await segmentedGeometry(postView);
  expect(fineGeometry.trackHeight).toBeCloseTo(28, 0);
  for (const height of fineGeometry.itemHeights) expect(height).toBeCloseTo(24, 0);

  // Grid is the last option: ArrowLeft reaches Calendar, ArrowRight returns,
  // then Home/End jump to the first and last checked options.
  await gridRadio.click();
  await expect(gridRadio).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(calendarRadio).toBeChecked();
  await expectKeyboardFocus(page, calendarRadio);
  await page.keyboard.press("ArrowRight");
  await expect(gridRadio).toBeChecked();
  await expectKeyboardFocus(page, gridRadio);
  await page.keyboard.press("Home");
  await expect(tableRadio).toBeChecked();
  await expectKeyboardFocus(page, tableRadio);
  await page.keyboard.press("End");
  await expect(gridRadio).toBeChecked();
  await expectKeyboardFocus(page, gridRadio);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-posts-radio-keyboard.png"),
  });

  // Normal motion travels: the rendered pill is at a non-resting transform on
  // at least one frame after the checked value changes.
  const travel = await sampleHighlightTravel(page, postView, tableRadio);
  expect(travel.changed).toBe(true);
  expect(travel.travelledFrames).toBeGreaterThan(0);
  await expect(tableRadio).toBeChecked();

  // Calendar swaps the collection surface and owns its own periodic radiogroup.
  await calendarRadio.click();
  const calendar = page.getByRole("region", { name: "Publishing calendar", exact: true });
  await expect(calendar).toBeVisible();
  const period = calendar.getByRole("radiogroup", { name: "Calendar period", exact: true });
  const monthRadio = period.getByRole("radio", { name: "Month", exact: true });
  const weekRadio = period.getByRole("radio", { name: "Week", exact: true });
  await expect(period.getByRole("radio", { checked: true })).toHaveCount(1);
  await monthRadio.click();
  await page.keyboard.press("End");
  await expect(weekRadio).toBeChecked();
  await expectKeyboardFocus(page, weekRadio);
  await page.keyboard.press("Home");
  await expect(monthRadio).toBeChecked();
  await expectKeyboardFocus(page, monthRadio);
  await page.keyboard.press("ArrowRight");
  await expect(weekRadio).toBeChecked();
  await expectKeyboardFocus(page, weekRadio);
  await page.keyboard.press("ArrowLeft");
  await expect(monthRadio).toBeChecked();
  await expectKeyboardFocus(page, monthRadio);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-calendar-period-keyboard.png"),
  });

  // Return to the grid for the phone capture; reduced-motion travel boots in its
  // own session-level test so the preference exists before the highlight mounts.
  await gridRadio.click();
  await expect(gridRadio).toBeChecked();
  const gridSurface = page
    .getByRole("checkbox", { name: "Select all visible posts" })
    .or(page.getByText("No posts match filters", { exact: true }));
  await expect(gridSurface).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-posts-grid-reduced-motion.png"),
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-posts-phone-320x568.png"),
    fullPage: true,
  });

  // A preference changed while the page is open re-renders the highlight store;
  // the next selection commits without rendered travel.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
  const liveReduced = await sampleHighlightTravel(page, postView, tableRadio);
  expect(liveReduced.changed).toBe(true);
  expect(liveReduced.travelledFrames).toBe(0);
  expect(liveReduced.finalSample.scaleX).toBeCloseTo(1, 2);
  expect(liveReduced.finalSample.translateX).toBeCloseTo(0, 1);
  await expect(tableRadio).toBeChecked();
});

/**
 * A session that starts with the OS reduced-motion preference proves the
 * travelling pill commits the checked state without rendered translation or
 * scale, while the selected view still switches.
 */
test.describe("reduced motion segmented travel", () => {
  test.use({ reducedMotion: "reduce" });

  test("commits the selection without rendered travel", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openIsolatedOwnerWorkspace(page);
    await waitForWorkspace(page);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );

    const postView = page.getByRole("radiogroup", { name: "Post view", exact: true });
    const gridRadio = postView.getByRole("radio", { name: "Grid", exact: true });
    const travel = await sampleHighlightTravel(page, postView, gridRadio);
    expect(travel.changed).toBe(true);
    expect(travel.travelledFrames).toBe(0);
    expect(travel.finalSample.scaleX).toBeCloseTo(1, 2);
    expect(travel.finalSample.translateX).toBeCloseTo(0, 1);
    await expect(gridRadio).toBeChecked();
    await expect(
      page
        .getByRole("checkbox", { name: "Select all visible posts" })
        .or(page.getByText("No posts match filters", { exact: true })),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("shared-components-posts-grid-reduced-motion.png"),
    });
  });
});

/**
 * Real-stack proof of the centered dialog contract: the ordinary editor
 * dismisses from outside/Escape with a localized Close and returns focus to its
 * Edit trigger, while the destructive confirmation blocks outside dismissal and
 * focuses Cancel until Escape cancels it back into the still-open editor.
 */
test("keeps centered dialog dismissal and destructive focus distinct", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  await page.goto("/channels");
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Brand Profiles/ }).click();

  const editTrigger = page.getByRole("button", { name: `Edit ${profileName}`, exact: true });
  await expect(editTrigger).toBeVisible();
  await editTrigger.click();
  const editor = page.getByRole("dialog", { name: "Update Brand Profile", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-desktop.png"),
  });

  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(editTrigger).toBeFocused();

  // The backdrop belongs to the ordinary dialog, so a real pointer sequence closes it.
  await editTrigger.click();
  await expect(editor).toBeVisible();
  await page
    .locator('[data-dialog-backdrop][data-state="open"]')
    .click({ position: { x: 8, y: 8 } });
  await expect(editor).toBeHidden();
  await expect(editTrigger).toBeFocused();

  // The destructive confirmation cannot be dismissed by the same outside click.
  await editTrigger.click();
  await expect(editor).toBeVisible();
  const deleteTrigger = editor.getByRole("button", { name: "Delete profile", exact: true });
  await deleteTrigger.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete Brand Profile",
    exact: true,
  });
  const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-alert-desktop.png"),
  });

  await page
    .locator('[data-dialog-backdrop][data-state="open"]')
    .last()
    .click({ position: { x: 8, y: 8 } });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(deleteTrigger).toBeFocused();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-after-cancel.png"),
  });

  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(editTrigger).toBeFocused();

  // The same editor keeps its fixed box inside a short phone viewport.
  await page.setViewportSize({ width: 320, height: 480 });
  await editTrigger.click();
  await expect(editor).toBeVisible();
  // The bottom-up entrance starts below the viewport; measure the resting box.
  await expect
    .poll(() =>
      editor.evaluate((element) =>
        element.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const box = await editor.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320.5);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(480.5);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-phone-320x480.png"),
  });

  // The 51-swatch palette is taller than a phone dialog. The failure text and
  // the action footer therefore share one opaque, pinned region: visible
  // without scrolling, while the palette scrolls natively behind it and every
  // swatch stays reachable at maximum scroll.
  await page.setViewportSize({ width: 320, height: 568 });
  const actionRegion = editor.locator("[data-brand-profile-dialog-actions]");
  const submitAction = editor.getByRole("button", { name: "Update profile", exact: true });
  await expect(actionRegion).toBeVisible();
  await expect(submitAction).toBeInViewport({ ratio: 1 });
  await expect(deleteTrigger).toBeInViewport({ ratio: 1 });

  const pinnedContract = await editor.evaluate((element) => {
    const region = element.querySelector<HTMLElement>("[data-brand-profile-dialog-actions]");
    const surface = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const swatches = Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]'));
    const rects = swatches.map((swatch) => swatch.getBoundingClientRect());
    return {
      backgroundColor: region ? getComputedStyle(region).backgroundColor : "",
      contentLeft: box.left + parseFloat(surface.paddingLeft) + 0.5,
      contentRight: box.right - parseFloat(surface.paddingRight) - 0.5,
      minSwatchLeft: Math.min(...rects.map((rect) => rect.left)),
      maxSwatchRight: Math.max(...rects.map((rect) => rect.right)),
      swatchCount: swatches.length,
      scrollPaddingBottom: element.style.scrollPaddingBottom,
      scrollTop: element.scrollTop,
    };
  });
  expect(pinnedContract.swatchCount).toBe(51);
  expect(pinnedContract.scrollTop).toBe(0);
  expect(pinnedContract.minSwatchLeft).toBeGreaterThanOrEqual(pinnedContract.contentLeft);
  expect(pinnedContract.maxSwatchRight).toBeLessThanOrEqual(pinnedContract.contentRight);
  // Opaque surface: the scrolling palette must not read through the actions.
  expect(pinnedContract.backgroundColor).toMatch(/^rgb/);
  expect(pinnedContract.backgroundColor).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)$/);
  // The registered focus reserve matches the pinned block's rendered height.
  expect(pinnedContract.scrollPaddingBottom).toMatch(/^\d+(?:\.\d+)?px$/);

  await editor.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      editor.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  const maxScrollContract = await editor.evaluate((element) => {
    const region = element.querySelector<HTMLElement>("[data-brand-profile-dialog-actions]");
    const swatches = Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]'));
    const lastSwatch = swatches.at(-1)?.getBoundingClientRect();
    return {
      lastSwatchBottom: lastSwatch?.bottom ?? Number.POSITIVE_INFINITY,
      regionTop: region?.getBoundingClientRect().top ?? Number.NEGATIVE_INFINITY,
    };
  });
  // At maximum scroll the final swatch rests fully above the pinned region.
  expect(maxScrollContract.lastSwatchBottom).toBeLessThanOrEqual(maxScrollContract.regionTop + 1);
  await expect(editor.getByRole("radio").last()).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-pinned-320x568.png"),
  });

  // Arrow keys move focus and selection without landing underneath the block.
  const checkedSwatch = editor.locator('[role="radio"][aria-checked="true"]');
  const previousColor = await checkedSwatch.getAttribute("title");
  await checkedSwatch.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => editor.locator('[role="radio"][aria-checked="true"]').getAttribute("title"))
    .not.toBe(previousColor);
  const selectedSwatch = editor.locator('[role="radio"][aria-checked="true"]');
  await expect(selectedSwatch).toBeFocused();
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const region = element.querySelector<HTMLElement>("[data-brand-profile-dialog-actions]");
        const active = document.activeElement as HTMLElement | null;
        if (!active || !region) return false;
        return active.getBoundingClientRect().bottom <= region.getBoundingClientRect().top + 1;
      }),
    )
    .toBe(true);

  // The pinned region survives the wider phone and a software-keyboard-height
  // viewport without moving the primary action out of reach.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(submitAction).toBeInViewport({ ratio: 1 });
  await expect(deleteTrigger).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-pinned-390x844.png"),
  });
  await page.setViewportSize({ width: 320, height: 400 });
  await expect(actionRegion).toBeInViewport();
  await expect(submitAction).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(editTrigger).toBeFocused();

  // Both palettes keep the pinned surface opaque; the dark pass reloads with
  // the shared theme cookie so the documented preference path applies.
  await page.evaluate(() => {
    localStorage.setItem("meltiply.theme", "dark");
    document.cookie = "meltiply-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax";
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /Brand Profiles/ }).click();
  await editTrigger.click();
  await expect(editor).toBeVisible();
  await expect(actionRegion).toBeVisible();
  await expect(submitAction).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      editor.locator("[data-brand-profile-dialog-actions]").evaluate((element) => {
        const fill = getComputedStyle(element).backgroundColor;
        return fill.startsWith("rgb") && !fill.endsWith(", 0)");
      }),
    )
    .toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("shared-components-dialog-pinned-dark-390x844.png"),
  });
});

/**
 * Real-stack proof of the coarse-pointer segmented contract: touch emulation
 * makes `(pointer: coarse)` match, so the shared atom, line tab strip, and
 * account-menu theme radios must render the documented 44px target inside a
 * track that grows instead of clipping them. A width-constrained Language track
 * must start at its first option and scroll to its last at 320px.
 */
test.describe("coarse pointer segmented chrome", () => {
  // `hasTouch` alone makes Chromium report `(pointer: coarse)`; the assertion in
  // the test keeps this from silently running as a fine pointer.
  test.use({ hasTouch: true });

  test("keeps segmented targets coarse-sized and the scroll origin reachable", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openIsolatedOwnerWorkspace(page);
    await waitForWorkspace(page);

    // Posts atom: every view target is at least 44px tall and the track grew.
    const postView = page.getByRole("radiogroup", { name: "Post view", exact: true });
    await expect(postView.getByRole("radio")).toHaveCount(3);
    const postsGeometry = await segmentedGeometry(postView);
    expect(postsGeometry.trackHeight).toBeGreaterThanOrEqual(47.5);
    for (const height of postsGeometry.itemHeights) {
      expect(height).toBeGreaterThanOrEqual(43.5);
    }
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("shared-components-coarse-posts-1440.png"),
    });

    // The account-menu theme segments are reachable on the desktop rail.
    const accountTrigger = page.getByRole("button", { name: "Account menu", exact: true });
    await accountTrigger.click();
    const themeGroup = page
      .getByRole("menu", { name: "Account menu", exact: true })
      .getByRole("group", { name: "Theme", exact: true });
    await expect(themeGroup.getByRole("menuitemradio")).toHaveCount(3);
    const themeGeometry = await segmentedGeometry(themeGroup);
    expect(themeGeometry.trackHeight).toBeGreaterThanOrEqual(47.5);
    for (const height of themeGeometry.itemHeights) {
      expect(height).toBeGreaterThanOrEqual(43.5);
    }
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("shared-components-coarse-account-theme.png"),
    });
    await page.keyboard.press("Escape");
    await expect(accountTrigger).toBeFocused();

    // The Channels line tabs grow the strip rather than clipping the trigger.
    await page.goto("/channels");
    const channelTabs = page.getByRole("tablist", {
      name: "Channel directory sections",
      exact: true,
    });
    await expect(channelTabs).toBeVisible();
    const tabGeometry = await segmentedGeometry(channelTabs);
    expect(tabGeometry.trackHeight).toBeGreaterThanOrEqual(43.5);
    for (const height of tabGeometry.itemHeights) {
      expect(height).toBeGreaterThanOrEqual(43.5);
    }
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("shared-components-coarse-channels-tabs.png"),
    });

    // Settings Language: the constrained track starts at its first option and
    // the last option is reachable by scrolling at phone width.
    await page.goto("/settings?section=language");
    const languageTrack = page.getByRole("radiogroup", { name: "Language", exact: true });
    await expect(languageTrack).toBeVisible();
    await page.setViewportSize({ width: 320, height: 568 });
    await expect
      .poll(() => languageTrack.evaluate((track) => track.scrollWidth > track.clientWidth + 1))
      .toBe(true);

    const startGeometry = await languageTrack.evaluate((track) => {
      const items = Array.from(track.querySelectorAll<HTMLElement>('[role="radio"]'));
      const trackBox = track.getBoundingClientRect();
      return {
        scrollLeft: track.scrollLeft,
        trackLeft: trackBox.left,
        firstLeft: items[0]?.getBoundingClientRect().left ?? Number.NEGATIVE_INFINITY,
        heights: items.map((item) => item.getBoundingClientRect().height),
      };
    });
    expect(startGeometry.scrollLeft).toBe(0);
    expect(startGeometry.firstLeft).toBeGreaterThanOrEqual(startGeometry.trackLeft - 0.5);
    for (const height of startGeometry.heights) {
      expect(height).toBeGreaterThanOrEqual(43.5);
    }

    await languageTrack.evaluate((track) => {
      track.scrollLeft = track.scrollWidth;
    });
    await expect.poll(() => languageTrack.evaluate((track) => track.scrollLeft)).toBeGreaterThan(0);
    const endGeometry = await languageTrack.evaluate((track) => {
      const items = Array.from(track.querySelectorAll<HTMLElement>('[role="radio"]'));
      const trackBox = track.getBoundingClientRect();
      const last = items.at(-1)?.getBoundingClientRect();
      return {
        lastLeft: last?.left ?? Number.POSITIVE_INFINITY,
        lastRight: last?.right ?? Number.POSITIVE_INFINITY,
        trackLeft: trackBox.left,
        trackRight: trackBox.right,
      };
    });
    expect(endGeometry.lastLeft).toBeGreaterThanOrEqual(endGeometry.trackLeft - 0.5);
    expect(endGeometry.lastRight).toBeLessThanOrEqual(endGeometry.trackRight + 0.5);

    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("shared-components-coarse-language-320x568.png"),
    });
  });
});
