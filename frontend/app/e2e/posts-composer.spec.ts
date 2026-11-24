import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  animatedGifFixture,
  attachmentControlName,
  attachmentTitle,
  mp4Fixture,
  pngFixture,
  publicationVideoFixture,
  quickTimeFixture,
  truncatedMp4Fixture,
} from "./media-fixtures";
import {
  activeBrandProfileName,
  closeComposer,
  editPostFromRow,
  provisionControlledChannels,
  controlledProviderAccountId,
  readLiveControlledCopies,
  type ControlledPlatform,
} from "./publication-fixtures";
import { signIn, openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

test.use({ screenshot: "only-on-failure", trace: "retain-on-failure" });
test.setTimeout(240_000);

const processingTimeoutMs = 180_000;

const throttledUploadBytesPerSecond = 4_096;

const composerTextarea = (page: Page) => page.getByPlaceholder(/what do you want to publish/i);

function composerFileInput(page: Page) {
  return page.locator('input[type="file"]');
}

function attachmentStrip(page: Page, fileName: string) {
  return page.getByRole("status").filter({ hasText: attachmentTitle(fileName) });
}

async function expectAttachmentPhases(
  page: Page,
  expected: readonly (readonly [string, string])[],
) {
  for (const [fileName, phase] of expected) {
    await expect(attachmentStrip(page, fileName)).toContainText(phase, {
      timeout: processingTimeoutMs,
    });
  }
}

function attachmentFailureMessage(page: Page, fileName: string) {
  return attachmentStrip(page, fileName).locator("xpath=following-sibling::p");
}

function attachmentPreview(page: Page, fileName: string) {
  return attachmentStrip(page, fileName).locator("xpath=preceding-sibling::*[1]");
}

async function openComposer(page: Page): Promise<void> {
  await page.locator("main header").getByRole("button", { name: "Create post" }).click();
  await expect(composerTextarea(page)).toBeVisible();
}

async function saveDraft(page: Page): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "Preparing" })).toHaveCount(0, {
    timeout: 60_000,
  });
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await expect(page.getByText(/Saved to your workspace at/i)).toBeVisible({ timeout: 60_000 });
}

async function choosePublishingMode(page: Page, mode: "Draft" | "Schedule" | "Now"): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: mode, exact: true })
    .click();
}

async function saveAndSettle(
  page: Page,
  expected: readonly (readonly [string, string])[],
): Promise<void> {
  await saveDraft(page);
  await expectAttachmentPhases(page, expected);
}

async function reopenDraft(page: Page, caption: string): Promise<void> {
  await closeComposer(page);
  const row = page.getByRole("row").filter({ hasText: caption });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await editPostFromRow(page, row);
  await expect(composerTextarea(page)).toHaveValue(caption);
}

async function attachChannels(
  page: Page,
  request: APIRequestContext,
  profileName: string,
  platforms: readonly ControlledPlatform[],
): Promise<string[]> {
  const displayNames = platforms.map(
    (platform) => `Controlled ${platform[0]!.toUpperCase()}${platform.slice(1)}`,
  );
  await provisionControlledChannels(
    request,
    profileName,
    displayNames.map((displayName, index) => ({
      displayName,
      platform: platforms[index]!,
      providerUserId: `e2e-${platforms[index]}-${randomUUID()}`,
    })),
  );
  await reloadWithScopedProfile(page);
  return displayNames;
}

async function reloadWithScopedProfile(page: Page): Promise<string> {
  await page.reload();
  await waitForWorkspace(page);
  return activeBrandProfileName(page);
}

interface SavedTargetFields {
  attachment_ids?: string[] | null;
  description_override?: string | null;
  hashtags?: string[];
  platform_account_id: string;
  title_override?: string | null;
}

interface PostMutation {
  method: string;
  request: { attachment_ids?: string[]; default_text?: string; targets?: SavedTargetFields[] };
  response: {
    id: string;
    brand_profile_id: string;
    attachments: Array<{ asset_id: string; asset: { brand_profile_id: string } }>;
    distributions: unknown[];
    targets: SavedTargetFields[];
  };
}

interface PostMutationRecorder {
  mutations: readonly PostMutation[];
  waitForSaveAfter: (seen: number) => Promise<void>;
}

async function watchPostMutations(page: Page): Promise<PostMutationRecorder> {
  const mutations: PostMutation[] = [];
  const waiting = new Set<{ seen: number; resolve: () => void }>();
  await page.route(/\/api\/v1\/posts(\/|\?|$)/, async (route) => {
    const request = route.request();
    const isDraftSave =
      (request.method() === "POST" || request.method() === "PATCH") &&
      !new URL(request.url()).pathname.endsWith("/schedule");
    if (!isDraftSave) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as PostMutation["response"];
    const parsedRequest: unknown = JSON.parse(request.postData() ?? "{}");
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ body: JSON.stringify(body), headers, status: response.status() });
    mutations.push({
      method: request.method(),
      request: parsedRequest as PostMutation["request"],
      response: body,
    });
    for (const waiter of waiting) {
      if (mutations.length <= waiter.seen) continue;
      waiting.delete(waiter);
      waiter.resolve();
    }
  });
  return {
    mutations,
    waitForSaveAfter(seen) {
      if (mutations.length > seen) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.add({ seen, resolve });
      return promise;
    },
  };
}

async function holdNextPostSave(page: Page): Promise<{
  arrived: Promise<void>;
  held: PostMutation["request"][];
  release: () => void;
}> {
  const held: PostMutation["request"][] = [];
  let announce = (): void => {};
  const arrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let isHolding = false;
  await page.route(/\/api\/v1\/posts\//, async (route) => {
    const request = route.request();
    const isDraftSave =
      (request.method() === "POST" || request.method() === "PATCH") &&
      !new URL(request.url()).pathname.endsWith("/schedule");
    if (!isDraftSave || isHolding) {
      await route.fallback();
      return;
    }
    isHolding = true;
    const parsedRequest: unknown = JSON.parse(request.postData() ?? "{}");
    held.push(parsedRequest as PostMutation["request"]);
    announce();
    await gate;
    await route.fallback();
  });
  return { arrived, held, release: () => open() };
}

async function presentChannelAsProvider(
  page: Page,
  displayName: string,
  provider: string,
): Promise<void> {
  await page.route(/\/api\/v1\/platforms(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { accounts: Array<Record<string, unknown>> };
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({
      body: JSON.stringify({
        ...body,
        accounts: body.accounts.map((account) =>
          account.display_name === displayName ? { ...account, platform: provider } : account,
        ),
      }),
      headers,
      status: response.status(),
    });
  });
}

async function trackBlobUrls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectUrl = URL.createObjectURL.bind(URL);
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = createObjectUrl(object);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revokeObjectUrl(url);
    };
    const tracked = window as Window & { blobUrls?: { created: string[]; revoked: string[] } };
    tracked.blobUrls = { created, revoked };
  });
}

async function blobUrlCounts(page: Page): Promise<{ created: number; revoked: number }> {
  return page.evaluate(() => {
    const tracked = window as Window & { blobUrls?: { created: string[]; revoked: string[] } };
    return {
      created: tracked.blobUrls?.created.length ?? 0,
      revoked: tracked.blobUrls?.revoked.length ?? 0,
    };
  });
}

async function composerRecoveryKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith("meltiply.composer.v2.")),
  );
}

test("keeps a saved text-only draft across reload and a separate session", async ({
  page,
  browser,
}) => {
  const { credentials } = await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const caption = "Draft persistence regression caption";
  await composerTextarea(page).fill(caption);
  await saveDraft(page);

  await page.reload();
  await waitForWorkspace(page);
  await expect(page.getByText(caption).first()).toBeVisible({ timeout: 30_000 });

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, credentials);
  await waitForWorkspace(secondPage);
  await expect(secondPage.getByText(caption).first()).toBeVisible({ timeout: 30_000 });
  await second.close();
});

test("restores an unsaved new composition after a reload and clears it on save", async ({
  page,
}) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const caption = "Unsaved new composition survives reload";
  await composerTextarea(page).fill(caption);
  await expect
    .poll(async () => (await composerRecoveryKeys(page)).length, { timeout: 30_000 })
    .toBe(1);

  await reloadWithScopedProfile(page);
  await openComposer(page);
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();

  await saveDraft(page);
  expect(await composerRecoveryKeys(page)).toHaveLength(0);
  await closeComposer(page);
  await openComposer(page);
  await expect(composerTextarea(page)).toHaveValue("");
});

test("restores unsaved edits on a reopened saved draft after a reload", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const savedCaption = "Saved caption before the reload";
  await composerTextarea(page).fill(savedCaption);
  await saveDraft(page);

  const unsavedCaption = "Unsaved caption typed after the save";
  await composerTextarea(page).fill(unsavedCaption);
  await expect
    .poll(async () => (await composerRecoveryKeys(page)).length, { timeout: 30_000 })
    .toBe(1);

  await reloadWithScopedProfile(page);
  const row = page.getByRole("row").filter({ hasText: savedCaption });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await editPostFromRow(page, row);
  await expect(composerTextarea(page)).toHaveValue(unsavedCaption);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();
});

test("uploads media in the composer and saves the ordered attachments", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);

  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();

  const caption = "Multi attachment draft";
  await composerTextarea(page).fill(caption);
  await saveAndSettle(page, [
    [gif.name, "Ready"],
    [png.name, "Ready"],
  ]);

  await reopenDraft(page, caption);
  await expectAttachmentPhases(page, [
    [gif.name, "1. "],
    [png.name, "2. "],
  ]);
});

test("recovers independent profile copies and retries only unfinished publishing", async ({
  page,
  request,
}) => {
  test.slow();
  const workspace = await openIsolatedOwnerWorkspace(page);
  const secondaryName = `${workspace.profileName} secondary`;
  await page.goto("/channels");
  await page.getByRole("button", { name: "Create Brand Profile", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Brand Profile", exact: true });
  await editor.getByLabel("Profile name", { exact: true }).fill(secondaryName);
  await editor.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const firstAccount = controlledProviderAccountId("threads");
  const secondAccount = controlledProviderAccountId("threads");
  const primary = await provisionControlledChannels(request, workspace.profileName, [
    { platform: "threads", displayName: "Primary Threads", providerUserId: firstAccount },
  ]);
  const secondary = await provisionControlledChannels(request, secondaryName, [
    { platform: "threads", displayName: "Secondary Threads", providerUserId: secondAccount },
    {
      platform: "instagram",
      displayName: "Secondary Instagram",
      providerUserId: controlledProviderAccountId("instagram"),
    },
  ]);
  await page.goto("/posts");
  await waitForWorkspace(page);
  await activeBrandProfileName(page);
  await openComposer(page);
  await page.locator('[data-side-dialog] button[aria-haspopup="menu"]').click();
  const profiles = page.getByRole("menu", { name: "Brand Profile", exact: true });
  await profiles.getByRole("menuitemcheckbox", { name: secondaryName, exact: true }).click();
  await expect(
    profiles.getByRole("menuitemcheckbox", { name: workspace.profileName, exact: true }),
  ).toBeChecked();
  await expect(
    profiles.getByRole("menuitemcheckbox", { name: secondaryName, exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  const destinations = page.getByRole("region", { name: "Destinations", exact: true });
  const threadsGroup = destinations.locator('section[aria-label="Threads"]');
  await expect(threadsGroup.getByRole("button", { name: /Primary Threads/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(threadsGroup.getByRole("button", { name: /Secondary Threads/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(destinations.locator('section[aria-label="Instagram"]')).toBeVisible();
  await destinations.getByRole("button", { name: /Secondary Instagram/ }).click();

  const caption = "Independent profile copies";
  const secondaryCaption = "Secondary profile caption";
  await composerTextarea(page).fill(caption);
  const video = publicationVideoFixture();
  await composerFileInput(page).setInputFiles(video);
  await expectAttachmentPhases(page, [[video.name, "Ready"]]);
  const secondaryPanel = page.getByRole("region", { name: "Secondary Threads", exact: true });
  await secondaryPanel.getByRole("textbox").fill(secondaryCaption);
  await secondaryPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  await secondaryPanel
    .getByRole("button", { name: attachmentControlName("1. ", video.name) })
    .click();
  const { mutations } = await watchPostMutations(page);
  let rejectSecondaryDraft = true;
  await page.route(/\/api\/v1\/asset-upload-sessions$/, async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (
      rejectSecondaryDraft &&
      route.request().method() === "POST" &&
      typeof body === "object" &&
      body !== null &&
      "brand_profile_id" in body &&
      body.brand_profile_id === secondary.brand_profile_id
    ) {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "internal_error", message: "Temporarily unavailable" },
        },
      });
    } else await route.fallback();
  });
  await page.getByRole("button", { name: "Save Drafts", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  const primaryBeforeRetry = mutations.find(
    (mutation) => mutation.response.brand_profile_id === primary.brand_profile_id,
  )?.response;
  expect(primaryBeforeRetry?.brand_profile_id).toBe(primary.brand_profile_id);
  rejectSecondaryDraft = false;
  await reloadWithScopedProfile(page);
  await openComposer(page);
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(secondaryPanel.getByRole("textbox")).toHaveValue(secondaryCaption);
  await page.getByRole("button", { name: "Save Drafts", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/Saved to your workspace at/i)).toBeVisible({ timeout: 60_000 });
  const firstCopy = mutations.findLast(
    (mutation) => mutation.response.brand_profile_id === primary.brand_profile_id,
  )?.response;
  const secondCopy = mutations.findLast(
    (mutation) => mutation.response.brand_profile_id === secondary.brand_profile_id,
  )?.response;
  expect(firstCopy?.id).toBe(primaryBeforeRetry?.id);
  expect(firstCopy?.attachments).toHaveLength(1);
  expect(secondCopy?.attachments).toHaveLength(1);
  expect(firstCopy?.attachments[0]?.asset.brand_profile_id).toBe(primary.brand_profile_id);
  expect(secondCopy?.attachments[0]?.asset.brand_profile_id).toBe(secondary.brand_profile_id);
  expect(secondCopy?.attachments[0]?.asset_id).not.toBe(firstCopy?.attachments[0]?.asset_id);
  expect(
    secondCopy?.targets.find((target) => target.platform_account_id === secondary.channels[0]?.id),
  ).toMatchObject({
    description_override: secondaryCaption,
    attachment_ids: [secondCopy?.attachments[0]?.asset_id],
  });
  expect(new Set(mutations.map((mutation) => mutation.response.id))).toEqual(
    new Set([firstCopy?.id, secondCopy?.id]),
  );

  let rejectSecondarySchedule = true;
  const acceptedPrimarySchedules: string[] = [];
  await page.route(/\/api\/v1\/posts\/[^/]+\/schedule$/, async (route) => {
    if (route.request().url().includes(`/${secondCopy?.id}/`) && rejectSecondarySchedule) {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "internal_error", message: "Temporarily unavailable" },
        },
      });
    } else {
      if (route.request().url().includes(`/${firstCopy?.id}/`))
        acceptedPrimarySchedules.push(route.request().url());
      await route.fallback();
    }
  });
  await choosePublishingMode(page, "Now");
  await page.getByRole("button", { name: "Publish Posts", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: processingTimeoutMs });
  expect(acceptedPrimarySchedules).toHaveLength(1);
  rejectSecondarySchedule = false;
  await page.getByRole("button", { name: "Publish Posts", exact: true }).click();
  await expect(composerTextarea(page)).toBeHidden({ timeout: 60_000 });
  expect(acceptedPrimarySchedules).toHaveLength(1);
  for (const [account, content] of [
    [firstAccount, caption],
    [secondAccount, secondaryCaption],
  ] as const) {
    await expect
      .poll(async () => readLiveControlledCopies(request, account), {
        timeout: processingTimeoutMs,
      })
      .toMatchObject([
        {
          caption: content,
          media: [expect.objectContaining({ contentType: "video/mp4" })],
        },
      ]);
    expect(await readLiveControlledCopies(request, account)).toHaveLength(1);
  }
});

test("replaces and removes attachments without losing the caption", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  const clip = mp4Fixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);

  const caption = "Replace and remove journey";
  await composerTextarea(page).fill(caption);

  await page.getByRole("button", { name: "Replace attachment 1" }).click();
  await composerFileInput(page).setInputFiles({
    mimeType: clip.mimeType,
    name: clip.name,
    buffer: clip.buffer,
  });
  await expect(attachmentStrip(page, clip.name)).toContainText("1. ");
  await expect(composerTextarea(page)).toHaveValue(caption);

  await page.getByRole("button", { name: "Remove attachment 2" }).click();
  await expect(page.getByText(gif.name)).toHaveCount(0);
  await expect(attachmentStrip(page, clip.name)).toContainText("1. ");

  await saveAndSettle(page, [[clip.name, "Ready"]]);
  await reopenDraft(page, caption);
  await expectAttachmentPhases(page, [[clip.name, "1. "]]);
  await expect(page.getByText(gif.name)).toHaveCount(0);
});

test("replaces one attachment without changing the count, order, or channel selections", async ({
  page,
  request,
}) => {
  test.slow();
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [narrow, silent] = await attachChannels(page, request, profileName, [
    "instagram",
    "threads",
  ]);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  const clip = mp4Fixture();
  const camera = quickTimeFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
    { mimeType: clip.mimeType, name: clip.name, buffer: clip.buffer },
  ]);
  const caption = "Replace keeps count and order";
  await composerTextarea(page).fill(caption);

  const narrowPanel = page.getByRole("region", { name: narrow, exact: true });
  const silentPanel = page.getByRole("region", { name: silent, exact: true });
  await narrowPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  const narrowRow = narrowPanel.getByRole("button", {
    name: attachmentControlName("2. ", gif.name),
  });
  await expect(narrowRow).toBeVisible({ timeout: 60_000 });
  await narrowRow.click();
  await expect(narrowRow).toHaveAttribute("aria-pressed", "true");
  await silentPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();

  await page.getByRole("button", { name: "Replace attachment 2" }).click();
  await composerFileInput(page).setInputFiles({
    mimeType: camera.mimeType,
    name: camera.name,
    buffer: camera.buffer,
  });

  await expect(page.getByText(/Attached Media \(3\)/)).toBeVisible();
  await expectAttachmentPhases(page, [
    [png.name, "1. "],
    [camera.name, "2. "],
    [clip.name, "3. "],
  ]);
  await expect(page.getByText(gif.name)).toHaveCount(0);
  await expect(composerTextarea(page)).toHaveValue(caption);

  await expect(
    narrowPanel.getByRole("button", {
      name: attachmentControlName("2. ", camera.name),
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    narrowPanel.getByRole("button", {
      name: attachmentControlName("1. ", png.name),
    }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    silentPanel.getByRole("switch", { name: "Use post attachments", exact: true }),
  ).toHaveAttribute("aria-checked", "false");

  await saveAndSettle(page, [
    [png.name, "Ready"],
    [camera.name, "Ready"],
    [clip.name, "Ready"],
  ]);

  await reloadWithScopedProfile(page);
  await editPostFromRow(page, page.getByRole("row").filter({ hasText: caption }));
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expectAttachmentPhases(page, [
    [png.name, "1. "],
    [camera.name, "2. "],
    [clip.name, "3. "],
  ]);
  await expect(page.getByText(gif.name)).toHaveCount(0);
  const reopenedPanel = page.getByRole("region", { name: narrow, exact: true });
  await expect(
    reopenedPanel.getByRole("button", {
      name: attachmentControlName("2. ", camera.name),
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reopenedPanel.getByRole("button", {
      name: attachmentControlName("1. ", png.name),
    }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    silentPanel.getByRole("switch", { name: "Use post attachments", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});

test("cancels an upload that is still in flight", async ({ page, context }) => {
  await openIsolatedOwnerWorkspace(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    downloadThroughput: -1,
    latency: 0,
    offline: false,
    uploadThroughput: throttledUploadBytesPerSecond,
  });

  try {
    await openComposer(page);
    const clip = mp4Fixture();
    await composerFileInput(page).setInputFiles({
      mimeType: clip.mimeType,
      name: clip.name,
      buffer: clip.buffer,
    });

    const cancel = page.getByRole("button", {
      name: attachmentControlName("Cancel upload of ", clip.name),
    });
    await expect(cancel).toBeVisible({ timeout: 60_000 });
    await cancel.click();
    await expect(attachmentStrip(page, clip.name)).toHaveCount(0);
    await expect(page.getByText(/Attached Media \(0\)/)).toBeVisible();
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      downloadThroughput: -1,
      latency: 0,
      offline: false,
      uploadThroughput: -1,
    });
    await cdp.detach();
  }

  await composerTextarea(page).fill("Cancelled upload journey");
  await saveDraft(page);
});

test("detaches an in-flight attachment without reattaching or leaking it", async ({
  page,
  context,
}) => {
  await trackBlobUrls(page);
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);
  const { mutations, waitForSaveAfter } = await watchPostMutations(page);

  await composerTextarea(page).fill("Detached upload journey");
  await saveDraft(page);

  const held = await holdNextPostSave(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    downloadThroughput: -1,
    latency: 0,
    offline: false,
    uploadThroughput: throttledUploadBytesPerSecond,
  });

  try {
    const clip = mp4Fixture();
    await composerFileInput(page).setInputFiles({
      mimeType: clip.mimeType,
      name: clip.name,
      buffer: clip.buffer,
    });

    await held.arrived;

    await page
      .getByRole("button", {
        name: attachmentControlName("Cancel upload of ", clip.name),
      })
      .click();
    await expect(attachmentStrip(page, clip.name)).toHaveCount(0);
    await expect(page.getByText(/Attached Media \(0\)/)).toBeVisible();

    await expect.poll(() => blobUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      downloadThroughput: -1,
      latency: 0,
      offline: false,
      uploadThroughput: -1,
    });
    await cdp.detach();
  }

  const beforeRelease = mutations.length;
  held.release();
  await waitForSaveAfter(beforeRelease);
  const detachedAssetIds = held.held[0]?.attachment_ids ?? [];
  expect(detachedAssetIds).toHaveLength(1);
  const detachedAssetId = detachedAssetIds[0];
  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForSaveAfter(beforeSave);
  const latest = mutations[mutations.length - 1];
  expect(latest.request.attachment_ids).not.toContain(detachedAssetId);
  expect(latest.response.attachments.map((attachment) => attachment.asset_id)).not.toContain(
    detachedAssetId,
  );
  await expect(page.getByText(/Attached Media \(0\)/)).toBeVisible();
});

test("reports a failed upload and retries it in place", async ({ page, context }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  await context.setOffline(true);
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);

  await expectAttachmentPhases(page, [
    [png.name, "Failed"],
    [gif.name, "Failed"],
  ]);
  await expect(attachmentFailureMessage(page, png.name)).toHaveText(/\S/);
  await expect(attachmentFailureMessage(page, gif.name)).toHaveText(/\S/);

  const caption = "Retry journey";
  await composerTextarea(page).fill(caption);
  await context.setOffline(false);

  await page
    .getByRole("button", {
      name: attachmentControlName("Retry upload of ", png.name),
    })
    .click();
  await expectAttachmentPhases(page, [
    [png.name, "1. "],
    [gif.name, "2. "],
  ]);
  await page
    .getByRole("button", {
      name: attachmentControlName("Retry upload of ", gif.name),
    })
    .click();
  await saveAndSettle(page, [
    [png.name, "Ready"],
    [gif.name, "Ready"],
  ]);
  await expect(composerTextarea(page)).toHaveValue(caption);
});

test("reports an actionable processing failure and blocks publishing", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [threads] = await attachChannels(page, request, profileName, ["threads"]);
  await openComposer(page);

  const png = pngFixture();
  const broken = truncatedMp4Fixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: broken.mimeType, name: broken.name, buffer: broken.buffer },
  ]);

  await saveAndSettle(page, [
    [png.name, "Ready"],
    [broken.name, "Failed"],
  ]);

  await expect(attachmentFailureMessage(page, broken.name)).toHaveText(/\S/);
  await expectAttachmentPhases(page, [[png.name, "Ready"]]);

  await composerTextarea(page).fill("Blocked by an unusable attachment");
  await choosePublishingMode(page, "Now");
  await page.getByRole("button", { name: /publish now/i }).click();
  await expect(page.getByText(/Please fix the following before submitting/i)).toBeVisible({
    timeout: 30_000,
  });
  const violation = page.getByRole("listitem").filter({ hasText: attachmentTitle(broken.name) });
  await expect(violation).toBeVisible();
  await expect(violation).toContainText(threads);
});

test("identifies media-required channels before submitting text-only posts", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [instagram] = await attachChannels(page, request, profileName, ["instagram"]);
  const { mutations } = await watchPostMutations(page);

  const capabilitiesArrived = page.waitForResponse(
    (response) => response.url().includes("/platforms/capabilities") && response.ok(),
    { timeout: 30_000 },
  );
  await openComposer(page);
  await (await capabilitiesArrived).finished();

  const caption = "Text-only post attempting Instagram publish";
  await composerTextarea(page).fill(caption);
  await choosePublishingMode(page, "Now");

  const violation = page.getByRole("listitem").filter({ hasText: instagram });
  await expect(async () => {
    await page.getByRole("button", { name: /publish now/i }).click();
    await expect(violation).toBeVisible({ timeout: 2_000 });
    await expect(violation).toContainText(/requires at least 1 attachment/i);
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/Please fix the following before submitting/i)).toBeVisible();

  expect(mutations).toHaveLength(0);
  await expect(composerTextarea(page)).toHaveValue(caption);
});

test("keeps composer input and reports no saved state when saving fails", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const png = pngFixture();
  await composerFileInput(page).setInputFiles({
    mimeType: png.mimeType,
    name: png.name,
    buffer: png.buffer,
  });
  await composerTextarea(page).fill("First saved caption");
  await saveAndSettle(page, [[png.name, "Ready"]]);

  const caption = "Unsaved work survives a failed save";
  await composerTextarea(page).click();
  await composerTextarea(page).fill(caption);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();

  const saveEndpoint = "**/api/v1/posts/*";
  await page.route(saveEndpoint, (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
  );
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/Saved to your workspace at/i)).toHaveCount(0);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();

  await expect(composerTextarea(page)).toHaveValue(caption);
  await expectAttachmentPhases(page, [[png.name, "Ready"]]);

  await page.unroute(saveEndpoint);
  await saveAndSettle(page, [[png.name, "Ready"]]);
  await expect(composerTextarea(page)).toHaveValue(caption);
});

test("reopens one Post with its ordered attachments and channel targets", async ({
  page,
  browser,
  request,
}) => {
  const { credentials, profileName } = await openIsolatedOwnerWorkspace(page);
  const [instagram, threads] = await attachChannels(page, request, profileName, [
    "instagram",
    "threads",
  ]);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);
  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();

  const caption = "Persistent multi-channel draft";
  await composerTextarea(page).fill(caption);
  await saveAndSettle(page, [
    [gif.name, "Ready"],
    [png.name, "Ready"],
  ]);

  const instagramPanel = page.getByRole("region", { name: instagram, exact: true });
  const threadsPanel = page.getByRole("region", { name: threads, exact: true });
  await instagramPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  await threadsPanel.getByRole("textbox").fill("Threads-only caption");
  await saveDraft(page);
  const savedPreview = new RegExp(`${caption}|Threads-only caption`);

  await reloadWithScopedProfile(page);
  await editPostFromRow(page, page.getByRole("row").filter({ hasText: savedPreview }));
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expectAttachmentPhases(page, [
    [gif.name, "1. "],
    [png.name, "2. "],
  ]);
  await expect(
    instagramPanel.getByRole("switch", { name: "Use post attachments", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(threadsPanel.getByRole("textbox")).toHaveValue("Threads-only caption");

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, credentials);
  await waitForWorkspace(secondPage);
  await activeBrandProfileName(secondPage, profileName);
  await editPostFromRow(secondPage, secondPage.getByRole("row").filter({ hasText: savedPreview }));
  await expect(composerTextarea(secondPage)).toHaveValue(caption);
  await expectAttachmentPhases(secondPage, [
    [gif.name, "1. "],
    [png.name, "2. "],
  ]);
  await expect(
    secondPage.getByRole("region", { name: threads, exact: true }).getByRole("textbox"),
  ).toHaveValue("Threads-only caption");
  await second.close();
});

test("reopens a draft whose provider options have no distribution", async ({ page, request }) => {
  test.slow();
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [channel] = await attachChannels(page, request, profileName, ["instagram"]);
  await presentChannelAsProvider(page, channel, "youtube");
  await reloadWithScopedProfile(page);
  await openComposer(page);

  const { mutations, waitForSaveAfter } = await watchPostMutations(page);
  const title = "Title without a distribution";
  const tags = "alpha, beta";
  const channelPanel = page.getByRole("region", { name: channel, exact: true });
  await channelPanel.getByPlaceholder(/enter youtube title/i).fill(title);
  await channelPanel.getByPlaceholder(/tech, tutorial/i).fill(tags);
  const caption = "Provider options without a distribution";
  await composerTextarea(page).fill(caption);
  await saveDraft(page);

  const created = mutations[mutations.length - 1];
  expect(created.response.distributions).toEqual([]);
  expect(created.request.targets?.[0]).toMatchObject({
    hashtags: ["alpha", "beta"],
    title_override: title,
  });
  expect(created.response.targets[0]).toMatchObject({
    hashtags: ["alpha", "beta"],
    title_override: title,
  });

  await reloadWithScopedProfile(page);
  await editPostFromRow(
    page,
    page.getByRole("row").filter({ hasText: created.response.id.slice(-6) }),
  );
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(channelPanel.getByPlaceholder(/enter youtube title/i)).toHaveValue(title);
  await expect(channelPanel.getByPlaceholder(/tech, tutorial/i)).toHaveValue(tags);

  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForSaveAfter(beforeSave);
  expect(mutations[mutations.length - 1].request.targets?.[0]).toMatchObject({
    hashtags: ["alpha", "beta"],
    title_override: title,
  });
});

test("keeps an enabled but blank channel caption blank across saves", async ({ page, request }) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [channel] = await attachChannels(page, request, profileName, ["threads"]);
  await openComposer(page);

  const { mutations, waitForSaveAfter } = await watchPostMutations(page);
  const caption = "Blank override journey";
  await composerTextarea(page).fill(caption);
  const channelPanel = page.getByRole("region", { name: channel, exact: true });
  const override = channelPanel.getByRole("textbox");
  await expect(override).toHaveValue(caption);
  await override.fill("");
  await saveDraft(page);

  const saved = mutations[mutations.length - 1];
  expect(saved.request.targets?.[0]?.description_override).toBe("");
  expect(saved.response.targets[0]?.description_override).toBe("");

  await reloadWithScopedProfile(page);
  await editPostFromRow(
    page,
    page.getByRole("row").filter({ hasText: saved.response.id.slice(-6) }),
  );
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(channelPanel.getByRole("button", { name: /remove custom override/i })).toBeVisible();
  await expect(override).toHaveValue("");

  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForSaveAfter(beforeSave);
  expect(mutations[mutations.length - 1].request.targets?.[0]?.description_override).toBe("");
});

test("keeps the composer operable on a narrow screen with the keyboard", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);
  const caption = "Narrow viewport keyboard journey";
  await composerTextarea(page).fill(caption);
  await saveAndSettle(page, [
    [png.name, "Ready"],
    [gif.name, "Ready"],
  ]);

  const moveEarlier = page.getByRole("button", { name: "Move attachment 2 earlier" });
  await moveEarlier.focus();
  await expect(moveEarlier).toBeFocused();
  await page.keyboard.press("Enter");
  await expectAttachmentPhases(page, [
    [gif.name, "1. "],
    [png.name, "2. "],
  ]);

  const remove = page.getByRole("button", { name: "Remove attachment 1" });
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(attachmentStrip(page, gif.name)).toHaveCount(0);
  await expect(composerTextarea(page)).toHaveValue(caption);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("has no Media navigation and treats /media as an unknown route", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);

  await expect(page.getByRole("button", { name: /media library/i })).toHaveCount(0);
  await page.goto("/media");
  await expect(page).toHaveURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await waitForWorkspace(page);
});

test("previews a camera-codec QuickTime upload as playable video and downloads the original MOV", async ({
  page,
  request,
}) => {
  await openIsolatedOwnerWorkspace(page);

  const previewRequests: Promise<{ headers: Record<string, string>; url: string }>[] = [];
  page.on("request", (apiRequest) => {
    if (/\/api\/v1\/assets\/[^/]+\/preview-url$/.test(new URL(apiRequest.url()).pathname)) {
      previewRequests.push(
        apiRequest.allHeaders().then((headers) => ({ headers, url: apiRequest.url() })),
      );
    }
  });

  await openComposer(page);

  const mov = quickTimeFixture();
  const png = pngFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: mov.mimeType, name: mov.name, buffer: mov.buffer },
  ]);
  await composerTextarea(page).fill("Camera codec preview journey");

  await saveAndSettle(page, [
    [png.name, "Ready"],
    [mov.name, "Ready"],
  ]);

  const video = attachmentPreview(page, mov.name);
  await expect(video).toHaveJSProperty("tagName", "VIDEO", { timeout: processingTimeoutMs });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      timeout: processingTimeoutMs,
    })
    .toBeGreaterThanOrEqual(1);

  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth))
    .toBeGreaterThan(0);

  const previewUrl = await video.evaluate(
    (element: HTMLVideoElement) => element.currentSrc || element.src,
  );
  const preview = await request.get(previewUrl);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toContain("video/mp4");
  const previewBytes = await preview.body();
  expect(previewBytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
  expect(previewBytes.equals(mov.buffer)).toBe(false);

  const photo = attachmentPreview(page, png.name);
  await expect(photo).toHaveJSProperty("tagName", "IMG", { timeout: processingTimeoutMs });
  await expect
    .poll(() => photo.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();
  await expectAttachmentPhases(page, [
    [mov.name, "1. "],
    [png.name, "2. "],
  ]);
  await page.getByRole("button", { name: "Remove attachment 2" }).click();
  await expect(attachmentStrip(page, png.name)).toHaveCount(0);
  await expect(attachmentStrip(page, mov.name)).toContainText("1. ");

  const scopes = await Promise.all(previewRequests);
  const assets = await Promise.all(
    scopes.map(async (scope) => {
      const assetUrl = scope.url.replace(/\/preview-url$/, "");
      const response = await request.get(assetUrl, { headers: scope.headers });
      expect(response.status()).toBe(200);
      return {
        asset: (await response.json()) as { asset_type: string; mime_type: string | null },
        headers: scope.headers,
        url: assetUrl,
      };
    }),
  );
  const camera = assets.find((entry) => entry.asset.mime_type === "video/quicktime");
  if (!camera) {
    throw new Error(`no QuickTime asset among ${assets.length} composer preview scopes`);
  }
  expect(camera.asset.asset_type).toBe("video");
  const signed = await request.get(`${camera.url}/download-url`, { headers: camera.headers });
  expect(signed.status()).toBe(200);
  const { url: downloadUrl } = (await signed.json()) as { url: string };
  const download = await request.get(downloadUrl);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain(`filename="${mov.name}"`);
  expect(download.headers()["content-type"]).toContain("application/octet-stream");
  expect((await download.body()).equals(mov.buffer)).toBe(true);
  const tampered = new URL(downloadUrl);
  tampered.searchParams.set("response-content-disposition", 'attachment; filename="forged.mov"');
  const denied = await request.get(tampered.toString());
  expect(denied.status()).toBe(403);
  expect(denied.headers()["content-disposition"]).toBeUndefined();
});
