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
  const provisioned = await provisionControlledChannels(request, workspace.profileName, [
    {
      displayName: "Queue acceptance Threads",
      platform: "threads",
      providerUserId: providerAccountId,
    },
  ]);
  await page.goto("/queues");
  await page.getByRole("combobox", { name: "Queue Brand Profile", exact: true }).click();
  await page.getByRole("option", { name: workspace.profileName, exact: true }).click();
  await page.getByRole("button", { name: "Create Queue", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Queue", exact: true });
  const queueName = `Acceptance Queue ${randomUUID().slice(0, 8)}`;
  await editor.getByLabel("Queue name", { exact: true }).fill(queueName);
  await editor.getByLabel("Queue timezone", { exact: true }).fill("UTC");
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
    await editor
      .getByLabel(`Slot time ${index + 1}`, { exact: true })
      .fill(instant.toISOString().slice(11, 16));
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
    await activeBrandProfileName(page);
    await page
      .locator("main header")
      .getByRole("button", { name: /create post/i })
      .click();
    const composer = page.getByRole("dialog", { name: /^(?:new post|edit post)$/i });
    const destinations = composer.getByRole("region", { name: "Destinations", exact: true });
    const unwanted = destinations
      .locator('button[aria-pressed="true"]')
      .filter({ hasNotText: "Queue acceptance Threads" });
    while (await unwanted.count()) await unwanted.first().click();
    const selectedChannel = destinations.getByRole("button", { name: /Queue acceptance Threads/ });
    if ((await selectedChannel.getAttribute("aria-pressed")) !== "true")
      await selectedChannel.click();
    const caption = `Queue acceptance composition ${index} ${queueName}`;
    await composer.getByPlaceholder(/what do you want to publish/i).fill(caption);
    if (index === 0) {
      const image = pngFixture();
      await composer.locator('input[type="file"]').setInputFiles(image);
      await expect(
        composer.getByRole("status").filter({ hasText: attachmentTitle(image.name) }),
      ).toContainText(/Ready$/, { timeout: 180_000 });
    }
    // The fixture's one connected Channel remains selected with its real settings.
    const channelEditor = composer.getByRole("region", {
      name: "Queue acceptance Threads",
      exact: true,
    });
    const override = `Queue Channel caption ${index}`;
    await channelEditor
      .getByText(/custom text for/i)
      .locator("..")
      .getByRole("textbox")
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
  await page.getByRole("option", { name: workspace.profileName, exact: true }).click();
  await page.getByRole("button", { name: "Inspect Posts", exact: true }).click();
  const memberships = page.getByRole("region", { name: "Queue Posts", exact: true });
  // <section aria-label> is an accessible region; each reserved instant survives reload.
  for (const post of queuedPosts) {
    await expect(
      memberships.locator(`time[datetime="${post.queue_membership!.assigned_at}"]`),
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
      await page.screenshot({
        path: testInfo.outputPath(`queues-${size}-${palette}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const secondRow = memberships
    .locator("article")
    .filter({ hasText: queuedPosts[1]!.default_text });
  await secondRow.getByRole("button", { name: "Remove from Queue", exact: true }).click();
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
        const response = await request.get(`${apiOrigin}/api/v1/posts/${firstPost.id}`, {
          headers,
        });
        const post: Schemas["Post"] = await response.json();
        return post.distributions[0]?.status;
      },
      { timeout: 420_000, intervals: [1000, 3000, 5000] },
    )
    .toBe("failed");
  expect(await readLiveControlledCopies(request, providerAccountId)).toEqual([]);
  const retry = await request.post(
    `${apiOrigin}/api/v1/distributions/${firstPost.distributions[0]!.id}/retry`,
    { headers: { ...headers, "Idempotency-Key": randomUUID() } },
  );
  expect(retry.status(), await retry.text()).toBe(202);
  await expect
    .poll(
      async () =>
        (await readLiveControlledCopies(request, providerAccountId)).map((copy) => copy.caption),
      { timeout: 90_000, intervals: [1000, 3000] },
    )
    .toEqual(["Queue Channel caption 0"]);
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
    "Queue acceptance: real recurring allocation, reload, cancellation, scheduled failure, explicit retry, one controlled Provider publication, immutable history; no live Platform credentials used.",
  );
});
