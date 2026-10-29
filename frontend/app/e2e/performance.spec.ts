import { expect, test, type Page } from "@playwright/test";

import {
  installPerformanceCollector,
  measureJourney,
  medianMetrics,
  typedContentMatches,
  withinBudget,
  type JourneyBudget,
  type JourneyMetrics,
} from "./performance-harness";
import { signIn, waitForWorkspace } from "./workspace-session";

/**
 * Budgets are medians across repeated warm runs. They are deliberately far
 * above an idle local run so a shared GitHub runner gates structural
 * regressions (a failed request, a missing lazy chunk, a render loop) without
 * turning scheduling jitter into a flaky failure.
 */
const budgets = {
  coldSignIn: { apiMs: 9_000, cls: 0.2, elapsedMs: 18_000, longTaskMs: 4_000 },
  composerOpen: { apiMs: 2_500, cls: 0.08, elapsedMs: 4_000, longTaskMs: 1_500 },
  composerTyping: { apiMs: 500, cls: 0.02, elapsedMs: 3_000, longTaskMs: 1_000 },
  mediaNavigation: { apiMs: 3_000, cls: 0.08, elapsedMs: 5_000, longTaskMs: 1_500 },
  signInScreen: { apiMs: 3_000, cls: 0.15, elapsedMs: 8_000, longTaskMs: 2_500 },
  warmPosts: { apiMs: 5_000, cls: 0.06, elapsedMs: 7_000, longTaskMs: 2_000 },
} satisfies Record<string, JourneyBudget>;

const credentials = {
  email: "alpha@meltiply.local",
  name: "Alpha Creator",
  password: "MeltiplyLocal1!",
};

/** Waits for the real hydrated Posts surface after a navigation or reload. */
async function waitForPosts(page: Page): Promise<void> {
  await waitForWorkspace(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
  // A shell or a pending request is not a completed journey: wait for the
  // deterministic seeded collection to render its first real Post row, not a
  // skeleton row that shares the same data attribute.
  await expect(page.locator('[data-post-row]:not([aria-hidden="true"])').first()).toBeVisible({
    timeout: 20_000,
  });
}

/** Opens the first real Post row and waits for its media-bearing inspector. */
async function openFirstPostMedia(page: Page): Promise<void> {
  const row = page.locator("[data-post-row]").first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole("heading", { name: /Attachments/i }).first()).toBeVisible({
    timeout: 10_000,
  });
}

/** Opens the composer through the same toolbar action a creator uses. */
async function openComposer(page: Page): Promise<void> {
  await page.locator("main header").getByRole("button", { name: "Create post" }).click();
  await expect(page.getByPlaceholder(/what do you want to publish/i)).toBeVisible();
}

/** Repeats one measured action and returns the median attribution. */
async function measureRepeated(
  page: Page,
  action: () => Promise<void>,
  repetitions = 3,
): Promise<JourneyMetrics> {
  const samples: JourneyMetrics[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    samples.push(await measureJourney(page, action));
  }
  return medianMetrics(samples);
}

test.describe("production publishing journeys", () => {
  test.describe.configure({ retries: 0 });
  test.use({
    colorScheme: "light",
    deviceScaleFactor: 1,
    viewport: { height: 900, width: 1440 },
  });
  test.setTimeout(180_000);

  test("measures the separate public landing when its preview is configured", async ({ page }) => {
    const publicBase = process.env.MELTIPLY_E2E_PUBLIC_BASE_URL?.trim();
    test.skip(!publicBase, "Set MELTIPLY_E2E_PUBLIC_BASE_URL to measure the public landing.");
    await installPerformanceCollector(page);
    const landing = await measureJourney(page, async () => {
      await page.goto(`${publicBase}/`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
        timeout: 15_000,
      });
    });
    test.info().attach("public-landing.json", {
      body: JSON.stringify(landing, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(landing, budgets.signInScreen),
      `public landing exceeded budget: ${JSON.stringify(landing)}`,
    ).toBe(true);
  });

  test("signs in to a populated workspace and reaches Posts", async ({ page }) => {
    await installPerformanceCollector(page);
    const signInScreen = await measureJourney(page, async () => {
      await page.goto("/sign-in");
      await expect(page.getByLabel(/email address/i)).toBeVisible({ timeout: 15_000 });
    });
    test.info().attach("sign-in-screen.json", {
      body: JSON.stringify(signInScreen, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(signInScreen, budgets.signInScreen),
      `sign-in screen exceeded budget: ${JSON.stringify(signInScreen)}`,
    ).toBe(true);

    const cold = await measureJourney(page, async () => {
      await page.getByLabel(/email address/i).fill(credentials.email);
      await page.getByLabel(/^password$/i).fill(credentials.password);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
      await waitForPosts(page);
    });
    test.info().attach("cold-signed-in-posts.json", {
      body: JSON.stringify(cold, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(cold, budgets.coldSignIn),
      `cold signed-in Posts exceeded budget: ${JSON.stringify(cold)}`,
    ).toBe(true);
  });

  test("warms Posts, opens media, and types in the composer", async ({ page }) => {
    await installPerformanceCollector(page);
    await signIn(page, credentials);
    await waitForPosts(page);

    const warm = await measureRepeated(page, async () => {
      await page.reload();
      await waitForPosts(page);
    });
    test.info().attach("warm-posts.json", {
      body: JSON.stringify(warm, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(warm, budgets.warmPosts),
      `warm Posts exceeded budget: ${JSON.stringify(warm)}`,
    ).toBe(true);

    const media = await measureJourney(page, () => openFirstPostMedia(page));
    test.info().attach("posts-to-media.json", {
      body: JSON.stringify(media, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(media, budgets.mediaNavigation),
      `Posts-to-media navigation exceeded budget: ${JSON.stringify(media)}`,
    ).toBe(true);
    await page.keyboard.press("Escape");

    const composer = await measureJourney(page, () => openComposer(page));
    test.info().attach("composer-open.json", {
      body: JSON.stringify(composer, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(composer, budgets.composerOpen),
      `composer opening exceeded budget: ${JSON.stringify(composer)}`,
    ).toBe(true);

    const typed = "Launch copy with emoji 🚀 and exact spacing.";
    const textarea = page.getByPlaceholder(/what do you want to publish/i);
    const typing = await measureJourney(page, async () => {
      await textarea.click();
      await page.keyboard.type(typed);
    });
    test.info().attach("composer-typing.json", {
      body: JSON.stringify(typing, null, 2),
      contentType: "application/json",
    });
    expect(
      withinBudget(typing, budgets.composerTyping),
      `composer typing exceeded budget: ${JSON.stringify(typing)}`,
    ).toBe(true);
    expect(
      typedContentMatches(await textarea.inputValue(), typed),
      "the composer lost or reordered typed content",
    ).toBe(true);
  });

  test("the gate catches delayed readiness, lost input, and layout movement", async ({ page }) => {
    await installPerformanceCollector(page);
    await signIn(page, credentials);
    await waitForPosts(page);

    // Delayed readiness: a fresh context has no memory cache and starts from
    // the signed-in cookie, so the representative API delay reaches the real
    // fetch and the journey cannot pass on already-rendered rows.
    const browser = page.context().browser();
    if (!browser) throw new Error("the performance journey needs a browser instance");
    const storage = await page.context().storageState();
    const delayedContext = await browser.newContext({
      storageState: storage,
      viewport: { height: 900, width: 1440 },
    });
    const delayedPage = await delayedContext.newPage();
    await installPerformanceCollector(delayedPage);
    let delayedRequests = 0;
    await delayedPage.route("**/api/v1/posts*", async (route) => {
      delayedRequests += 1;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 9_000);
      await promise;
      await route.continue();
    });
    const delayed = await measureJourney(delayedPage, async () => {
      await delayedPage.goto(`${new URL(page.url()).origin}/posts`);
      await waitForPosts(delayedPage);
    });
    expect(
      delayedRequests,
      "the delayed readiness route never intercepted its request",
    ).toBeGreaterThan(0);
    expect(
      withinBudget(delayed, budgets.warmPosts),
      `delayed readiness was not caught: ${JSON.stringify(delayed)}`,
    ).toBe(false);

    // Lost input: the exact-content check fails when even one keystroke is
    // missing, and passes for the untouched value.
    expect(typedContentMatches("launch copy", "launch copy")).toBe(true);
    expect(typedContentMatches("launch cpy", "launch copy")).toBe(false);

    // Layout movement: inserting a large banner above the loaded collection
    // shifts real layout; the same CLS budget must reject it.
    await delayedPage.evaluate(() => {
      const banner = document.createElement("div");
      banner.style.height = "320px";
      banner.style.background = "red";
      document.body.prepend(banner);
    });
    await delayedPage.waitForTimeout(500);
    const shifted = await delayedPage.evaluate(() => {
      const value = Reflect.get(window, "__meltiplyPerf");
      if (!value || typeof value !== "object" || !("cls" in value)) return 0;
      return typeof value.cls === "number" ? value.cls : 0;
    });
    expect(shifted).toBeGreaterThan(budgets.warmPosts.cls);
    await delayedContext.close();
  });
});
