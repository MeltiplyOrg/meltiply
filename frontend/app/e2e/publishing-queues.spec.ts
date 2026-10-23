import { randomUUID } from "node:crypto";
import type { components } from "@meltiply/contracts/schema";
import { expect, test } from "@playwright/test";
import {
  activeBrandProfileName,
  closeComposer,
  controlledProviderAccountId,
  provisionControlledChannels,
  readLiveControlledCopies,
  scriptControlledFailures,
} from "./publication-fixtures";
import { attachmentTitle, pngFixture } from "./media-fixtures";
import { openIsolatedOwnerWorkspace, waitForWorkspace } from "./workspace-session";

type Schemas = components["schemas"];
test.use({ actionTimeout: 30_000 });

// Production browser/API/PostgreSQL/Outbox/transport/background paths, with only
// the external Provider controlled. Real time reaches the reserved minute; no
// database timestamp writes or Queue allocation mocks make a delivery due.
test("configures a Queue, preserves two Posts after reload, and delivers through the background path", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(720_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const workspace = await openIsolatedOwnerWorkspace(page);
  const providerAccountId = controlledProviderAccountId("threads");
  const channelName = `Queue acceptance Threads ${providerAccountId}`;
  await page.goto("/queues");
  await page.getByRole("combobox", { name: "Queue Brand Profile", exact: true }).click();
  const createdProfile = page.getByRole("option").filter({ hasText: workspace.credentials.name });
  const profileName = (await createdProfile.innerText()).trim();
  await createdProfile.click();
  const provisioned = await provisionControlledChannels(request, profileName, [
    { displayName: channelName, platform: "threads", providerUserId: providerAccountId },
  ]);
  await page.getByRole("button", { name: "Create Queue", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Queue", exact: true });
  const queueName = `Acceptance Queue ${randomUUID().slice(0, 8)}`;
  await editor.getByLabel("Queue name", { exact: true }).fill(queueName);
  await editor.getByRole("button", { name: /^Queue timezone:/ }).click();
  const timezonePicker = page.getByRole("dialog", { name: "Queue timezone", exact: true });
  await timezonePicker.getByRole("textbox", { name: "Search timezones…", exact: true }).fill("utc");
  await timezonePicker.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(timezonePicker).toBeHidden();
  // Allow the real media processor and two submissions to settle before due work.
  const firstInstant = new Date(Math.ceil((Date.now() + 240_000) / 60_000) * 60_000);
  const secondInstant = new Date(firstInstant.getTime() + 60_000);
  for (const [index, instant] of [firstInstant, secondInstant].entries()) {
    if (index > 0) await editor.getByRole("button", { name: "Add slot", exact: true }).click();
    await editor.getByRole("combobox", { name: `Weekday ${index + 1}`, exact: true }).click();
    const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
      instant,
    );
    await page.getByRole("option", { name: day, exact: true }).click();
    await editor.getByRole("button", { name: "Choose time", exact: true }).nth(index).click();
    const timePicker = page.getByRole("dialog", { name: "Choose time", exact: true });
    await timePicker.getByRole("combobox", { name: "Hour", exact: true }).click();
    await page
      .getByRole("option", { name: instant.toISOString().slice(11, 13), exact: true })
      .click();
    await timePicker.getByRole("combobox", { name: "Minute", exact: true }).click();
    await page
      .getByRole("option", { name: instant.toISOString().slice(14, 16), exact: true })
      .click();
    await timePicker.getByRole("button", { name: "Done", exact: true }).click();
  }
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/queues") && response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "Save Queue", exact: true }).click();
  const created = await createdResponse;
  expect(created.status(), await created.text()).toBe(201);
  const plan: Schemas["PublishingQueue"] = await created.json();
  const apiOrigin = new URL(created.url()).origin;
  const headers = { Authorization: (await created.request().allHeaders())["authorization"]! };
  await expect(editor).toBeHidden();
  await expect(page.getByRole("heading", { name: queueName, exact: true })).toBeVisible();
  await scriptControlledFailures(request, providerAccountId, 1);

  const queuedPosts: Schemas["Post"][] = [];
  for (const index of [0, 1]) {
    await page.goto("/posts");
    await waitForWorkspace(page);
    await activeBrandProfileName(page, profileName);
    await page
      .locator("main header")
      .getByRole("button", { name: /create post/i })
      .click();
    const composer = page.getByRole("dialog", { name: /^(?:new post|edit post)$/i });
    const caption = `Queue acceptance composition ${index} ${queueName}`;
    await composer.getByPlaceholder(/what do you want to publish/i).fill(caption);
    if (index === 0) {
      const image = pngFixture();
      await composer.locator('input[type="file"]').setInputFiles(image);
      await expect(
        composer.getByRole("status").filter({ hasText: attachmentTitle(image.name) }),
      ).toContainText(/Ready$/, { timeout: 180_000 });
    }
    const destinations = composer.getByRole("region", { name: "Destinations", exact: true });
    const unwanted = destinations
      .locator("button[aria-pressed]")
      .filter({ hasNotText: providerAccountId });
    for (const channel of await unwanted.all()) {
      if ((await channel.getAttribute("aria-pressed")) === "true") await channel.click();
      await expect(channel).toHaveAttribute("aria-pressed", "false");
    }
    const selectedChannel = destinations
      .getByRole("button", { name: /Queue acceptance Threads/ })
      .filter({ hasText: providerAccountId });
    if ((await selectedChannel.getAttribute("aria-pressed")) !== "true")
      await selectedChannel.click();
    // Finalize the intended target set after upload draft hydration settles.
    const channelEditor = composer.getByRole("region", {
      name: channelName,
      exact: true,
    });
    const override = `Queue Channel caption ${index}`;
    await channelEditor
      .locator(`#channel-override-text-${provisioned.channels[0]!.id}`)
      .fill(override);
    await composer
      .getByRole("group", { name: "Publishing", exact: true })
      .getByRole("button", { name: "Queue", exact: true })
      .click();
    await composer.getByRole("combobox", { name: "Publishing Queue", exact: true }).click();
    await page.getByRole("option", { name: queueName, exact: true }).click();
    await expect(composer.getByRole("button", { name: "Choose time", exact: true })).toHaveCount(0);
    const submitted = page.waitForResponse(
      (response) =>
        /\/api\/v1\/posts\/[^/]+\/schedule$/.test(response.url()) &&
        response.request().method() === "POST",
    );
    await composer.getByRole("button", { name: "Add to Queue", exact: true }).click();
    const scheduled = await submitted;
    expect(scheduled.status(), await scheduled.text()).toBe(200);
    const post: Schemas["Post"] = await scheduled.json();
    expect(post.default_text).toBe(caption);
    expect(post.targets).toMatchObject([
      { platform_account_id: provisioned.channels[0]!.id, description_override: override },
    ]);
    expect(post.attachments.map((attachment) => attachment.asset.asset_type)).toEqual(
      index === 0 ? ["image"] : [],
    );
    expect(post.queue_membership).toMatchObject({
      queue_id: plan.id,
      assigned_at: [firstInstant, secondInstant][index]!.toISOString(),
    });
    expect(post.distributions).toMatchObject([
      {
        platform_account_id: provisioned.channels[0]!.id,
        status: "scheduled",
        scheduled_at: post.queue_membership!.assigned_at,
      },
    ]);
    queuedPosts.push(post);
    if (await composer.isVisible()) await closeComposer(page);
  }

  await page.goto("/queues");
  await page.reload();
  await page.getByRole("combobox", { name: "Queue Brand Profile", exact: true }).click();
  await page.getByRole("option", { name: profileName, exact: true }).click();
  await page
    .getByRole("region", { name: "Publishing Queues", exact: true })
    .getByRole("button", { name: queueName, exact: true })
    .click();
  const memberships = page.getByRole("region", { name: "Queue Posts", exact: true });
  // <section aria-label> is an accessible region; each reserved instant survives reload.
  for (const post of queuedPosts) {
    await expect(
      memberships.locator(
        `[data-hour-canvas] time[datetime="${post.queue_membership!.assigned_at}"]`,
      ),
    ).toBeVisible();
    const read = await request.get(`${apiOrigin}/api/v1/posts/${post.id}`, { headers });
    expect(read.status()).toBe(200);
    expect(await read.json()).toMatchObject({
      queue_membership: post.queue_membership,
      default_text: post.default_text,
      targets: post.targets,
      attachments: post.attachments,
    });
  }
  for (const [size, width, height] of [
    ["desktop", 1440, 1000],
    ["phone", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const palette of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: palette });
      if (palette === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      await expect(page.getByRole("heading", { name: "Queues", exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // A bounded document can still hide overflow in the workspace scroller,
      // shifting the entire page when a calendar control receives focus.
      expect(
        await page.locator("main").evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true);
      if (size === "phone") {
        await expect(
          page.getByRole("combobox", { name: "Choose a Queue", exact: true }),
        ).toHaveText(queueName);
        await page.getByRole("button", { name: `Actions for ${queueName}`, exact: true }).click();
        await page.getByRole("menuitem", { name: "Edit Queue", exact: true }).click();
        const phoneEditor = page.getByRole("dialog", { name: "Edit Queue", exact: true });
        await phoneEditor.getByRole("button", { name: "Choose time", exact: true }).first().click();
        const phonePicker = page.getByRole("dialog", { name: "Choose time", exact: true });
        await phonePicker.getByRole("button", { name: "Done", exact: true }).click();
        await expect(phonePicker).toBeHidden();
        await phoneEditor.getByRole("button", { name: "Close", exact: true }).click();
        await expect(phoneEditor).toBeHidden();
        await memberships
          .locator("[data-hour-canvas] button")
          .filter({
            has: page.locator(`time[datetime="${queuedPosts[1]!.queue_membership!.assigned_at}"]`),
          })
          .click();
        const phonePost = page.getByRole("dialog", { name: "Queue Post", exact: true });
        await expect(phonePost).toContainText(`Queue acceptance composition 1 ${queueName}`);
        await phonePost.getByRole("button", { name: "Close", exact: true }).click();
        await expect(phonePost).toHaveCount(0);
      }
      await page.screenshot({
        path: testInfo.outputPath(`queues-${size}-${palette}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await memberships
    .locator("[data-hour-canvas] button")
    .filter({
      has: page.locator(`time[datetime="${queuedPosts[1]!.queue_membership!.assigned_at}"]`),
    })
    .click();
  await page
    .getByRole("dialog", { name: "Queue Post", exact: true })
    .getByRole("button", { name: "Remove from Queue", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", { name: "Remove from Queue?", exact: true });
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirm).toBeHidden();
  const removed = await request.get(`${apiOrigin}/api/v1/posts/${queuedPosts[1]!.id}`, { headers });
  expect(await removed.json()).toMatchObject({
    queue_membership: null,
    distributions: [{ status: "cancelled" }],
  });

  const firstPost = queuedPosts[0]!;
  await expect
    .poll(
      async () => {
        // Wrangler does not run Cron automatically. Dispatch its real scheduled
        // handler at wall-clock time; never change a stored due time or inject
        // a future clock. Repeated ticks exercise the normal idempotent relay.
        if (Date.now() >= firstInstant.getTime()) {
          const tick = await request.post(
            `${apiOrigin}/cdn-cgi/local/explorer/api/local/scheduled?worker=meltiply-automation-local`,
            { data: { cron: "0 * * * *" } },
          );
          expect(tick.status(), await tick.text()).toBe(200);
        }
        const response = await request.get(`${apiOrigin}/api/v1/posts/${firstPost.id}`, {
          headers,
        });
        const post: Schemas["Post"] = await response.json();
        return post.distributions[0]?.status;
      },
      { timeout: 420_000, intervals: [1000, 3000, 5000] },
    )
    .toBe("published");
  // The injected transient failure follows normal transport backoff. Its failed
  // state may be shorter than a poll interval; the durable attempt count and one
  // Provider-side copy prove recovery without imposing a different retry policy.
  await expect
    .poll(
      async () =>
        (await readLiveControlledCopies(request, providerAccountId)).map((copy) => copy.caption),
      { timeout: 90_000, intervals: [1000, 3000] },
    )
    .toEqual(["Queue Channel caption 0"]);
  expect((await readLiveControlledCopies(request, providerAccountId))[0]?.media).toMatchObject([
    { contentType: expect.stringMatching(/^image\//) },
  ]);
  const delivered: Schemas["Post"] = await (
    await request.get(`${apiOrigin}/api/v1/posts/${firstPost.id}`, { headers })
  ).json();
  expect(delivered.distributions).toMatchObject([{ status: "published", attempt_count: 2 }]);
  expect(delivered.queue_membership).toEqual(firstPost.queue_membership);
  const denied = await request.delete(
    `${apiOrigin}/api/v1/queues/${plan.id}/posts/${firstPost.id}`,
    {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: { brand_profile_id: plan.brand_profile_id },
    },
  );
  expect(denied.status()).toBe(409);
  const retirement = await request.delete(`${apiOrigin}/api/v1/queues/${plan.id}`, {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: { brand_profile_id: plan.brand_profile_id },
  });
  expect(retirement.status(), await retirement.text()).toBe(204);
  const history: Schemas["Post"] = await (
    await request.get(`${apiOrigin}/api/v1/posts/${firstPost.id}`, { headers })
  ).json();
  expect(history.queue_membership).toEqual(firstPost.queue_membership);
  expect(history.distributions).toMatchObject([{ status: "published" }]);
  console.log(
    "Queue acceptance: real recurring allocation, reload, cancellation, transient failure and transport retry, one controlled Provider publication with media, immutable history; no live Platform credentials used.",
  );
});
