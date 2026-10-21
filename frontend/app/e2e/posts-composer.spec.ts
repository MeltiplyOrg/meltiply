import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  animatedGifFixture,
  attachmentControlName,
  attachmentTitle,
  mp4Fixture,
  pngFixture,
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

/**
 * Ceiling for real signed-upload + native-processing work to settle. The
 * composer's own polling runs every 10s while an Asset is still active, so this
 * covers several poll cycles without turning into an arbitrary sleep.
 */
const processingTimeoutMs = 180_000;

/**
 * Throttled upload throughput, in bytes per second, used only to hold a transfer
 * open long enough to act on its in-flight controls. The request itself is
 * untouched: it is the browser's real network stack delivering real bytes to the
 * real signed object-store endpoint, only slowly.
 */
const throttledUploadBytesPerSecond = 4_096;

const composerTextarea = (page: Page) => page.getByPlaceholder(/what do you want to publish/i);

/**
 * Files handed to the composer's hidden `input[type=file]`. The control is
 * hidden behind the visible "Add Media" button, so the input is targeted
 * directly; `accept` is `image/*,video/*` and the bytes are real decodable
 * media so the processor, not just the upload policy, sees valid content.
 */
function composerFileInput(page: Page) {
  return page.locator('input[type="file"]');
}

/**
 * Finds an attachment's lifecycle strip across filename → persisted-title
 * normalization. Position and phase remain the consumer-visible assertions;
 * extension presentation is deliberately not pinned.
 *
 * @param page - Playwright page bound to the app under test.
 * @param fileName - Attachment file name to scope to.
 */
function attachmentStrip(page: Page, fileName: string) {
  return page.getByRole("status").filter({ hasText: attachmentTitle(fileName) });
}

/**
 * Asserts that the named attachments report the given phases right now.
 *
 * @param page - Playwright page bound to the app under test.
 * @param expected - Ordered `[fileName, phase]` pairs expected to be rendered.
 */
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

/**
 * The actionable reason rendered on a failed attachment row. The phase message
 * is the strip's next sibling, so this asserts what the creator is actually told
 * without pinning one engine's wording.
 *
 * @param page - Playwright page bound to the app under test.
 * @param fileName - Attachment file name to scope to.
 */
function attachmentFailureMessage(page: Page, fileName: string) {
  return attachmentStrip(page, fileName).locator("xpath=following-sibling::p");
}

/**
 * The rendered preview element of one attachment tile — the `<video>` or `<img>`
 * the composer resolved from the signed preview URL. It is the element
 * immediately before the tile's status strip, so what gets asserted is the
 * preview belonging to the named file and not a neighbour's.
 *
 * @param page - Playwright page bound to the app under test.
 * @param fileName - Attachment file name to scope to.
 */
function attachmentPreview(page: Page, fileName: string) {
  return attachmentStrip(page, fileName).locator("xpath=preceding-sibling::*[1]");
}

/**
 * Opens the composer for a new Post.
 *
 * @param page - Playwright page bound to the app under test.
 */
async function openComposer(page: Page): Promise<void> {
  await page.locator("main header").getByRole("button", { name: "Create post" }).click();
  await expect(composerTextarea(page)).toBeVisible();
}

/**
 * Saves the current composition after upload sessions allocate attachment
 * identities, then waits for the authoritative saved indicator. A Preparing
 * row has no Asset yet and cannot be attached to a server-owned Post.
 *
 * @param page - Playwright page bound to the app under test.
 */
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

/**
 * Selects the publishing intent the composer's pinned action submits. The mode
 * selector names the intent and the pinned bar names the action, so a test that
 * publishes instead of saving picks the mode first.
 *
 * @param page - Playwright page bound to the app under test.
 * @param mode - Publishing intent to select before submitting.
 */
async function choosePublishingMode(page: Page, mode: "Draft" | "Schedule" | "Now"): Promise<void> {
  await page
    .getByRole("group", { name: "Publishing", exact: true })
    .getByRole("button", { name: mode, exact: true })
    .click();
}

/**
 * Saves the composition and waits until the native processor has settled every
 * attachment into the phase each one is expected to reach.
 *
 * @param page - Playwright page bound to the app under test.
 * @param expected - Ordered `[fileName, phase]` pairs the saved draft must settle into.
 */
async function saveAndSettle(
  page: Page,
  expected: readonly (readonly [string, string])[],
): Promise<void> {
  await saveDraft(page);
  await expectAttachmentPhases(page, expected);
}

/**
 * Reopens a saved draft from the Posts list, so the composer hydrates from the
 * server Post instead of the tab that wrote it.
 *
 * @param page - Playwright page bound to the app under test.
 * @param caption - Caption identifying the row to edit.
 */
async function reopenDraft(page: Page, caption: string): Promise<void> {
  await closeComposer(page);
  const row = page.getByRole("row").filter({ hasText: caption });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await editPostFromRow(page, row);
  await expect(composerTextarea(page)).toHaveValue(caption);
}

/**
 * Attaches controlled-Provider Channels to the workspace's active Brand Profile
 * and reloads so the composer's channel snapshot includes them.
 *
 * @param page - Playwright page bound to the app under test.
 * @param request - Playwright request context.
 * @param profileName - Display name of the already-selected Brand Profile.
 * @param platforms - Platforms to attach, one Channel each.
 * @returns The provisioned Channel display names in request order.
 */
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
      // Provider-side identity: unique per run so repeated or parallel
      // acceptance runs never collide on the (platform, provider_user_id) key.
      providerUserId: `e2e-${platforms[index]}-${randomUUID()}`,
    })),
  );
  // The workspace fetches its Channels when it mounts, so a newly provisioned
  // Channel only reaches the composer's destination pills after a fresh load.
  await reloadWithScopedProfile(page);
  return displayNames;
}

/**
 * Reloads the app and re-selects the workspace's Brand Profile.
 *
 * The profile scope lives in memory, so a reload returns to the read-only
 * aggregate view; every post-reload composer action has to restore it the same
 * way a user would, through the real toolbar.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns The active Brand Profile's display name.
 */
async function reloadWithScopedProfile(page: Page): Promise<string> {
  await page.reload();
  await waitForWorkspace(page);
  return activeBrandProfileName(page);
}

/** The saved-target fields these acceptance runs read off a recorded mutation. */
interface SavedTargetFields {
  attachment_ids?: string[] | null;
  description_override?: string | null;
  hashtags?: string[];
  platform_account_id: string;
  title_override?: string | null;
}

/**
 * One Post create or update the composer issued, narrowed once at the recording
 * boundary: the payload it sent and the Post the real API answered with. The
 * shapes mirror the Post contract fields these runs assert on, so a reader
 * never has to trust an unchecked cast per field.
 */
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

/**
 * Records every Post create/update the composer sends. The real request is
 * forwarded and the real response is handed back, so what an assertion reads
 * about the Post is the API's own answer rather than a local echo of what the
 * composer believed it saved.
 * The returned Post UUID anchors reopen actions when title or blank-caption
 * overrides mean the row does not display the shared caption.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns The live list of recorded mutations, in the order they were sent.
 */
async function watchPostMutations(page: Page): Promise<PostMutation[]> {
  const mutations: PostMutation[] = [];
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
    mutations.push({
      method: request.method(),
      request: JSON.parse(request.postData() ?? "{}") as PostMutation["request"],
      response: body,
    });
    const headers = { ...response.headers() };
    delete headers["content-length"];
    await route.fulfill({ body: JSON.stringify(body), headers, status: response.status() });
  });
  return mutations;
}

/**
 * Holds the composer's next Post save open at the browser boundary so a run
 * can act while that request is genuinely in flight. The held request carries
 * on to the real API untouched once released.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns The latch: `arrived` resolves once a save is held, `held` collects
 *   the payloads held so far, and `release` lets the current one continue.
 */
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
    held.push(JSON.parse(request.postData() ?? "{}") as PostMutation["request"]);
    announce();
    await gate;
    // Falling back rather than continuing keeps the recorder in the chain.
    await route.fallback();
  });
  return { arrived, held, release: () => open() };
}

/**
 * Waits until the composer has sent one more Post save than the caller has
 * already seen. A repeated save has to be waited on this way: the saved
 * indicator is still on screen from the previous one.
 *
 * @param mutations - Live list of recorded mutations.
 * @param seen - How many mutations the caller had already observed.
 */
async function waitForPostSave(mutations: readonly PostMutation[], seen: number): Promise<void> {
  await expect.poll(() => mutations.length, { timeout: 60_000 }).toBeGreaterThan(seen);
}

/**
 * Presents one already-provisioned Channel to the composer under another
 * provider identifier, at the browser boundary only.
 *
 * The controlled Provider serves Instagram and Threads, and the real OAuth
 * connect boundary needs an HTTPS provider origin a plain-HTTP local stack
 * cannot offer, so YouTube cannot be connected for real here. Only which
 * descriptor the composer resolves for that one Channel is relabelled: the
 * saved target, the reload, and the reopened draft all travel through the real
 * API and the real database.
 *
 * @param page - Playwright page bound to the app under test.
 * @param displayName - Display name of the provisioned Channel.
 * @param provider - Provider identifier the composer should resolve for it.
 */
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

/**
 * Counts the object URLs the app creates and revokes, so a run can prove a
 * discarded row released its browser blob instead of leaving the file's bytes
 * alive for the life of the document.
 */
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
    const tracked = window as unknown as { blobUrls: { created: string[]; revoked: string[] } };
    tracked.blobUrls = { created, revoked };
  });
}

/**
 * Reports how many object URLs the page has created and revoked so far.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns The created and revoked counts.
 */
async function blobUrlCounts(page: Page): Promise<{ created: number; revoked: number }> {
  return page.evaluate(() => {
    const tracked = window as unknown as { blobUrls?: { created: string[]; revoked: string[] } };
    return {
      created: tracked.blobUrls?.created.length ?? 0,
      revoked: tracked.blobUrls?.revoked.length ?? 0,
    };
  });
}

/**
 * The composer recovery records persisted in this browser. They are the seam an
 * interrupted session is restored from, so a run asserts on the records
 * themselves rather than on timing.
 *
 * @param page - Playwright page bound to the app under test.
 * @returns The localStorage keys currently holding composer recovery records.
 */
async function composerRecoveryKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith("meltiply.composer.v2.")),
  );
}

/**
 * Browser acceptance: a text-only Post saved as a draft survives a full page
 * reload and reopens as the same Post in a separate authenticated browser
 * session — server-backed persistence, not browser-local recovery.
 */
test("keeps a saved text-only draft across reload and a separate session", async ({
  page,
  browser,
}) => {
  const { credentials } = await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const caption = "Draft persistence regression caption";
  await composerTextarea(page).fill(caption);
  await saveDraft(page);

  // Reload in the same tab: the persisted caption must come back from the
  // Posts surface rather than from this browser's local recovery copy.
  await page.reload();
  await waitForWorkspace(page);
  await expect(page.getByText(caption).first()).toBeVisible({ timeout: 30_000 });

  // A separate authenticated session (fresh context, same credentials) must
  // reach the same Post: recovery cannot depend on this browser's storage.
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, credentials);
  await waitForWorkspace(secondPage);
  await expect(secondPage.getByText(caption).first()).toBeVisible({ timeout: 30_000 });
  await second.close();
});

/**
 * Browser acceptance: typing in a new, never-saved composition lands in the
 * browser-local recovery record, so a reload before the first save brings the
 * unsaved text back instead of persisting the empty first frame over it. Saving
 * the restored draft then clears the record, so the next composition starts
 * empty.
 */
test("restores an unsaved new composition after a reload and clears it on save", async ({
  page,
}) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const caption = "Unsaved new composition survives reload";
  await composerTextarea(page).fill(caption);
  // The record is what the reload restores from; its key, not a settled wait,
  // is the precondition that has to hold before the reload interrupts anything.
  await expect
    .poll(async () => (await composerRecoveryKeys(page)).length, { timeout: 30_000 })
    .toBe(1);

  await reloadWithScopedProfile(page);
  await openComposer(page);
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();

  // A successful save supersedes this composition's stable recovery namespace,
  // so a fresh composition starts empty.
  await saveDraft(page);
  expect(await composerRecoveryKeys(page)).toHaveLength(0);
  await closeComposer(page);
  await openComposer(page);
  await expect(composerTextarea(page)).toHaveValue("");
});

/**
 * Browser acceptance: editing a reopened saved draft without saving is
 * recorded under the Post's own recovery namespace, so a reload restores the
 * unsaved caption — newer than the server Post — on top of the hydrated draft
 * and reports it as unsaved work instead of discarding it.
 */
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

  // The server still holds the saved caption; the newer recovery record must
  // win over hydration rather than be discarded for having a Post id.
  await reloadWithScopedProfile(page);
  const row = page.getByRole("row").filter({ hasText: savedCaption });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await editPostFromRow(page, row);
  await expect(composerTextarea(page)).toHaveValue(unsavedCaption);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();
});

/**
 * Browser acceptance: composer-owned uploads go through the real signed object
 * store and the native processor, and the saved Post keeps the exact attachment
 * order the creator arranged. Reopening the draft hydrates the rows from the
 * server Post, so the order read back is the persisted one.
 */
test("uploads media in the composer and saves the ordered attachments", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);

  const png = pngFixture();
  const gif = animatedGifFixture();
  await composerFileInput(page).setInputFiles([
    { mimeType: png.mimeType, name: png.name, buffer: png.buffer },
    { mimeType: gif.mimeType, name: gif.name, buffer: gif.buffer },
  ]);

  // Reorder before saving: the second attachment becomes the first one.
  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();

  const caption = "Multi attachment draft";
  await composerTextarea(page).fill(caption);
  // "Ready" is the only phase the publisher accepts, so reaching it proves the
  // bytes really were transferred and really were processed.
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

/**
 * Cross-profile acceptance: real media and Posts retain distinct ownership,
 * saved identities survive a reload after partial failure, and a failed queue
 * operation can finish without resubmitting a profile already accepted.
 */
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
  const png = pngFixture();
  await composerFileInput(page).setInputFiles(png);
  await expectAttachmentPhases(page, [[png.name, "Ready"]]);
  const secondaryPanel = page.getByRole("region", { name: "Secondary Threads", exact: true });
  await secondaryPanel.getByRole("textbox").fill(secondaryCaption);
  await secondaryPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  await secondaryPanel
    .getByRole("button", { name: attachmentControlName("1. ", png.name) })
    .click();
  const mutations = await watchPostMutations(page);
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
          media: [expect.objectContaining({ contentType: expect.stringMatching(/^image\//) })],
        },
      ]);
    expect(await readLiveControlledCopies(request, account)).toHaveLength(1);
  }
});

/**
 * Browser acceptance: replacing an attachment swaps the bytes in place — the row
 * keeps its position and the caption is untouched — and removing one leaves the
 * rest of the composition intact.
 */
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

  // Replacing the first row keeps it first: the swap is in place, not an append.
  await page.getByRole("button", { name: "Replace attachment 1" }).click();
  await composerFileInput(page).setInputFiles({
    mimeType: clip.mimeType,
    name: clip.name,
    buffer: clip.buffer,
  });
  await expect(attachmentStrip(page, clip.name)).toContainText("1. ");
  await expect(composerTextarea(page)).toHaveValue(caption);

  // Removing the second row leaves one attachment and the caption alone.
  await page.getByRole("button", { name: "Remove attachment 2" }).click();
  await expect(page.getByText(gif.name)).toHaveCount(0);
  await expect(attachmentStrip(page, clip.name)).toContainText("1. ");

  await saveAndSettle(page, [[clip.name, "Ready"]]);
  await reopenDraft(page, caption);
  await expectAttachmentPhases(page, [[clip.name, "1. "]]);
  await expect(page.getByText(gif.name)).toHaveCount(0);
});

/**
 * Browser acceptance: replacing one attachment is a swap, not an insert — the
 * attachment count and the published order stay exactly what the creator
 * arranged, the Channel that had selected the replaced Asset follows the
 * replacement, and the Channel that had no media keeps having none. The saved
 * Post must hold all of that after a reopen.
 */
test("replaces one attachment without changing the count, order, or channel selections", async ({
  page,
  request,
}) => {
  // Four real uploads, two of them videos the processor has to probe.
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

  // The first Channel publishes the middle attachment and nothing else: text
  // only, then that one row, so its saved target names a single Asset.
  const narrowPanel = page.getByRole("region", { name: narrow, exact: true });
  const silentPanel = page.getByRole("region", { name: silent, exact: true });
  await narrowPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  const narrowRow = narrowPanel.getByRole("button", {
    name: attachmentControlName("2. ", gif.name),
  });
  await expect(narrowRow).toBeVisible({ timeout: 60_000 });
  await narrowRow.click();
  await expect(narrowRow).toHaveAttribute("aria-pressed", "true");
  // The second Channel publishes no media at all, and a swap must not disturb it.
  await silentPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();

  await page.getByRole("button", { name: "Replace attachment 2" }).click();
  await composerFileInput(page).setInputFiles({
    mimeType: camera.mimeType,
    name: camera.name,
    buffer: camera.buffer,
  });

  // Three rows before, three rows after: the new file took the replaced row's
  // position and the row behind it never moved.
  await expect(page.getByText(/Attached Media \(3\)/)).toBeVisible();
  await expectAttachmentPhases(page, [
    [png.name, "1. "],
    [camera.name, "2. "],
    [clip.name, "3. "],
  ]);
  await expect(page.getByText(gif.name)).toHaveCount(0);
  await expect(composerTextarea(page)).toHaveValue(caption);

  // The Channel that selected the replaced Asset now selects its replacement,
  // and the other Channels' own selections are untouched.
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

  // The same composition rebuilt from the server after a reload.
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

/**
 * Browser acceptance: cancelling an upload that is still transferring stops it
 * and drops the row, so the abandoned file stops consuming upload and storage
 * resources instead of lingering as an unusable attachment.
 *
 * The transfer is only slowed at the browser's network layer — the signed PUT,
 * its body, and its response are untouched — because a local object store would
 * otherwise finish the upload before the control could be reached.
 */
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

  // A cancelled upload must not reappear, and the rest of the draft is intact.
  await composerTextarea(page).fill("Cancelled upload journey");
  await saveDraft(page);
});

/**
 * Browser acceptance: an attachment the creator detaches while its Asset id is
 * already known and its bytes are still moving must stay gone. The browser blob
 * behind its preview is released instead of merely forgotten, the in-flight
 * ownership save is what carried the id, and no request after the detachment
 * puts the Asset back on the Post — the next save is the authoritative record
 * and the API's own answer has to agree.
 *
 * The transfer is slowed only at the browser's network layer, so the row is
 * genuinely mid-upload; the save that persists the Asset's ownership is held at
 * the browser boundary so the detachment provably happens while it is in
 * flight.
 */
test("detaches an in-flight attachment without reattaching or leaking it", async ({
  page,
  context,
}) => {
  await trackBlobUrls(page);
  await openIsolatedOwnerWorkspace(page);
  await openComposer(page);
  const mutations = await watchPostMutations(page);

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

    // The composer has learned the durable Asset id and is persisting its
    // ownership on the already-saved Post; that held request is what carried
    // the id, so the detachment below happens while it is still in flight.
    await held.arrived;

    await page
      .getByRole("button", {
        name: attachmentControlName("Cancel upload of ", clip.name),
      })
      .click();
    await expect(attachmentStrip(page, clip.name)).toHaveCount(0);
    await expect(page.getByText(/Attached Media \(0\)/)).toBeVisible();

    // The preview's blob is released, not just dropped from the composer's
    // tracking set: created and revoked stay balanced.
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

  // Let the held ownership save reach the API, then take the composer's own
  // record back: the detached Asset is on nothing, and the next save says so
  // both in what it sends and in what the API persisted.
  const beforeRelease = mutations.length;
  held.release();
  await waitForPostSave(mutations, beforeRelease);
  const detachedAssetIds = held.held[0]?.attachment_ids ?? [];
  expect(detachedAssetIds).toHaveLength(1);
  const detachedAssetId = detachedAssetIds[0];
  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForPostSave(mutations, beforeSave);
  const latest = mutations[mutations.length - 1];
  expect(latest.request.attachment_ids).not.toContain(detachedAssetId);
  expect(latest.response.attachments.map((attachment) => attachment.asset_id)).not.toContain(
    detachedAssetId,
  );
  await expect(page.getByText(/Attached Media \(0\)/)).toBeVisible();
});

/**
 * Browser acceptance: an upload that fails reports an actionable reason on its
 * own row, keeps the row's position, and can be retried in place with the same
 * local file — after which the real upload and real processing complete.
 *
 * The failure is produced by taking the browser offline, so the transfer is
 * genuinely interrupted rather than faked.
 */
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
  // The row states a reason, not just a status.
  await expect(attachmentFailureMessage(page, png.name)).toHaveText(/\S/);
  await expect(attachmentFailureMessage(page, gif.name)).toHaveText(/\S/);

  const caption = "Retry journey";
  await composerTextarea(page).fill(caption);
  await context.setOffline(false);

  // Retrying keeps the row and its position, so the healthy attachment beside
  // it never moves, and the retried file really uploads and really processes.
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

/**
 * Browser acceptance: media the native processor cannot decode fails with an
 * actionable reason on its own row while the healthy attachment beside it is
 * unaffected, and publishing stays blocked for the affected Channel.
 */
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

  // The engine's reason reaches the row, and the healthy attachment is unaffected.
  await expect(attachmentFailureMessage(page, broken.name)).toHaveText(/\S/);
  await expectAttachmentPhases(page, [[png.name, "Ready"]]);

  // Publishing is refused with a per-Channel reason naming the unusable file.
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

/**
 * Browser acceptance: attempting to publish a text-only composition to a
 * Channel whose platform requires media (e.g. Instagram) reports an actionable,
 * channel-specific incompatibility reason before sending any mutation, and keeps
 * all composer work intact.
 */
test("identifies media-required channels before submitting text-only posts", async ({
  page,
  request,
}) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [instagram] = await attachChannels(page, request, profileName, ["instagram"]);
  const mutations = await watchPostMutations(page);

  // Publishing rules arrive through the platform-capabilities query, which is
  // only mounted by the composer itself; the fetch must settle before the
  // submit click or the per-Channel checks run against nothing.
  const capabilitiesArrived = page.waitForResponse(
    (response) => response.url().includes("/platforms/capabilities") && response.ok(),
    { timeout: 30_000 },
  );
  await openComposer(page);
  await (await capabilitiesArrived).finished();

  const caption = "Text-only post attempting Instagram publish";
  await composerTextarea(page).fill(caption);
  await choosePublishingMode(page, "Now");

  // Each click re-validates, so retrying the click until the Channel-scoped
  // violation renders absorbs any residual settle gap after the fetch lands.
  const violation = page.getByRole("listitem").filter({ hasText: instagram });
  await expect(async () => {
    await page.getByRole("button", { name: /publish now/i }).click();
    await expect(violation).toBeVisible({ timeout: 2_000 });
    await expect(violation).toContainText(/requires at least 1 attachment/i);
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/Please fix the following before submitting/i)).toBeVisible();

  // The refusal is client-side and lossless: no Post mutation was sent and the
  // creator's entered caption is still there.
  expect(mutations).toHaveLength(0);
  await expect(composerTextarea(page)).toHaveValue(caption);
});

/**
 * Browser acceptance: interrupting a saved Post's PATCH preserves text and
 * attachments, exposes an accessible error, and never claims the edits saved.
 * Only the save transport is interrupted: taking the browser offline would
 * pause mutations before transmission rather than exercise failed-save handling.
 */
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

  // Editing after a successful save is what makes the next save a claim the
  // composer has to earn; a failure here must not leave a saved indicator up.
  const caption = "Unsaved work survives a failed save";
  // Filling does not move Playwright's pointer off the hover-paused saved toast.
  // A real click into the editor leaves that notification before the next save.
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

  // Honest reporting: the failure is surfaced, and no saved state is claimed for
  // a save the server never accepted.
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/Saved to your workspace at/i)).toHaveCount(0);
  await expect(page.getByText(/Unsaved changes are kept in this browser/i)).toBeVisible();

  // The creator's work is untouched: caption and the settled attachment.
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expectAttachmentPhases(page, [[png.name, "Ready"]]);

  await page.unroute(saveEndpoint);
  await saveAndSettle(page, [[png.name, "Ready"]]);
  await expect(composerTextarea(page)).toHaveValue(caption);
});

/**
 * Browser acceptance: one saved Post keeps its text, its ordered attachments,
 * and its per-Channel target settings across a reload and a second
 * authenticated session — one Posts-table identity throughout.
 * Row lookup accepts either saved channel preview; reopening still asserts the
 * shared text and each independent override, not a particular row preview order.
 */
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

  // Per-Channel target settings: one Channel publishes text only, the other
  // overrides the caption and still inherits the whole ordered attachment set.
  const instagramPanel = page.getByRole("region", { name: instagram, exact: true });
  const threadsPanel = page.getByRole("region", { name: threads, exact: true });
  await instagramPanel.getByRole("switch", { name: "Use post attachments", exact: true }).click();
  await threadsPanel.getByRole("textbox").fill("Threads-only caption");
  await saveDraft(page);
  const savedPreview = new RegExp(`${caption}|Threads-only caption`);

  // The same composer, hydrated from the server after a reload. The profile
  // scope must be restored first: the Posts surface keeps its mutating actions
  // hidden in the read-only aggregate view.
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

  // A separate authenticated session must rebuild the same Post from the server,
  // after selecting the same profile scope a returning user would pick.
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, credentials);
  await waitForWorkspace(secondPage);
  await activeBrandProfileName(secondPage);
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

/**
 * Browser acceptance: a draft's provider settings survive a reopen even though
 * the Post was never scheduled and therefore carries no Distribution at all, so
 * nothing but the workspace's Channel list can name its platform. The controls
 * must come back filled and the next save must carry them again, instead of
 * rebuilding the panel empty and quietly erasing the Post's own options.
 * Provider fields and shared caption remain mounted in the same scrolling
 * editor; changing one must not discard the other's unsaved values.
 * Reopening uses the API-returned Post identity, not its title-first preview.
 */
test("reopens a draft whose provider options have no distribution", async ({ page, request }) => {
  test.slow();
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [channel] = await attachChannels(page, request, profileName, ["instagram"]);
  await presentChannelAsProvider(page, channel, "youtube");
  await reloadWithScopedProfile(page);
  await openComposer(page);

  const mutations = await watchPostMutations(page);
  const title = "Title without a distribution";
  const tags = "alpha, beta";
  const channelPanel = page.getByRole("region", { name: channel, exact: true });
  await channelPanel.getByPlaceholder(/enter youtube title/i).fill(title);
  await channelPanel.getByPlaceholder(/tech, tutorial/i).fill(tags);
  const caption = "Provider options without a distribution";
  await composerTextarea(page).fill(caption);
  await saveDraft(page);

  // The premise, read from the API's own answer: the Post holds its provider
  // fields and has never produced a Distribution.
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

  // Reopened from the server after a reload: the composer resolved the
  // descriptor from the Channel list and rebuilt the controls it had emptied.
  await reloadWithScopedProfile(page);
  await editPostFromRow(
    page,
    page.getByRole("row").filter({ hasText: created.response.id.slice(-6) }),
  );
  await expect(composerTextarea(page)).toHaveValue(caption);
  await expect(channelPanel.getByPlaceholder(/enter youtube title/i)).toHaveValue(title);
  await expect(channelPanel.getByPlaceholder(/tech, tutorial/i)).toHaveValue(tags);

  // Those options are still the Post's own, so saving again carries them on.
  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForPostSave(mutations, beforeSave);
  expect(mutations[mutations.length - 1].request.targets?.[0]).toMatchObject({
    hashtags: ["alpha", "beta"],
    title_override: title,
  });
});

/**
 * Browser acceptance: a channel override the creator enabled and then left
 * blank is a real choice, distinct from inheriting the shared caption. It must
 * round-trip through the contract as an empty string — never as `null`, which
 * would put the shared text back on that Channel — and a reopened draft must
 * still show the override enabled and empty.
 * Reopening follows the saved Post UUID because an intentional blank preview
 * cannot be located by the shared caption it deliberately does not inherit.
 */
test("keeps an enabled but blank channel caption blank across saves", async ({ page, request }) => {
  const { profileName } = await openIsolatedOwnerWorkspace(page);
  const [channel] = await attachChannels(page, request, profileName, ["threads"]);
  await openComposer(page);

  const mutations = await watchPostMutations(page);
  const caption = "Blank override journey";
  await composerTextarea(page).fill(caption);
  const channelPanel = page.getByRole("region", { name: channel, exact: true });
  const override = channelPanel.getByRole("textbox");
  await expect(override).toHaveValue(caption);
  await override.fill("");
  await saveDraft(page);

  // Both what was sent and what the API persisted: an empty caption, not null.
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

  // Saving the reopened draft keeps the blank caption blank.
  const beforeSave = mutations.length;
  await page
    .getByRole("button", { name: /save( draft)?$/i })
    .first()
    .click();
  await waitForPostSave(mutations, beforeSave);
  expect(mutations[mutations.length - 1].request.targets?.[0]?.description_override).toBe("");
});

/**
 * Browser acceptance: the composer stays usable on a narrow screen and every
 * attachment control is reachable and operable from the keyboard alone.
 */
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

  // Keyboard reordering: focus the control and activate it with Enter.
  const moveEarlier = page.getByRole("button", { name: "Move attachment 2 earlier" });
  await moveEarlier.focus();
  await expect(moveEarlier).toBeFocused();
  await page.keyboard.press("Enter");
  await expectAttachmentPhases(page, [
    [gif.name, "1. "],
    [png.name, "2. "],
  ]);

  // Keyboard removal: the same control surface, no pointer required.
  const remove = page.getByRole("button", { name: "Remove attachment 1" });
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(attachmentStrip(page, gif.name)).toHaveCount(0);
  await expect(composerTextarea(page)).toHaveValue(caption);

  // Nothing overflows the narrow viewport horizontally; a one-pixel tolerance
  // covers sub-pixel layout rounding, not real horizontal scrolling.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

/**
 * Browser acceptance: the standalone Media destination is gone — no navigation
 * entry exists and the retired path takes the same unknown-route fallback as any
 * other unknown path while signed in.
 */
test("has no Media navigation and treats /media as an unknown route", async ({ page }) => {
  await openIsolatedOwnerWorkspace(page);

  await expect(page.getByRole("button", { name: /media library/i })).toHaveCount(0);
  await page.goto("/media");
  await expect(page).toHaveURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
  await waitForWorkspace(page);
});

/**
 * Browser acceptance: a camera-format QuickTime upload becomes a preview the
 * browser actually decodes and plays, while the file a creator downloads is
 * still the original MOV. The still image beside it keeps its own decoded
 * preview and its row controls, so widening what is previewable cannot regress
 * what already was.
 * Metadata checks reuse the composer's authenticated preview headers and workspace
 * scope. Signed downloads preserve original bytes and reject unsigned header edits.
 */
test("previews a camera-codec QuickTime upload as playable video and downloads the original MOV", async ({
  page,
  request,
}) => {
  await openIsolatedOwnerWorkspace(page);

  // The composer's own preview calls are the acceptance seam for the public
  // signing route: recording them from before the upload hands the run the exact
  // credentials and workspace scope the app used, instead of standing up a
  // second authentication path that could pass while the composer could not.
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

  // The MOV tile is a video element whose metadata the browser parsed out of the
  // signed preview; the camera container itself could never reach this state.
  const video = attachmentPreview(page, mov.name);
  await expect(video).toHaveJSProperty("tagName", "VIDEO", { timeout: processingTimeoutMs });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      timeout: processingTimeoutMs,
    })
    .toBeGreaterThanOrEqual(1);

  // Muting keeps playback inside the browser's autoplay policy; what is asserted
  // is that decoded frames advance past the first one.
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

  // The bytes the browser just played are the normalized MP4 rendition, served
  // with that content type, and are not the uploaded QuickTime original.
  const previewUrl = await video.evaluate(
    (element: HTMLVideoElement) => element.currentSrc || element.src,
  );
  const preview = await request.get(previewUrl);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toContain("video/mp4");
  const previewBytes = await preview.body();
  expect(previewBytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
  expect(previewBytes.equals(mov.buffer)).toBe(false);

  // The still image beside it keeps a decoded preview of its own...
  const photo = attachmentPreview(page, png.name);
  await expect(photo).toHaveJSProperty("tagName", "IMG", { timeout: processingTimeoutMs });
  await expect
    .poll(() => photo.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);

  // ...and both rows keep their controls operable.
  await page.getByRole("button", { name: "Move attachment 2 earlier" }).click();
  await expectAttachmentPhases(page, [
    [mov.name, "1. "],
    [png.name, "2. "],
  ]);
  await page.getByRole("button", { name: "Remove attachment 2" }).click();
  await expect(attachmentStrip(page, png.name)).toHaveCount(0);
  await expect(attachmentStrip(page, mov.name)).toContainText("1. ");

  // The download capability still hands over the creator's camera file: the
  // original name, a forced download, and the byte-identical QuickTime payload.
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
