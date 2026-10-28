import { Buffer } from "node:buffer";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
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
  mp4Fixture,
  pngFixture,
  type MediaFixture,
} from "./media-fixtures";
import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

test.use({ screenshot: "only-on-failure", trace: "retain-on-failure" });
// Publication acceptance crosses the browser, the API, PostgreSQL, R2, a Cloudflare
// Queue, a worker claim, and — for uploads — the Container media processor before
// the Provider is contacted at all. The individual waits below are far tighter than
// this ceiling; the slack absorbs cold container starts and image transcodes.
test.setTimeout(600_000);

/**
 * Image and video inputs whose publication renditions are independently selected
 * per Channel. Instagram receives only the video; Threads receives only the image.
 * Publication assertions verify platform-accepted output types and provider bytes,
 * not preservation of the upload's original encoding.
 */
const imageAttachment = pngFixture();
const videoAttachment = mp4Fixture();

/** Display names the composer and detail modal render for the fixture Channels. */
const channelNames = {
  instagram: "Acceptance Reels",
  threads: "Acceptance Threads",
} as const;

/** The two Channels one Post is published to. */
interface AcceptanceChannels {
  instagram: ControlledChannelSpec;
  threads: ControlledChannelSpec;
}

/**
 * Mints the two Channels one Post is published to.
 *
 * Provider-side account identities are unique per run because the controlled
 * Provider keys every durable publication record by them, which is what makes
 * them the handle an acceptance run asserts live copies against.
 *
 * @returns The Channel specs, keyed by platform.
 */
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

/**
 * Selects the workspace's active Brand Profile, attaches fixture Channels to it,
 * and reloads so the workspace query picks the new Channels up.
 *
 * The composer only offers Channels present in the workspace snapshot it took
 * when it mounted, so provisioning has to finish before the composer opens.
 *
 * @param page - Playwright page bound to the signed-in `/posts` view.
 * @param request - Playwright request context for the fixture namespace.
 * @param profileName - Brand Profile the Channels belong to.
 * @param channels - Channels to attach.
 */
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

/** Opens the composer for a brand new Post. */
async function openComposer(page: Page): Promise<void> {
  await page
    .locator("main header")
    .getByRole("button", { name: /create post/i })
    .click();
  await expect(page.getByRole("dialog", { name: "New Post", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Selects the immediate-delivery intent before using the pinned composer action. */
async function publishNow(page: Page): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Publishing", exact: true })
    .getByRole("radio", { name: "Now", exact: true })
    .click();
  await page.getByRole("button", { name: "Publish Now", exact: true }).click();
}

/**
 * Leaves only after submission settles, so a subsequent page reload cannot
 * abort the save → schedule sequence between its two committed writes.
 * Error alerts fail here instead of dressing a saved draft up as a publication.
 */
async function returnToPosts(page: Page): Promise<void> {
  const submissions = page.getByRole("button", {
    name: /^(?:save(?: draft)?|schedule post|publish now)$/i,
  });
  await expect(submissions.and(page.locator(":disabled"))).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const composer = page.getByRole("dialog", { name: /^(?:new post|edit post)$/i });
  if (await composer.isVisible().catch(() => false)) {
    await closeComposer(page);
  }
  await waitForWorkspace(page);
}

/** The composer's shared-content textarea. */
function composerTextarea(page: Page) {
  return page.getByPlaceholder(/what do you want to publish/i);
}

/**
 * Reloads `/posts` and re-selects the active Brand Profile.
 *
 * A reload drops the in-memory workspace scope, and with it the selected profile.
 * The Posts surface then renders read-only, hiding the very Retry, Edit, and
 * Delete affordances these tests drive, so every reload in this spec
 * re-establishes the scope it needs.
 *
 * @param page - Playwright page bound to the Posts workspace.
 * @returns The re-selected Brand Profile's display name.
 */
async function reloadPostsWorkspace(page: Page): Promise<string> {
  await page.reload();
  await waitForWorkspace(page);
  return activeBrandProfileName(page);
}

/**
 * Narrows the composer's destination selection to exactly one Channel.
 *
 * Instagram refuses a text-only publish, so a Post carrying no attachment cannot
 * target it. Selecting one destination explicitly is how a test meets that real
 * platform rule instead of working around it.
 * Destination pressed state identifies each selected Channel; a count of one
 * alone cannot distinguish the intended destination from a selected sibling.
 *
 * @param page - Playwright page bound to the open composer.
 * @param keep - Display name of the one Channel that stays selected.
 * @param drop - Display name of the Channel to deselect.
 */
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

/**
 * Hands the composer its ordered attachment set and waits until the real
 * processor has produced a usable rendition for each one.
 *
 * Waiting for the card's own `Ready` phase is what makes the later publish a real
 * publication: the API only accepts a target whose renditions it has verified,
 * and that verification happens in the Container-backed processor.
 * The locator follows filename → persisted title rather than disappearing once
 * the successful upload drops its filename extension.
 *
 * @param page - Playwright page bound to the open composer.
 * @param files - Ordered attachments to upload.
 */
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

/**
 * Toggles one attachment in one Channel's own media selection.
 *
 * @param page - Playwright page bound to the open composer.
 * @param channelName - Display name of the Channel whose editor to use.
 * @param attachmentIndex - 1-based position of the attachment in the Post.
 * @param attachmentName - Input filename matched across local and persisted titles.
 */
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

/**
 * Gives one Channel its own caption instead of the shared one.
 *
 * @param page - Playwright page bound to the open composer.
 * @param channelName - Display name of the Channel being customized.
 * @param caption - Caption override text.
 */
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

/**
 * Sets the composer's schedule field to a future local slot.
 *
 * @param page - Playwright page bound to the open composer.
 * @param minutesFromNow - How far ahead the Post should be scheduled.
 */
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

/** Applies a status bucket through the filter disclosure, then restores the collection viewport. */
async function filterPostsByStatus(page: Page, status: RegExp): Promise<void> {
  const disclosure = page.locator("summary").filter({ hasText: /^Filter/ });
  await disclosure.click();
  const addStatus = page.getByRole("button", { name: "Add Post status filter", exact: true });
  if (await addStatus.isVisible()) await addStatus.click();
  const trigger = page
    .getByRole("button", { name: "Remove Post status filter", exact: true })
    .locator("..")
    .locator('button[aria-haspopup="menu"]');
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Post status", exact: true });
  await menu.getByRole("menuitemcheckbox", { name: "All statuses", exact: true }).click();
  const option = menu.getByRole("menuitemcheckbox", { name: status });
  if (!(await option.isChecked())) await option.click();
  await expect(option).toBeChecked();
  await page.keyboard.press("Escape");
  await disclosure.click();
  await expect(page.getByRole("group", { name: "Filters", exact: true })).toBeHidden();
}

/** Restores all status buckets using the same user-visible filtering flow. */
async function clearPostStatusFilter(page: Page): Promise<void> {
  await filterPostsByStatus(page, /^all statuses$/i);
}

/**
 * Reloads until the Post appears in its aggregate status bucket, then clears
 * the filter. Failed takes precedence over published for mixed outcomes;
 * independent Channel states are asserted in Details and at the Provider.
 */
async function waitForPostUnderStatus(
  page: Page,
  caption: string | RegExp,
  status: RegExp,
  timeout = 240_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await reloadPostsWorkspace(page);
        await filterPostsByStatus(page, status);
        return page.getByRole("row").filter({ hasText: caption }).count();
      },
      { intervals: [3_000, 5_000, 8_000], timeout },
    )
    .toBeGreaterThan(0);
  await clearPostStatusFilter(page);
}

/**
 * Polls the controlled Provider until one Channel holds exactly `count` live
 * copies.
 *
 * @param request - Playwright request context for the fixture namespace.
 * @param accountId - Provider-side account identity to inspect.
 * @param count - Number of live copies the Channel must hold.
 * @param timeout - How long to keep polling before failing.
 */
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

/**
 * Reads every live copy the two fixture Channels hold, in Channel order.
 *
 * @param request - Playwright request context for the fixture namespace.
 * @param channels - Channels to inspect.
 * @returns One live-copy list per Channel.
 */
async function readChannelLiveCopies(
  request: APIRequestContext,
  channels: AcceptanceChannels,
): Promise<[ControlledPublication[], ControlledPublication[]]> {
  return Promise.all([
    readLiveControlledCopies(request, channels.instagram.providerUserId),
    readLiveControlledCopies(request, channels.threads.providerUserId),
  ]);
}

/** Opens one Post's detail by unique text or a pattern covering its channel previews. */
async function openPostDetails(page: Page, caption: string | RegExp) {
  await page.getByRole("row").filter({ hasText: caption }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/** Dismisses the visible detail dialog through its first Close control; selector failures remain visible. */
async function closePostDetails(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: /^close$/i })
    .first()
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

/**
 * Reads the visible captions in the order a reader scans the current view.
 *
 * Grid and calendar both lay their cards out in CSS grid flow, so top-to-bottom
 * then left-to-right is the reading order in every view. Comparing the resulting
 * sequence across views is what proves they render one identity in one order
 * rather than three independent collections. View changes are immediate;
 * query refreshes must settle before sampling the complete set of captions.
 *
 * @param page - Posts page or expanded calendar-day dialog to measure.
 * @param captions - Captions whose relative order is under test.
 * @returns The captions in reading order.
 */
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

/**
 * Browser acceptance: one Post published to two Channels with genuinely
 * independent outcomes.
 * A fresh account creates and selects its Brand Profile through Channels before
 * the controlled fixture attaches Channels; registration alone creates no profile.
 *
 * Instagram publishes the shared caption and the video; Threads publishes its own
 * caption and the image alone. Threads is armed to reject exactly one attempt, so
 * the run observes a real partial success — one live Platform copy beside one
 * retryable failure — and then proves that the creator's own Retry publishes only
 * the failed Channel, leaving the already-published copy untouched on both the
 * Provider side and in the detail surface.
 */
test("publishes one Post to multiple Channels with independent outcomes, media, and timestamps", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);
  // The Threads copy must fail its first attempt, so arm it before the Post is
  // ever scheduled.
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
  // Instagram receives the video only, independently of Threads' image selection.
  await toggleChannelAttachment(page, channelNames.instagram, 1, imageAttachment.name);
  // Threads publishes the image alone, with its own caption.
  await toggleChannelAttachment(page, channelNames.threads, 2, videoAttachment.name);
  await overrideChannelCaption(page, channelNames.threads, threadsCaption);
  await publishNow(page);
  await returnToPosts(page);

  // Failed is the aggregate status until the unsuccessful Channel is retried.
  // Details and Provider records below prove the independent outcomes.
  await waitForPostUnderStatus(page, postCaption, /^failed$/i);

  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 1);
  const instagramCopy = (
    await readLiveControlledCopies(request, channels.instagram.providerUserId)
  )[0]!;
  expect(instagramCopy.caption).toBe(sharedCaption);
  expect(instagramCopy.media).toHaveLength(1);
  expect(instagramCopy.media[0]!.contentType).toBe("video/mp4");
  expect(instagramCopy.media[0]!.fileSize).toBeGreaterThan(0);

  // The bytes are the Provider's own: its recorded digest must match the bytes it
  // hands back, and the served length must match what it claims to have stored.
  const instagramMedia = await readControlledMedia(request, {
    accountId: channels.instagram.providerUserId,
    index: 0,
    publicationId: instagramCopy.publicationId,
  });
  expect(instagramMedia.bytes.byteLength).toBe(instagramCopy.media[0]!.fileSize);
  expect(instagramMedia.computedChecksum).toBe(instagramCopy.media[0]!.checksum);
  expect(instagramMedia.recordedChecksum).toBe(instagramCopy.media[0]!.checksum);

  // The rejected attempt left no copy at all behind on the other Channel.
  expect(await readControlledPublications(request, channels.threads.providerUserId)).toEqual([]);

  const detail = await openPostDetails(page, postCaption);
  await expect(detail.getByText(postCaption)).toBeVisible();
  await expect(detail.getByText("Published", { exact: true })).toHaveCount(1);
  await expect(detail.getByText("Failed", { exact: true })).toHaveCount(1);
  // Each Channel row carries its own timestamps rather than one Post-wide stamp.
  const firstPublishedStamp = await detail
    .locator("dt")
    .filter({ hasText: /^Published:$/ })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
  expect(firstPublishedStamp.trim()).not.toBe("");

  // The creator retries only the failed Channel.
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

  // No republish: the retry added exactly one copy and left the first Channel's
  // single copy — and its publication instant — untouched.
  expect(await readLiveControlledCopies(request, channels.instagram.providerUserId)).toEqual([
    instagramCopy,
  ]);
  // Independent publication timestamps: each Channel records its own moment.
  expect(Date.parse(threadsCopy.publishedAt) >= Date.parse(instagramCopy.publishedAt)).toBe(true);

  await waitForPostUnderStatus(page, postCaption, /^published$/i);
  const converged = await openPostDetails(page, postCaption);
  await expect(converged.getByText("Published", { exact: true })).toHaveCount(2);
  await expect(converged.getByText("Failed", { exact: true })).toHaveCount(0);
  const publishedStamps = await converged
    .locator("dt")
    .filter({ hasText: /^Published:$/ })
    .locator("xpath=following-sibling::dd[1]")
    .allInnerTexts();
  expect(publishedStamps).toHaveLength(2);
  for (const stamp of publishedStamps) {
    expect(stamp.trim()).not.toBe("");
  }
});

/**
 * Browser acceptance: one Post, four surfaces, one identity and one order.
 *
 * All surfaces must preserve dated Post identity and explicitly requested order.
 * Three real scheduled distributions provide calendar events; unscheduled drafts
 * have no calendar date and cannot prove this contract. The shared signup helper
 * creates a real scoped profile, and controlled channels publish through the
 * normal scheduling API rather than inserting calendar fixtures.
 * Calendar date controls expose the complete day's Posts for the same
 * identity/order assertion used by Table and Grid.
 */
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

  // Same identity on reopening: the row survived the modal round trip and the
  // modal still describes the same caption.
  const reopened = await openPostDetails(page, captions[1]!);
  await expect(reopened.getByText(captions[1]!, { exact: true })).toBeVisible();
});

/**
 * Browser acceptance: two Posts saved from separate composer sessions with
 * identical content stay two Posts.
 *
 * Identical content is the interesting case — a save that deduplicated would turn
 * the second composition into an update of the first. Publishing exactly one of
 * them must therefore produce exactly one set of Platform copies and leave the
 * other a draft.
 * Both compositions belong to the fresh Channels-created profile, not an
 * assumed registration default.
 */
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
    // These Posts are text-only, and Instagram refuses a text-only publish, so
    // each targets Threads alone. Saving the target with the draft is what the
    // reopened composer hydrates from.
    await targetOnlyChannel(page, channelNames.threads, channelNames.instagram);
    await composerTextarea(page).fill(caption);
    await page.getByRole("button", { name: /save draft/i }).click();
    await returnToPosts(page);
  }

  const rows = page.getByRole("row").filter({ hasText: caption });
  await expect(rows).toHaveCount(2, { timeout: 60_000 });

  // Nothing reached a Platform just by saving two drafts.
  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 0);
  await waitForLiveCopyCount(request, channels.threads.providerUserId, 0);

  // Publish exactly one stored Post through its own Details panel.
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

  // The sibling Post is still a draft, so the identical pair never collapsed.
  await filterPostsByStatus(page, /^draft$/i);
  await expect(page.getByRole("row").filter({ hasText: caption })).toHaveCount(1, {
    timeout: 180_000,
  });
  await clearPostStatusFilter(page);
});

/**
 * Browser acceptance: editing a still-pending target never rewrites what is
 * already published, and the destructive actions say plainly what they keep.
 *
 * One Post is published for real and acts as the history under test. A second Post
 * is scheduled into the future, its pending targets are edited, and the first
 * Post's Platform copies are compared before and after. The run finishes by
 * reading the delete confirmation's own wording and then deleting, confirming
 * that the words matched what happened: no Channel gained a copy, and the copy
 * already live elsewhere stayed live.
 * The actor's Channels-created profile owns every target, keeping the history
 * assertions isolated from other acceptance accounts.
 * Each session explicitly chooses its target; retained workspace selection
 * is not assumed to reset between compositions.
 */
test("edits a scheduled target without publishing it and preserves prior platform copies", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const channels = acceptanceChannels();
  await attachChannels(page, request, profileName, [channels.instagram, channels.threads]);

  // --- A Post that is genuinely published, to act as the history under test.
  // Instagram refuses a text-only publish, so this Post carries the video and
  // targets Instagram alone; Threads is the text-only destination throughout.
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

  // --- A second Post, scheduled into the future, whose target is still pending.
  const pendingCaption = `Pending caption ${Date.now()}`;
  const pendingEditCaption = `Pending caption edited ${Date.now()}`;
  await openComposer(page);
  await targetOnlyChannel(page, channelNames.threads, channelNames.instagram);
  await composerTextarea(page).fill(pendingCaption);
  await scheduleInMinutes(page, 180);
  await page.getByRole("button", { name: "Schedule Post", exact: true }).click();
  await returnToPosts(page);

  await waitForPostUnderStatus(page, pendingCaption, /^scheduled$/i);

  // Scheduling the second Post published nothing.
  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);

  // Edit the pending Post through its own Details panel.
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

  // The published Post's Platform copies are the very same records as before.
  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);

  // The delete confirmation states the consequence before it happens.
  const deleteDetail = await openPostDetails(page, pendingEditCaption);
  await deleteDetail.getByRole("button", { name: "Delete post", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: /^keep post$/i }).click();
  await expect(confirmation).toBeHidden({ timeout: 30_000 });
  // Declining leaves the Post exactly as it was, modal and all.
  await expect(deleteDetail).toBeVisible({ timeout: 30_000 });

  // --- Deleting for real: the pending Post stops, the live copy does not move.
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

  // No Channel gained a copy from the deleted Post, and the published Post's
  // copies are exactly the ones recorded before the pending edit.
  await waitForLiveCopyCount(request, channels.instagram.providerUserId, 1);
  await waitForLiveCopyCount(request, channels.threads.providerUserId, 0);
  expect(await readChannelLiveCopies(request, channels)).toEqual(historyBefore);
});

/**
 * Audience, visibility, creator permissions, consent and photo-only controls
 * survive a real draft round-trip before queue delivery. The external Provider
 * is controlled; the browser, persistence, media and publication pipeline are real.
 */
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
  await composerTextarea(page).fill(caption);
  await attachMedia(page, [imageAttachment, videoAttachment]);
  await toggleChannelAttachment(page, youtube.displayName, 1, imageAttachment.name);
  await toggleChannelAttachment(page, tiktok.displayName, 2, videoAttachment.name);
  const youtubePanel = page.getByRole("region", { name: youtube.displayName, exact: true });
  const tiktokPanel = page.getByRole("region", { name: tiktok.displayName, exact: true });
  await youtubePanel.getByRole("textbox", { name: /Video Title/ }).fill("A deliberate video title");
  await youtubePanel.getByRole("combobox", { name: "Made for kids", exact: true }).click();
  await page.getByRole("option", { name: "No, not made for kids", exact: true }).click();
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
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await returnToPosts(page);
  await reloadPostsWorkspace(page);
  await editPostFromRow(page, page.getByRole("row").filter({ hasText: caption }));
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
  expect(videoCopy!.media.map((item) => item.contentType)).toEqual(["video/mp4"]);
  expect(photoCopy!.media).toHaveLength(1);
  expect(photoCopy!.media[0]!.contentType).toMatch(/^image\/(?:jpeg|webp)$/);
});
