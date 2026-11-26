import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";

import { expect } from "@playwright/test";
import { Schema } from "effect";

export interface ControlledPublication {
  accountId: string;
  caption: string;
  hashtags: string[];
  media: readonly {
    checksum: string;
    contentType: string;
    fileSize: number;
    key: string;
  }[];
  operationId: string;
  platform: string;
  publicationId: string;
  publishedAt: string;
  providerOptions?: unknown;
  state: "cancelled" | "published";
}

export type ControlledPlatform = "facebook" | "instagram" | "threads" | "tiktok" | "youtube";

export interface ControlledChannelSpec {
  displayName: string;
  platform: ControlledPlatform;
  providerUserId: string;
}

const provisionedChannelsSchema = Schema.Struct({
  brand_profile_id: Schema.String,
  channels: Schema.Array(
    Schema.Struct({
      display_name: Schema.String,
      id: Schema.String,
      platform: Schema.String,
      platform_user_id: Schema.String,
    }),
  ),
  organization_id: Schema.String,
});

export type ProvisionedChannelsResult = typeof provisionedChannelsSchema.Type;

export interface ControlledMediaBytes {
  bytes: Buffer;
  computedChecksum: string;
  contentType: string;
  recordedChecksum: string;
}

const controlledProviderRoutePrefix = "/controlled-provider/v1";

function controlledProviderOrigin(): string {
  return process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787";
}

function fixtureUrl(path: string): string {
  return `${controlledProviderOrigin()}${controlledProviderRoutePrefix}${path}`;
}

export function acceptanceApiUrl(path: string): string {
  return `${controlledProviderOrigin()}${path}`;
}

export function controlledProviderAccountId(platform: ControlledPlatform): string {
  return `controlled-${platform}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

const fixtureBrandProfileNames = new WeakMap<Page, string>();

export async function activeBrandProfileName(page: Page, profileName?: string): Promise<string> {
  const name = profileName ?? fixtureBrandProfileNames.get(page);
  if (!name) throw new Error("A new browser page must select its named fixture Brand Profile.");
  const disclosure = page.locator("summary").filter({ hasText: /^Filter/ });
  if (!(await disclosure.locator("..").evaluate((element) => element.hasAttribute("open")))) {
    await disclosure.click();
  }
  const addProfile = page.getByRole("button", { name: "Add Brand Profile filter", exact: true });
  if (await addProfile.isVisible()) await addProfile.click();
  const trigger = page
    .getByRole("button", { name: "Remove Brand Profile filter", exact: true })
    .locator("..")
    .locator('button[aria-haspopup="menu"], button[role="combobox"]');
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const popupRole = await trigger.getAttribute("aria-haspopup");
  await trigger.click();
  if (popupRole === "menu") {
    const menu = page.getByRole("menu", { name: "Brand Profile", exact: true });
    const option = menu.getByRole("menuitemcheckbox", { name, exact: true });
    await expect(option).toBeVisible({ timeout: 30_000 });
    await menu.getByRole("menuitemcheckbox", { name: "All Brand Profiles", exact: true }).click();
    await option.click();
    await expect(option).toBeChecked();
    await page.keyboard.press("Escape");
  } else {
    await page.getByRole("option", { name, exact: true }).click();
  }
  fixtureBrandProfileNames.set(page, name);
  await disclosure.click();
  await expect(page.getByRole("group", { name: "Filters", exact: true })).toBeHidden();
  return name;
}

export async function editPostFromRow(page: Page, row: Locator): Promise<void> {
  await row.getByTitle("View details").click();
  await page
    .getByRole("dialog", { name: "Post details", exact: true })
    .getByRole("button", { name: "Edit post", exact: true })
    .click();
}

export async function closeComposer(page: Page): Promise<void> {
  const composer = page.getByRole("dialog", { name: /^(?:new post|edit post)$/i });
  await composer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(composer).toBeHidden();
}

export async function provisionControlledChannels(
  request: APIRequestContext,
  profileName: string,
  channels: readonly ControlledChannelSpec[],
): Promise<ProvisionedChannelsResult> {
  const response = await request.post(fixtureUrl("/channels"), {
    data: {
      channels: channels.map((channel) => ({
        display_name: channel.displayName,
        platform: channel.platform,
        provider_user_id: channel.providerUserId,
      })),
      profile_name: profileName,
    },
  });
  const failureDetail = response.status() === 201 ? "" : await response.text();
  expect(
    response.status(),
    `provisioning ${channels.length} controlled channel(s) for "${profileName}": ${failureDetail}`,
  ).toBe(201);
  return Schema.decodeUnknownSync(provisionedChannelsSchema)(await response.json());
}

export async function readControlledPublications(
  request: APIRequestContext,
  accountId: string,
): Promise<ControlledPublication[]> {
  const response = await request.get(
    fixtureUrl(`/publications?account_id=${encodeURIComponent(accountId)}`),
  );
  expect(response.status(), `reading controlled publications for ${accountId}`).toBe(200);
  const body = (await response.json()) as { publications: ControlledPublication[] };
  return body.publications;
}

export async function readLiveControlledCopies(
  request: APIRequestContext,
  accountId: string,
): Promise<ControlledPublication[]> {
  const publications = await readControlledPublications(request, accountId);
  return publications.filter((publication) => publication.state === "published");
}

export async function readControlledMedia(
  request: APIRequestContext,
  input: {
    accountId: string;
    index: number;
    publicationId: string;
  },
): Promise<ControlledMediaBytes> {
  const response = await request.get(
    fixtureUrl(
      `/publications/${encodeURIComponent(input.publicationId)}/media/${input.index}?account_id=${encodeURIComponent(input.accountId)}`,
    ),
  );
  expect(response.status(), `reading controlled media ${input.publicationId}#${input.index}`).toBe(
    200,
  );
  const bytes = await response.body();
  return {
    bytes,
    computedChecksum: createHash("sha256").update(bytes).digest("hex"),
    contentType: response.headers()["content-type"] ?? "",
    recordedChecksum: response.headers()["x-controlled-checksum"] ?? "",
  };
}

export async function scriptControlledFailures(
  request: APIRequestContext,
  accountId: string,
  failNextPublishes: number,
): Promise<void> {
  const response = await request.post(fixtureUrl("/scripts"), {
    data: { account_id: accountId, fail_next_publishes: failNextPublishes },
  });
  expect(
    response.status(),
    `scripting ${failNextPublishes} controlled failure(s) for ${accountId}`,
  ).toBe(200);
}

export async function configurePublishingQueue(
  page: Page,
  profileName: string,
  queueName: string,
  instants: readonly Date[],
): Promise<Response> {
  await page.goto("/queues");
  await page.getByRole("combobox", { name: "Queue Brand Profile", exact: true }).click();
  await page.getByRole("option", { name: profileName, exact: true }).click();
  await page.getByRole("button", { name: "Create Queue", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Create Queue", exact: true });
  await editor.getByLabel("Queue name", { exact: true }).fill(queueName);
  await editor.getByRole("button", { name: /^Queue timezone:/ }).click();
  const timezoneSearch = editor.getByRole("textbox", { name: "Search timezones…", exact: true });
  await timezoneSearch.fill("reykjavik");
  await page.getByRole("option", { name: "Atlantic/Reykjavik", exact: true }).click();
  await expect(editor.getByRole("button", { name: /^Queue timezone:/ })).toHaveAttribute(
    "aria-label",
    "Queue timezone: Atlantic/Reykjavik",
  );
  await editor.getByRole("button", { name: /^Queue timezone:/ }).click();
  await timezoneSearch.fill("utc");
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(editor.getByRole("button", { name: /^Queue timezone:/ })).toHaveAttribute(
    "aria-label",
    "Queue timezone: UTC",
  );
  await expect(timezoneSearch).toBeHidden();
  for (const [index, instant] of instants.entries()) {
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
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/queues") && response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "Save Queue", exact: true }).click();
  const response = await submitted;
  expect(response.status(), await response.text()).toBe(201);
  await expect(editor).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Publishing Queues", exact: true })
      .getByRole("button", { name: queueName, exact: true }),
  ).toBeVisible();
  return response;
}
