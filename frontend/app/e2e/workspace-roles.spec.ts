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

/**
 * Opens the administration section inside the merged Settings surface.
 *
 * @param page - Signed-in page.
 */
async function openAdministration(page: import("@playwright/test").Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Administration", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
}

test("limits installation lifecycle controls to the Installation Owner", async ({ browser }) => {
  const admin = await openSeededAccount(browser, "beta@meltiply.local");
  await openAdministration(admin.page);
  await expect(admin.page.getByText("gamma@meltiply.local")).toBeVisible();
  await expect(admin.page.getByText("epsilon@meltiply.local")).toBeVisible();
  await expect(admin.page.getByText("Suspended", { exact: true })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Invite" })).toBeVisible();
  await expect(
    admin.page.getByRole("switch", { name: "Toggle active state for Gamma Editor" }),
  ).toBeDisabled();
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
  await openAdministration(owner.page);
  await expect(
    owner.page.getByRole("switch", { name: "Toggle active state for Epsilon Suspended" }),
  ).not.toBeChecked();
  await owner.page.getByRole("button", { name: "Actions for Gamma Editor" }).click();
  await expect(owner.page.getByRole("menuitem", { name: "Delete account" })).toBeVisible();
  await owner.page.keyboard.press("Escape");
  await owner.page.getByRole("tab", { name: "Workspace" }).click();
  await expect(owner.page.getByRole("button", { name: "Transfer ownership" })).toBeVisible();
  await owner.context.close();
});

for (const [role, email] of [
  ["Editor", "gamma@meltiply.local"],
  ["Viewer", "delta@meltiply.local"],
] as const) {
  test(`hides administration from a ${role}`, async ({ browser }) => {
    const { context, page } = await openSeededAccount(browser, email);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Administration", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Members" })).toHaveCount(0);
    await context.close();
  });
}
