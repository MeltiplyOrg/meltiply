import { Buffer } from "node:buffer";

import type { components } from "@meltiply/contracts/schema";
import { PLATFORM_IDS } from "@meltiply/domain";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

import {
  acceptanceApiUrl,
  configurePublishingQueue,
  activeBrandProfileName,
  controlledProviderAccountId,
  closeComposer,
  editPostFromRow,
  provisionControlledChannels,
  readControlledMedia,
  readControlledPublications,
  readLiveControlledCopies,
  scriptControlledFailures,
  type ControlledChannelSpec,
  type ControlledPublication,
} from "./publication-fixtures";
import {
  attachmentControlName,
  attachmentTitle,
  publicationVideoFixture,
  pngFixture,
  type MediaFixture,
} from "./media-fixtures";
import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

test.use({ screenshot: "only-on-failure", trace: "retain-on-failure" });
test.setTimeout(600_000);

const imageAttachment = pngFixture();
const videoAttachment = publicationVideoFixture();

const channelNames = {
  instagram: "Acceptance Reels",
  threads: "Acceptance Threads",
} as const;

interface AcceptanceChannels {
  instagram: ControlledChannelSpec;
  threads: ControlledChannelSpec;
}

function acceptanceChannels(): AcceptanceChannels {
  return {
    instagram: {
      displayName: channelNames.instagram,
      platform: "instagram",
      providerUserId: controlledProviderAccountId("instagram"),
    },
    threads: {
      displayName: channelNames.threads,
      platform: "threads",
      providerUserId: controlledProviderAccountId("threads"),
    },
  };
}

async function attachChannels(
  page: Page,
  request: APIRequestContext,
  profileName: string,
  channels: readonly ControlledChannelSpec[],
): Promise<void> {
  await provisionControlledChannels(request, profileName, channels);
  await page.reload();
  await waitForWorkspace(page);
  await activeBrandProfileName(page);
}

async function openComposer(page: Page): Promise<void> {
  await page
    .locator("main header")
    .getByRole("button", { name: /create post/i })
    .click();
  await expect(page.getByRole("dialog", { name: "New Post", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function publishNow(page: Page): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Now", exact: true })
    .click();
  await page.getByRole("button", { name: "Publish Now", exact: true }).click();
}

async function returnToPosts(page: Page): Promise<void> {
  const submissions = page.getByRole("button", {
    name: /^(?:save(?: draft)?|schedule post|publish now)$/i,
  });
  await expect(submissions.and(page.locator(":disabled"))).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const composer = page.getByRole("dialog", { name: /^(?:new post|edit post)$/i });
  await composer.waitFor({ state: "hidden", timeout: 120_000 });
  await waitForWorkspace(page);
}

async function saveDraftAndLeave(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^(?:save|save draft)$/i }).click();
  await expect(page.getByText(/saved to your workspace at/i)).toBeVisible({
    timeout: 120_000,
  });
  await closeComposer(page);
  await waitForWorkspace(page);
}

function composerTextarea(page: Page) {
  return page.getByPlaceholder(/what do you want to publish/i);
}

async function reloadPostsWorkspace(page: Page): Promise<string> {
  await page.reload();
  await waitForWorkspace(page);
  return activeBrandProfileName(page);
}

async function targetOnlyChannel(page: Page, keep: string, drop: string): Promise<void> {
  const destinations = page.getByText(/^\d+ selected$/).locator("../../..");
  const selectedBadge = destinations.getByText(/^\d+ selected$/);
  await expect(selectedBadge).toBeVisible({ timeout: 30_000 });
  const keepDestination = destinations.getByRole("button", { name: new RegExp(keep) });
  const dropDestination = destinations.getByRole("button", { name: new RegExp(drop) });
  if ((await keepDestination.getAttribute("aria-pressed")) !== "true") {
    await keepDestination.click();
  }
  if ((await dropDestination.getAttribute("aria-pressed")) === "true") {
    await dropDestination.click();
  }
  await expect(destinations.getByText(/^1 selected$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(keepDestination).toHaveAttribute("aria-pressed", "true");
  await expect(dropDestination).toHaveAttribute("aria-pressed", "false");
}

async function attachMedia(page: Page, files: readonly MediaFixture[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(
    files.map((file) => ({
      buffer: Buffer.from(file.buffer),
      mimeType: file.mimeType,
      name: file.name,
    })),
  );
  for (const file of files) {
    await expect(
      page.getByRole("status").filter({ hasText: attachmentTitle(file.name) }),
    ).toContainText(/Ready$/, {
      timeout: 300_000,
    });
  }
}

async function toggleChannelAttachment(
  page: Page,
  channelName: string,
  attachmentIndex: number,
  attachmentName: string,
): Promise<void> {
  await page
    .getByRole("region", { name: channelName, exact: true })
    .getByRole("button", {
      name: attachmentControlName(`${attachmentIndex}. `, attachmentName),
    })
    .click();
}

async function overrideChannelCaption(
  page: Page,
  channelName: string,
  caption: string,
): Promise<void> {
  const editor = page.getByRole("region", { name: channelName, exact: true });
  await editor
    .getByText(/custom text for/i)
    .locator("..")
    .getByRole("textbox")
    .fill(caption);
}

async function scheduleInMinutes(page: Page, minutesFromNow: number): Promise<void> {
  const when = new Date(Date.now() + minutesFromNow * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Schedule", exact: true })
    .click();
  const picker = page.getByRole("group", { name: "Date & time", exact: true });
  await picker.getByRole("button", { name: /^Date / }).click();
  await page
    .getByRole("button", {
      name: new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(when),
      exact: true,
    })
    .click();
  await picker.getByRole("button", { name: "Choose time", exact: true }).click();
  await page.getByRole("combobox", { name: "Hour", exact: true }).click();
  await page.getByRole("option", { name: pad(when.getHours()), exact: true }).click();
  await page.getByRole("combobox", { name: "Minute", exact: true }).click();
  await page.getByRole("option", { name: pad(when.getMinutes()), exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

async function filterPostsByStatus(page: Page, status: RegExp): Promise<void> {
  const disclosure = page.locator("summary").filter({ hasText: /^Filter/ });
  const panel = page.getByRole("group", { name: "Filters", exact: true });
  if ((await panel.count()) === 0) await disclosure.click();
  else if ((await panel.getAttribute("data-state")) !== "open") await disclosure.click();
  await expect(panel).toBeVisible();
  const addStatus = page.getByRole("button", { name: "Add Post status filter", exact: true });
  const removeStatus = page.getByRole("button", {
    name: "Remove Post status filter",
    exact: true,
  });
  if ((await removeStatus.count()) === 0) await addStatus.click();
  await expect(removeStatus).toBeVisible();
  const trigger = removeStatus.locator("..").locator('button[aria-haspopup="menu"]');
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Post status", exact: true });
  await menu.getByRole("menuitemcheckbox", { name: "All statuses", exact: true }).click();
  const option = menu.getByRole("menuitemcheckbox", { name: status });
  if (!(await option.isChecked())) await option.click();
  await expect(option).toBeChecked();
  await page.keyboard.press("Escape");
  if ((await panel.count()) > 0 && (await panel.getAttribute("data-state")) === "open") {
    await disclosure.click();
  }
  await expect(panel).toBeHidden();
}

async function clearPostStatusFilter(page: Page): Promise<void> {
  const disclosure = page.locator("summary").filter({ hasText: /^Filter/ });
  const panel = page.getByRole("group", { name: "Filters", exact: true });
  if ((await panel.count()) === 0) await disclosure.click();
  else if ((await panel.getAttribute("data-state")) !== "open") await disclosure.click();
  await expect(panel).toBeVisible();
  const removeStatus = page.getByRole("button", {
    name: "Remove Post status filter",
    exact: true,
  });
  if ((await removeStatus.count()) > 0) await removeStatus.click();
  await expect(removeStatus).toHaveCount(0);
  if ((await panel.count()) > 0 && (await panel.getAttribute("data-state")) === "open") {
    await disclosure.click();
  }
  await expect(panel).toBeHidden();
}

async function waitForPostUnderStatus(
  page: Page,
  caption: string | RegExp,
  status: RegExp,
  timeout = 240_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const scopedCollection = page.waitForResponse(
          (response) =>
            response.url().includes("/api/v1/posts?") &&
            response.url().includes("brand_profile_id=") &&
            response.request().method() === "GET" &&
            response.status() === 200,
          { timeout: 30_000 },
        );
        await reloadPostsWorkspace(page);
        await scopedCollection;
        await filterPostsByStatus(page, status);
        return page
          .getByRole("row")
          .filter({ hasText: caption })
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
      },
      { intervals: [3_000, 5_000, 8_000], timeout },
    )
    .toBe(true);
  await clearPostStatusFilter(page);
}

async function waitForLiveCopyCount(
  request: APIRequestContext,
  accountId: string,
  count: number,
  timeout = 240_000,
): Promise<void> {
  await expect
    .poll(async () => (await readLiveControlledCopies(request, accountId)).length, {
      intervals: [1_000, 2_000, 4_000, 6_000],
      timeout,
    })
    .toBe(count);
}

async function readChannelLiveCopies(
  request: APIRequestContext,
  channels: AcceptanceChannels,
): Promise<[ControlledPublication[], ControlledPublication[]]> {
  return Promise.all([
    readLiveControlledCopies(request, channels.instagram.providerUserId),
    readLiveControlledCopies(request, channels.threads.providerUserId),
  ]);
}

async function openPostDetails(page: Page, caption: string | RegExp) {
  await page.getByRole("row").filter({ hasText: caption }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

async function closePostDetails(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: /^close$/i })
    .first()
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function captionsInReadingOrder(
  page: Page | Locator,
  captions: readonly string[],
): Promise<string[]> {
  let placed: { caption: string; box: { x: number; y: number } | null }[] = [];
  await expect
    .poll(
      async () => {
        placed = await Promise.all(
          captions.map(async (caption) => ({
            box: await page
              .getByText(caption, { exact: true })
              .filter({ visible: true })
              .first()
              .boundingBox(),
            caption,
          })),
        );
        return placed.every((entry) => entry.box !== null);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return placed
    .sort((left, right) => {
      const rowDelta = Math.round(left.box!.y / 40) - Math.round(right.box!.y / 40);
      return rowDelta !== 0 ? rowDelta : left.box!.x - right.box!.x;
    })
    .map((entry) => entry.caption);
}

test("publishes one Post to multiple Channels with independent outcomes, media, and timestamps", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);
  await scriptControlledFailures(request, channels.threads.providerUserId, 1);

  const sharedCaption = `Shared launch caption ${Date.now()}`;
  const threadsCaption = `Threads-only caption ${Date.now()}`;
  const postCaption = new RegExp(`(?:${sharedCaption}|${threadsCaption})`);

  await openComposer(page);
  await expect(page.getByText(/targeting 2 channel\(s\)/i)).toBeVisible({
    timeout: 30_000,
  });
  await composerTextarea(page).fill(sharedCaption);
  await attachMedia(page, [imageAttachment, videoAttachment]);
  await toggleChannelAttachment(page, channelNames.instagram, 1, imageAttachment.name);
  await toggleChannelAttachment(page, channelNames.threads, 2, videoAttachment.name);
  await overrideChannelCaption(page, channelNames.threads, threadsCaption);
  await publishNow(page);
  await returnToPosts(page);

  await waitForPostUnderStatus(page, postCaption, /^published$/i);
  await waitForPostUnderStatus(page, postCaption, /^failed$/i);

  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 1);
  const instagramCopy = (
    await readLiveControlledCopies(request, channels.instagram.providerUserId)
  )[0]!;
  expect(instagramCopy.caption).toBe(sharedCaption);
  expect(instagramCopy.media).toHaveLength(1);
  expect(instagramCopy.media[0]!.contentType).toBe("video/mp4");
  expect(instagramCopy.media[0]!.fileSize).toBeGreaterThan(0);

  const instagramMedia = await readControlledMedia(request, {
    accountId: channels.instagram.providerUserId,
    index: 0,
    publicationId: instagramCopy.publicationId,
  });
  expect(instagramMedia.bytes.byteLength).toBe(instagramCopy.media[0]!.fileSize);
  expect(instagramMedia.computedChecksum).toBe(instagramCopy.media[0]!.checksum);
  expect(instagramMedia.recordedChecksum).toBe(instagramCopy.media[0]!.checksum);

  expect(await readControlledPublications(request, channels.threads.providerUserId)).toEqual([]);

  const detail = await openPostDetails(page, postCaption);
  await expect(detail.getByText(postCaption)).toBeVisible();
  await expect(
    detail
      .getByRole("article", { name: channelNames.instagram, exact: true })
      .getByText("Published", { exact: true }),
  ).toBeVisible();
  await expect(
    detail
      .getByRole("article", { name: channelNames.threads, exact: true })
      .getByText("Failed", { exact: true }),
  ).toBeVisible();
  const firstPublishedStamp = await detail
    .getByRole("article", { name: channelNames.instagram, exact: true })
    .locator("dt")
    .filter({ hasText: /^Published:$/ })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
  expect(firstPublishedStamp.trim()).not.toBe("");

  await detail.getByRole("button", { name: /^retry$/i }).click();
  await closePostDetails(page);

  await waitForLiveCopyCount(request, channels.threads.providerUserId, 1);
  const threadsCopy = (
    await readLiveControlledCopies(request, channels.threads.providerUserId)
  )[0]!;
  expect(threadsCopy.caption).toBe(threadsCaption);
  expect(threadsCopy.media).toHaveLength(1);
  expect(threadsCopy.media[0]!.contentType).toMatch(/^image\/(?:jpeg|png)$/);
  const threadsMedia = await readControlledMedia(request, {
    accountId: channels.threads.providerUserId,
    index: 0,
    publicationId: threadsCopy.publicationId,
  });
  expect(threadsMedia.computedChecksum).toBe(threadsCopy.media[0]!.checksum);

  expect(await readLiveControlledCopies(request, channels.instagram.providerUserId)).toEqual([
    instagramCopy,
  ]);
  expect(Date.parse(threadsCopy.publishedAt) >= Date.parse(instagramCopy.publishedAt)).toBe(true);

  await waitForPostUnderStatus(page, postCaption, /^published$/i);
  const converged = await openPostDetails(page, postCaption);
  await expect(converged.getByRole("article").getByText("Published", { exact: true })).toHaveCount(
    2,
  );
  await expect(converged.getByRole("article").getByText("Failed", { exact: true })).toHaveCount(0);
  expect(
    await converged
      .getByRole("article", { name: channelNames.instagram, exact: true })
      .locator("dt")
      .filter({ hasText: /^Published:$/ })
      .locator("xpath=following-sibling::dd[1]")
      .innerText(),
  ).toBe(firstPublishedStamp);
  await expect(
    converged
      .getByRole("article", { name: channelNames.threads, exact: true })
      .getByText("Published", { exact: true }),
  ).toBeVisible();
});

test("shows the same Post and order in Table, Grid, Calendar, and Details", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);
  const captions = [
    `Alpha acceptance scheduled ${Date.now()}`,
    `Bravo acceptance scheduled ${Date.now()}`,
    `Charlie acceptance scheduled ${Date.now()}`,
  ];

  for (const [index, caption] of captions.entries()) {
    await openComposer(page);
    await composerTextarea(page).fill(caption);
    await targetOnlyChannel(page, "Acceptance Threads", "Acceptance Reels");
    await scheduleInMinutes(page, 30 + index);
    await page.getByRole("button", { name: "Schedule Post", exact: true }).click();
    await returnToPosts(page);
  }

  await expect(page.getByText(captions[0]!, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: /^sort:/i }).click();
  await page.getByRole("menuitem", { name: "Time: Oldest first", exact: true }).click();
  expect(await captionsInReadingOrder(page, captions)).toEqual(captions);

  await page.getByRole("radio", { name: /^grid$/i }).click();
  await expect(page.getByText(captions[0]!, { exact: true })).toBeVisible();
  expect(await captionsInReadingOrder(page, captions)).toEqual(captions);

  await page.getByRole("radio", { name: /^calendar$/i }).click();
  await page
    .getByRole("group")
    .filter({ has: page.getByText(captions[0]!, { exact: true }) })
    .getByRole("button", { name: /^View posts on / })
    .click();
  const calendarDay = page.getByRole("dialog");
  await expect(calendarDay).toBeVisible();
  expect(await captionsInReadingOrder(calendarDay, captions)).toEqual(captions);
  await closePostDetails(page);

  await page
    .getByRole("radiogroup", { name: "Post view", exact: true })
    .getByRole("radio", { name: /^table$/i })
    .click();
  await expect(page.getByText(captions[0]!, { exact: true })).toBeVisible();
  expect(await captionsInReadingOrder(page, captions)).toEqual(captions);

  const detail = await openPostDetails(page, captions[1]!);
  await expect(detail.getByText(captions[1]!, { exact: true })).toBeVisible();
  await closePostDetails(page);

  const reopened = await openPostDetails(page, captions[1]!);
  await expect(reopened.getByText(captions[1]!, { exact: true })).toBeVisible();
});

test("keeps separately created identical Posts distinct and publishes only the one that was asked", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);

  const caption = `Identical acceptance caption ${Date.now()}`;
  for (const _attempt of [1, 2]) {
    await openComposer(page);
    await targetOnlyChannel(page, channelNames.threads, channelNames.instagram);
    await composerTextarea(page).fill(caption);
    await saveDraftAndLeave(page);
  }

  const rows = page.getByRole("row").filter({ hasText: caption });
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  const recordIds = await rows.evaluateAll((elements) =>
    elements.map(
      (element) =>
        [...element.querySelectorAll("span[title]")]
          .map((span) => span.getAttribute("title") ?? "")
          .find((title) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(title)) ?? "",
    ),
  );
  expect(new Set(recordIds).size).toBe(2);

  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 0);
  await waitForLiveCopyCount(request, channels.threads.providerUserId, 0);

  await editPostFromRow(page, rows.first());
  await expect(page.getByRole("dialog", { name: "Edit post", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await publishNow(page);
  await returnToPosts(page);

  await waitForLiveCopyCount(request, channels.threads.providerUserId, 1);
  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 0);
  const [, threadsLive] = await readChannelLiveCopies(request, channels);
  expect(threadsLive).toHaveLength(1);
  expect(threadsLive[0]!.caption).toBe(caption);
  expect(threadsLive[0]!.media).toEqual([]);

  await filterPostsByStatus(page, /^drafts$/i);
  await expect(page.getByRole("row").filter({ hasText: caption })).toHaveCount(1, {
    timeout: 180_000,
  });
  await clearPostStatusFilter(page);
});

test("edits a scheduled target without publishing it and preserves prior platform copies", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);

  const publishedCaption = `History caption ${Date.now()}`;
  await openComposer(page);
  await expect(page.getByText(/targeting 2 channel\(s\)/i)).toBeVisible({
    timeout: 30_000,
  });
  await targetOnlyChannel(page, channelNames.instagram, channelNames.threads);
  await composerTextarea(page).fill(publishedCaption);
  await attachMedia(page, [videoAttachment]);
  await publishNow(page);
  await returnToPosts(page);

  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 1);
  await waitForLiveCopyCount(request, channels.threads.providerUserId, 0);
  const historyBefore = await readChannelLiveCopies(request, channels);
  expect(historyBefore[0][0]!.caption).toBe(publishedCaption);
  expect(historyBefore[0][0]!.media).toHaveLength(1);

  const pendingCaption = `Pending caption ${Date.now()}`;
  const pendingEditCaption = `Pending caption edited ${Date.now()}`;
  await openComposer(page);
  await targetOnlyChannel(page, channelNames.threads, channelNames.instagram);
  await composerTextarea(page).fill(pendingCaption);
  await attachMedia(page, [videoAttachment]);
  await scheduleInMinutes(page, 180);
  await page.getByRole("button", { name: "Schedule Post", exact: true }).click();
  await returnToPosts(page);

  await waitForPostUnderStatus(page, pendingCaption, /^scheduled$/i);

  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);

  await editPostFromRow(page, page.getByRole("row").filter({ hasText: pendingCaption }));
  await expect(page.getByRole("dialog", { name: "Edit post", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await composerTextarea(page).fill(pendingEditCaption);
  await expect(page.getByRole("radio", { name: "Schedule", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Schedule Post", exact: true }).click();
  await returnToPosts(page);

  await waitForPostUnderStatus(page, pendingEditCaption, /^scheduled$/i);
  const editedDetail = await openPostDetails(page, pendingEditCaption);
  await expect(editedDetail.getByText(pendingEditCaption, { exact: true })).toBeVisible();
  await expect(
    editedDetail
      .getByRole("article", { name: channelNames.threads, exact: true })
      .getByText("Scheduled", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await closePostDetails(page);

  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);

  const deleteDetail = await openPostDetails(page, pendingEditCaption);
  await deleteDetail.getByRole("button", { name: "Delete post", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: /^keep post$/i }).click();
  await expect(confirmation).toBeHidden({ timeout: 30_000 });
  await expect(deleteDetail).toBeVisible({ timeout: 30_000 });

  await deleteDetail.getByRole("button", { name: "Delete post", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^delete post$/i })
    .click();

  await expect
    .poll(
      async () => {
        await reloadPostsWorkspace(page);
        return page.getByRole("row").filter({ hasText: pendingEditCaption }).count();
      },
      { intervals: [3_000, 5_000, 8_000], timeout: 180_000 },
    )
    .toBe(0);
  await expect(page.getByRole("row").filter({ hasText: publishedCaption })).toHaveCount(1, {
    timeout: 60_000,
  });

  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 1);
  await waitForLiveCopyCount(request, channels.threads.providerUserId, 0);
  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);
});

test("preserves provider choices through drafts and publishes photo and video targets safely", async ({
  page,
  request,
}, testInfo) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const youtube: ControlledChannelSpec = {
    displayName: "Acceptance YouTube",
    platform: "youtube",
    providerUserId: controlledProviderAccountId("youtube"),
  };
  const tiktok: ControlledChannelSpec = {
    displayName: "Acceptance TikTok",
    platform: "tiktok",
    providerUserId: controlledProviderAccountId("tiktok"),
  };
  await attachChannels(page, request, profileName, [youtube, tiktok]);
  await openComposer(page);
  const caption = `Provider settings ${Date.now()}`;
  const savedRow = page.getByRole("row").filter({ has: page.getByTitle("View details") });
  await composerTextarea(page).fill(caption);
  await attachMedia(page, [imageAttachment, videoAttachment]);
  await toggleChannelAttachment(page, youtube.displayName, 1, imageAttachment.name);
  await toggleChannelAttachment(page, tiktok.displayName, 2, videoAttachment.name);
  const youtubePanel = page.getByRole("region", { name: youtube.displayName, exact: true });
  const tiktokPanel = page.getByRole("region", { name: tiktok.displayName, exact: true });
  await youtubePanel.getByRole("textbox", { name: /Video Title/ }).fill("A deliberate video title");
  await expect(
    youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }),
  ).toContainText("Choose visibility");
  await saveDraftAndLeave(page);
  await reloadPostsWorkspace(page);
  await editPostFromRow(page, savedRow);
  await expect(
    youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }),
  ).toContainText("Choose visibility");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await youtubePanel
        .getByRole("combobox", { name: "Visibility", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`unanswered-visibility-${width}-${colorScheme}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }).click();
  await page.getByRole("option", { name: "Unlisted", exact: true }).click();
  await expect(
    tiktokPanel.getByText("Posting as Acceptance TikTok creator", { exact: true }),
  ).toBeVisible();
  await expect(tiktokPanel.getByRole("switch", { name: "Duet", exact: true })).toHaveCount(0);
  await expect(tiktokPanel.getByRole("switch", { name: "Stitch", exact: true })).toHaveCount(0);
  await expect(
    tiktokPanel.getByRole("switch", { name: "Comments", exact: true }),
  ).not.toBeChecked();
  await tiktokPanel.getByRole("combobox", { name: "Privacy Level", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option", { name: "Public to Everyone", exact: true }).click();
  await tiktokPanel
    .getByRole("switch", { name: "Disclose commercial content", exact: true })
    .click();

  await saveDraftAndLeave(page);
  await reloadPostsWorkspace(page);
  await expect(savedRow).toHaveCount(1);
  await editPostFromRow(page, savedRow);
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect
    .soft(youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }))
    .toContainText("Unlisted");
  await expect(
    youtubePanel.getByRole("combobox", { name: "Made for kids", exact: true }),
  ).toContainText("Choose an audience");
  await expect
    .soft(tiktokPanel.getByRole("switch", { name: "Disclose commercial content", exact: true }))
    .toBeChecked();
  await expect(
    tiktokPanel.getByRole("switch", { name: "Brand Content", exact: true }),
  ).not.toBeChecked();
  await youtubePanel.getByRole("combobox", { name: "Made for kids", exact: true }).click();
  await page.getByRole("option", { name: "No, not made for kids", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Now", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Publish Now", exact: true })).toBeDisabled();
  await tiktokPanel.getByRole("switch", { name: "Brand Content", exact: true }).click();
  await expect(
    tiktokPanel.getByRole("link", { name: "Branded Content Policy", exact: true }),
  ).toHaveAttribute("href", "https://www.tiktok.com/legal/page/global/bc-policy/en");
  await expect(
    tiktokPanel.getByRole("link", { name: "Music Usage Confirmation", exact: true }),
  ).toHaveAttribute("href", "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en");
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Draft", exact: true })
    .click();
  await saveDraftAndLeave(page);
  await reloadPostsWorkspace(page);
  await expect(savedRow).toHaveCount(1);
  await editPostFromRow(page, savedRow);
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(
    youtubePanel.getByRole("combobox", { name: "Made for kids", exact: true }),
  ).toContainText("No");
  await expect(
    youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }),
  ).toContainText("Unlisted");
  await expect(
    tiktokPanel.getByRole("switch", { name: "Brand Content", exact: true }),
  ).toBeChecked();
  await expect(
    tiktokPanel.getByRole("switch", { name: "Comments", exact: true }),
  ).not.toBeChecked();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await tiktokPanel
        .getByRole("combobox", { name: "Privacy Level", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`publishing-${width}-${colorScheme}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Now", exact: true })
    .click();
  await page.getByRole("button", { name: "Publish Now", exact: true }).click();
  await returnToPosts(page);
  await waitForLiveCopyCount(request, youtube.providerUserId, 1);
  await waitForLiveCopyCount(request, tiktok.providerUserId, 1);
  const [videoCopy] = await readLiveControlledCopies(request, youtube.providerUserId);
  const [photoCopy] = await readLiveControlledCopies(request, tiktok.providerUserId);
  expect(videoCopy!.providerOptions).toMatchObject({
    youtube: { madeForKids: false, privacyStatus: "unlisted" },
  });
  expect(photoCopy!.providerOptions).toMatchObject({
    tiktok: {
      privacyLevel: "PUBLIC_TO_EVERYONE",
      brandContent: true,
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
    },
  });
  expect(photoCopy!.providerOptions).not.toHaveProperty("tiktok.discloseCommercialContent");
  expect(videoCopy!.media.map((item) => item.contentType)).toEqual(["video/mp4"]);
  expect(photoCopy!.media).toHaveLength(1);
  expect(photoCopy!.media[0]!.contentType).toMatch(/^image\/(?:jpeg|webp)$/);
});

test("delivers video to every Platform through Now, Schedule, and Queue", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(900_000);
  type Post = components["schemas"]["Post"];
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = [...PLATFORM_IDS].sort().map((platform) => ({
    displayName: `Video acceptance ${platform}`,
    platform,
    providerUserId: controlledProviderAccountId(platform),
  }));
  await attachChannels(page, request, profileName, channels);
  const queueName = `Video Queue ${Date.now()}`;
  const submissions: { mode: string; post: Post; caption: string; response: Response }[] = [];

  for (const mode of ["Now", "Schedule", "Queue"] as const) {
    const queueInstant =
      mode === "Queue" ? new Date(Math.ceil((Date.now() + 300_000) / 60_000) * 60_000) : null;
    if (queueInstant) {
      await configurePublishingQueue(page, profileName, queueName, [queueInstant]);
      await page.goto("/posts");
      await waitForWorkspace(page);
      await activeBrandProfileName(page, profileName);
    }
    await openComposer(page);
    const caption = `Video ${mode} ${Date.now()}`;
    await composerTextarea(page).fill(caption);
    await attachMedia(page, [videoAttachment]);
    const youtubePanel = page.getByRole("region", {
      name: "Video acceptance youtube",
      exact: true,
    });
    await youtubePanel.getByRole("textbox", { name: /Video Title/ }).fill(caption);
    await youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }).click();
    await page.getByRole("option", { name: "Unlisted", exact: true }).click();
    await youtubePanel.getByRole("combobox", { name: "Made for kids", exact: true }).click();
    await page.getByRole("option", { name: "No, not made for kids", exact: true }).click();
    const tiktokPanel = page.getByRole("region", { name: "Video acceptance tiktok", exact: true });
    await expect(
      tiktokPanel.getByText("Posting as Acceptance TikTok creator", { exact: true }),
    ).toBeVisible();
    await tiktokPanel.getByRole("combobox", { name: "Privacy Level", exact: true }).click();
    await page.getByRole("option", { name: "Public to Everyone", exact: true }).click();
    await expect(
      tiktokPanel.getByRole("switch", { name: "Comments", exact: true }),
    ).not.toBeChecked();
    await expect(tiktokPanel.getByRole("switch", { name: "Duet", exact: true })).not.toBeChecked();
    await expect(tiktokPanel.getByRole("switch", { name: "Stitch", exact: true })).toBeDisabled();
    await tiktokPanel.getByRole("switch", { name: "Comments", exact: true }).click();
    await tiktokPanel.getByRole("switch", { name: "Duet", exact: true }).click();
    const facebookPanel = page.getByRole("region", {
      name: "Video acceptance facebook",
      exact: true,
    });
    await facebookPanel.getByRole("combobox", { name: "Visibility", exact: true }).click();
    await expect(page.getByRole("option")).toHaveText(["Public"]);
    await page.getByRole("option", { name: "Public", exact: true }).click();
    await expect(
      facebookPanel.getByText("This Reel will be shared publicly on your Facebook Page.", {
        exact: true,
      }),
    ).toBeVisible();
    const draftSaved = page.waitForResponse(
      (response) =>
        /\/api\/v1\/posts(?:\/[^/]+)?$/.test(response.url()) &&
        ["POST", "PATCH"].includes(response.request().method()),
    );
    await saveDraftAndLeave(page);
    const draftResponse = await draftSaved;
    expect(draftResponse.status(), await draftResponse.text()).toBeLessThan(300);
    const draft: Post = await draftResponse.json();
    if (mode === "Now") {
      const restored = await request.patch(
        `${new URL(draftResponse.url()).origin}/api/v1/posts/${draft.id}`,
        {
          headers: {
            Authorization: (await draftResponse.request().allHeaders())["authorization"]!,
            "Idempotency-Key": `acceptance-retain-interactions-${draft.id}`,
          },
          data: {
            brand_profile_id: draft.brand_profile_id,
            targets: draft.targets.map((target) => ({
              ...target,
              provider_options: target.provider_options?.tiktok
                ? { tiktok: { ...target.provider_options.tiktok, allow_stitch: true } }
                : (target.provider_options ?? {}),
            })),
          },
        },
      );
      expect(restored.status(), await restored.text()).toBe(200);
    }
    await reloadPostsWorkspace(page);
    await editPostFromRow(page, page.getByRole("row").filter({ hasText: caption }));
    await expect(
      youtubePanel.getByRole("combobox", { name: "Visibility", exact: true }),
    ).toContainText("Unlisted");
    await expect(tiktokPanel.getByRole("switch", { name: "Comments", exact: true })).toBeChecked();
    await expect(tiktokPanel.getByRole("switch", { name: "Duet", exact: true })).toBeChecked();
    if (mode === "Now") {
      await expect(tiktokPanel.getByRole("switch", { name: "Stitch", exact: true })).toBeDisabled();
      await expect(
        tiktokPanel.getByRole("switch", { name: "Stitch", exact: true }),
      ).not.toBeChecked();
      const retained = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/posts/${draft.id}`) && response.request().method() === "PATCH",
      );
      await saveDraftAndLeave(page);
      const retainedResponse = await retained;
      expect(retainedResponse.status(), await retainedResponse.text()).toBe(200);
      const retainedDraft: Post = await retainedResponse.json();
      expect(
        retainedDraft.targets.find((target) => target.provider_options?.tiktok)?.provider_options
          ?.tiktok?.allow_stitch,
      ).toBe(true);
      await reloadPostsWorkspace(page);
      await editPostFromRow(page, page.getByRole("row").filter({ hasText: caption }));
    }
    if (mode === "Now") {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          await facebookPanel
            .getByRole("combobox", { name: "Visibility", exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: testInfo.outputPath(`video-controls-${width}-${colorScheme}.png`),
            fullPage: true,
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (mode === "Schedule") await scheduleInMinutes(page, 2);
    else {
      await page
        .getByRole("radiogroup", { name: "Publishing", exact: true })
        .getByRole("radio", { name: mode, exact: true })
        .click();
    }
    if (mode === "Queue") {
      await page.getByRole("combobox", { name: "Publishing Queue", exact: true }).click();
      await page.getByRole("option", { name: queueName, exact: true }).click();
    }
    const submitted = page.waitForResponse(
      (response) =>
        /\/api\/v1\/posts\/[^/]+\/schedule$/.test(response.url()) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", {
        name:
          mode === "Now" ? "Publish Now" : mode === "Schedule" ? "Schedule Post" : "Add to Queue",
        exact: true,
      })
      .click();
    const response = await submitted;
    expect(response.status(), await response.text()).toBe(200);
    let post: Post = await response.json();
    await returnToPosts(page);
    expect(post.distributions.map((distribution) => distribution.platform).sort()).toEqual(
      [...PLATFORM_IDS].sort(),
    );
    if (queueInstant) expect(post.queue_membership?.assigned_at).toBe(queueInstant.toISOString());
    if (mode === "Schedule") {
      const instants = post.distributions.map((distribution) => distribution.scheduled_at);
      await reloadPostsWorkspace(page);
      await editPostFromRow(page, page.getByRole("row").filter({ hasText: caption }));
      await expect(page.getByRole("radio", { name: "Schedule", exact: true })).toBeChecked();
      await composerTextarea(page).fill(`${caption} edited`);
      const edited = page.waitForResponse(
        (result) =>
          result.url().endsWith(`/posts/${post.id}/schedule`) &&
          result.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Schedule Post", exact: true }).click();
      const result = await edited;
      expect(result.status(), await result.text()).toBe(200);
      post = await result.json();
      expect(post.distributions.map((distribution) => distribution.scheduled_at)).toEqual(instants);
      await returnToPosts(page);
    }
    submissions.push({ mode, post, caption, response });
  }
  const firstResponse = submissions[0]!.response;
  const apiOrigin = new URL(firstResponse.url()).origin;
  const headers = { Authorization: (await firstResponse.request().allHeaders())["authorization"]! };

  for (const channel of channels) {
    await expect
      .poll(async () =>
        (await readLiveControlledCopies(request, channel.providerUserId)).map(
          (copy) => copy.caption,
        ),
      )
      .toEqual([submissions[0]!.caption]);
  }
  const dueInstants = submissions
    .filter(({ mode }) => mode !== "Now")
    .flatMap(({ post }) =>
      post.distributions.map((distribution) => Date.parse(distribution.scheduled_at!)),
    );
  await expect
    .poll(
      async () => {
        if (Date.now() >= Math.min(...dueInstants)) {
          const tick = await request.post(acceptanceApiUrl("/__test__/automation/scheduled"), {
            headers,
            timeout: 120_000,
          });
          expect(tick.status(), await tick.text()).toBe(204);
        }
        const states: string[] = [];
        for (const { post } of submissions) {
          const response = await request.get(`${apiOrigin}/api/v1/posts/${post.id}`, { headers });
          expect(response.status()).toBe(200);
          const current: Post = await response.json();
          states.push(...current.distributions.map((distribution) => distribution.status));
        }
        return states;
      },
      { timeout: 540_000, intervals: [1000, 3000, 5000] },
    )
    .toEqual(Array.from({ length: 15 }, () => "published"));
  await reloadPostsWorkspace(page);
  for (const { caption } of submissions) {
    const detail = await openPostDetails(page, caption);
    for (const channel of channels) {
      await expect(
        detail
          .getByRole("article", { name: channel.displayName, exact: true })
          .getByText("Published", { exact: true }),
      ).toBeVisible();
    }
    await closePostDetails(page);
  }
  for (let index = 0; index < 2; index += 1) {
    const tick = await request.post(acceptanceApiUrl("/__test__/automation/scheduled"), {
      headers,
      timeout: 120_000,
    });
    expect(tick.status(), await tick.text()).toBe(204);
  }
  for (const channel of channels) {
    const copies = await readLiveControlledCopies(request, channel.providerUserId);
    expect(copies).toHaveLength(3);
    for (const { mode, post, caption } of submissions) {
      const copy = copies.find((value) => value.caption.includes(caption))!;
      expect(copy.media.map((item) => item.contentType)).toEqual(["video/mp4"]);
      const media = await readControlledMedia(request, {
        accountId: channel.providerUserId,
        index: 0,
        publicationId: copy.publicationId,
      });
      expect(media.computedChecksum).toBe(copy.media[0]!.checksum);
      expect(media.bytes.byteLength).toBe(copy.media[0]!.fileSize);
      if (mode !== "Now")
        expect(Date.parse(copy.publishedAt)).toBeGreaterThanOrEqual(
          Date.parse(post.distributions[0]!.scheduled_at!),
        );
      if (channel.platform === "youtube")
        expect(copy.providerOptions).toMatchObject({
          youtube: { madeForKids: false, privacyStatus: "unlisted" },
        });
      if (channel.platform === "tiktok")
        expect(copy.providerOptions).toMatchObject({
          tiktok: {
            privacyLevel: "PUBLIC_TO_EVERYONE",
            allowComment: true,
            allowDuet: true,
            allowStitch: false,
            musicUsageConfirmed: true,
          },
        });
    }
  }
});
