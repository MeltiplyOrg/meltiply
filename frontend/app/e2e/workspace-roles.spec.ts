import { expect, test, type Browser } from "@playwright/test";

import { signIn, waitForWorkspace } from "./workspace-session";

const password = "MeltiplyLocal1!";

/**
 * Opens a fresh browser context and signs into the seeded shared Workspace.
 *
 * @param browser - Playwright browser fixture.
 * @param email - Seeded account email.
 * @returns The isolated page and its context.
 */
async function openSeededAccount(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, { email, name: email, password });
  await waitForWorkspace(page);
  return { context, page };
}

test("limits installation lifecycle controls to the Installation Owner", async ({ browser }) => {
  const admin = await openSeededAccount(browser, "beta@meltiply.local");
  await expect(
    admin.page.locator("aside").getByText("Workspace Admin", { exact: true }),
  ).toBeVisible();
  await admin.page.goto("/settings");
  await expect(admin.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(admin.page.getByText("gamma@meltiply.local")).toBeVisible();
  await expect(admin.page.getByText("epsilon@meltiply.local")).toBeVisible();
  await expect(admin.page.getByText("pending.invitee@meltiply.local")).toBeVisible();
  await expect(admin.page.getByText("Suspended", { exact: true })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Invite" })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Suspend" })).toHaveCount(0);
  await expect(admin.page.getByRole("button", { name: "Reactivate" })).toHaveCount(0);
  await expect(admin.page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await admin.page.getByRole("tab", { name: "Workspace" }).click();
  await expect(admin.page.getByRole("button", { name: "Transfer ownership" })).toHaveCount(0);
  await admin.page.getByRole("tab", { name: "Audit" }).click();
  await expect(
    admin.page.getByText(
      "Administrative actions are recorded with the actor, target, and request id.",
    ),
  ).toBeVisible();
  await admin.context.close();

  const owner = await openSeededAccount(browser, "alpha@meltiply.local");
  await expect(
    owner.page.locator("aside").getByText("Installation Owner", { exact: true }),
  ).toBeVisible();
  await owner.page.goto("/settings");
  await expect(owner.page.getByRole("button", { name: "Reactivate" })).toBeVisible();
  await expect(owner.page.getByRole("button", { name: "Delete" }).first()).toBeVisible();
  await owner.page.getByRole("tab", { name: "Workspace" }).click();
  await expect(owner.page.getByRole("button", { name: "Transfer ownership" })).toBeVisible();
  await owner.context.close();
});

for (const [role, email] of [
  ["Editor", "gamma@meltiply.local"],
  ["Viewer", "delta@meltiply.local"],
] as const) {
  test(`keeps a ${role} out of Settings`, async ({ browser }) => {
    const { context, page } = await openSeededAccount(browser, email);
    await expect(page.locator("aside").getByText(role, { exact: true })).toBeVisible();
    await expect(page.locator("aside").getByText("Settings", { exact: true })).toHaveCount(0);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/posts(?:\?|$)/);
    await waitForWorkspace(page);
    await context.close();
  });
}
