import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { expect } from "@playwright/test";

/**
 * One durable publication the controlled external Provider holds for a Channel.
 *
 * Mirrors `ControlledPublication` in
 * `workers/automation/test-support/controlled-provider.ts`, which is the module
 * that actually writes these records. The acceptance run reads them back through
 * the fixture API so a published assertion is evidence about the platform side of
 * the boundary, never about what the application remembers about itself.
 */
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
  state: "cancelled" | "published";
}

/** Platforms the controlled Provider serves. */
export type ControlledPlatform = "instagram" | "threads";

/** A Channel the acceptance run asks the fixture to provision. */
export interface ControlledChannelSpec {
  displayName: string;
  platform: ControlledPlatform;
  /**
   * Provider-side account identity. `platform_accounts` is unique on
   * `(platform, platform_user_id)`, so every run must mint its own value; use
   * {@link controlledProviderAccountId} rather than a literal.
   */
  providerUserId: string;
}

/** The Channels a {@link provisionControlledChannels} call created. */
interface ProvisionedControlledChannel {
  displayName: string;
  id: string;
  platform: string;
  providerUserId: string;
}

/** Identity of the Brand Profile a provisioned Channel was attached to. */
export interface ProvisionedChannelsResult {
  brandProfileId: string;
  channels: ProvisionedControlledChannel[];
  organizationId: string;
}

/** Stored attachment bytes as the controlled Provider returned them. */
export interface ControlledMediaBytes {
  /** Raw bytes the Provider served for that attachment position. */
  bytes: Buffer;
  /** SHA-256 computed by the acceptance run over the retrieved bytes. */
  computedChecksum: string;
  /** Declared content type the Provider stored with the object. */
  contentType: string;
  /** SHA-256 the Provider recorded when it stored the object. */
  recordedChecksum: string;
}

/** Namespace served only by the controlled acceptance Worker entry. */
const controlledProviderRoutePrefix = "/controlled-provider/v1";

/**
 * Resolves the local API origin the controlled acceptance entry is served from.
 *
 * Deliberately read from the same environment variable `playwright.config.ts`
 * uses for the local API base URL, so an acceptance run against a non-default
 * port keeps talking to the same Worker as the frontend does.
 *
 * @returns Absolute origin of the local API Worker, without a trailing slash.
 */
function controlledProviderOrigin(): string {
  return process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787";
}

/**
 * Builds an absolute URL for one controlled-Provider fixture endpoint.
 *
 * @param path - Endpoint path beginning with a slash.
 * @returns Absolute URL on the local API origin.
 */
function fixtureUrl(path: string): string {
  return `${controlledProviderOrigin()}${controlledProviderRoutePrefix}${path}`;
}

/**
 * Mints a unique provider-side account identity for one fixture Channel.
 *
 * The controlled Provider keys every durable publication record by this value,
 * so it doubles as the handle an acceptance run asserts live copies against.
 *
 * @param platform - Platform the account belongs to.
 * @returns A provider-side account identity unique to this process run.
 */
export function controlledProviderAccountId(platform: ControlledPlatform): string {
  return `controlled-${platform}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * Selects the workspace's active Brand Profile and reports its display name.
 *
 * Opens the Posts Filter disclosure and selects a real Brand Profile. Choosing
 * the profile scopes the composer; its name lets controlled fixture provisioning
 * attach Channels without introducing another API shape. The disclosure closes
 * afterward so subsequent page actions are not obscured by its floating panel.
 *
 * @param page - Playwright page bound to the signed-in `/posts` view.
 * @returns The active Brand Profile's display name.
 * @throws {Error} When the workspace exposes no selectable Brand Profile.
 */
export async function activeBrandProfileName(page: Page): Promise<string> {
  const disclosure = page.locator("summary").filter({ hasText: /^Filter/ });
  if (!(await disclosure.locator("..").evaluate((element) => element.hasAttribute("open")))) {
    await disclosure.click();
  }
  const combobox = page
    .getByRole("group", { name: "Filters", exact: true })
    .getByRole("combobox")
    .first();
  await expect(combobox).toBeVisible({ timeout: 30_000 });
  await combobox.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  const names = (await options.allInnerTexts()).map((value) => value.trim());
  const name = names.find((value) => value.length > 0 && !/^all brand profiles$/i.test(value));
  if (!name) {
    throw new Error(`workspace has no selectable Brand Profile; options were ${names.join(", ")}`);
  }
  await page.getByRole("option", { name, exact: true }).click();
  await disclosure.click();
  return name;
}

/** Opens a stored Post's editor through table row inspection; Table has no inline action column. */
export async function editPostFromRow(page: Page, row: Locator): Promise<void> {
  await row.getByTitle("View details").click();
  await page
    .getByRole("dialog", { name: "Post details", exact: true })
    .getByRole("button", { name: "Edit post", exact: true })
    .click();
}

/**
 * Attaches controlled-Provider Channels to an existing Brand Profile.
 *
 * The real OAuth connect boundary is unreachable in a plain-HTTP local stack
 * because the API refuses any authorization URL that is not HTTPS, so acceptance
 * runs provision the same `platform_accounts` rows the OAuth callback would have
 * written — encrypted fixture token, connected status, publish scope, no social
 * credentials anywhere. The profile must already exist; this never creates one.
 *
 * @param request - Playwright request context.
 * @param profileName - Display name of the already-created Brand Profile.
 * @param channels - Channels to attach to that profile.
 * @returns The resolved profile identity plus the created Channels.
 * @throws {Error} When the fixture rejects the request.
 */
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
  expect(
    response.status(),
    `provisioning ${channels.length} controlled channel(s) for "${profileName}"`,
  ).toBe(201);
  return (await response.json()) as ProvisionedChannelsResult;
}

/**
 * Lists the live copies the controlled Provider holds for one Channel.
 *
 * @param request - Playwright request context.
 * @param accountId - Provider-side account identity to enumerate.
 * @returns Every durable publication record for that Channel, live copies only
 *   unless the caller inspects `state` itself.
 * @throws {Error} When the fixture rejects the request.
 */
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

/**
 * Selects the live copies the controlled Provider holds for one Channel.
 *
 * A cancelled copy is still a record the Provider kept; only `state: "published"`
 * means the Platform is actually serving that copy, so acceptance assertions that
 * speak about live copies must go through this filter.
 *
 * @param request - Playwright request context.
 * @param accountId - Provider-side account identity to enumerate.
 * @returns Only the publication records whose copy is still live.
 */
export async function readLiveControlledCopies(
  request: APIRequestContext,
  accountId: string,
): Promise<ControlledPublication[]> {
  const publications = await readControlledPublications(request, accountId);
  return publications.filter((publication) => publication.state === "published");
}

/**
 * Retrieves the exact bytes the controlled Provider stored for one attachment.
 *
 * @param request - Playwright request context.
 * @param input - Channel, publication, and attachment position to read.
 * @returns The served bytes plus both the Provider's recorded SHA-256 and the
 *   one the acceptance run computed over the retrieved bytes.
 * @throws {Error} When the Provider holds no copy or attachment at that address.
 */
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

/**
 * Arms or disarms one Channel's scripted provider behaviour.
 *
 * `failNextPublishes: 1` makes the next publish for that Channel answer with a
 * retryable failure, which is how the acceptance run reaches a real
 * `failed`-but-retryable Distribution and then drives the creator-visible Retry.
 * The counter is consumed by the publish it affects.
 *
 * @param request - Playwright request context.
 * @param accountId - Provider-side account identity to script.
 * @param failNextPublishes - Remaining publishes to reject; `0` disarms.
 * @throws {Error} When the fixture rejects the request.
 */
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
