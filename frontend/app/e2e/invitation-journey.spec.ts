import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { signIn, waitForWorkspace } from "./workspace-session";

/** Local development database where the E2E backend stores the shared Workspace. */
const adminDatabaseUrl =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const databaseHelper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "support/invitation-db.mjs",
);

/**
 * Runs one invitation database operation in a short-lived child process.
 *
 * Keeping PostgreSQL outside the Playwright worker avoids an open client handle
 * surviving the test and preventing the runner from exiting.
 *
 * @param action - `repoint` or `cleanup`.
 * @param email - Invitee email address.
 * @param tokenHash - Replacement invitation token hash for `repoint`.
 */
function runInvitationDatabaseAction(
  action: "repoint" | "cleanup",
  email: string,
  tokenHash?: string,
): void {
  execFileSync(
    process.execPath,
    [databaseHelper, adminDatabaseUrl, action, email, ...(tokenHash ? [tokenHash] : [])],
    { stdio: "inherit" },
  );
}

/**
 * Hashes an invitation token exactly as the workspace lifecycle does.
 *
 * @param token - Raw invitation token from the emailed link.
 * @returns Lowercase SHA-256 digest stored in `workspace_invitations.token_hash`.
 */
function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Deletes the account and invitation created by the journey.
 *
 * @param email - Invitee email address.
 */
function cleanupInvitee(email: string): void {
  runInvitationDatabaseAction("cleanup", email);
}

test("Admin invites an address and the invitee joins through the link as an Editor", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const email = `e2e-invite-${randomUUID().slice(0, 8)}@meltiply.local`;
  const password = "MeltiplyLocal1!";
  const token = `e2e-invitation-${randomUUID().replaceAll("-", "")}`;
  const adminContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await signIn(admin, {
      email: "beta@meltiply.local",
      name: "Beta Admin",
      password: "MeltiplyLocal1!",
    });
    await waitForWorkspace(admin);
    await admin.goto("/settings");
    await admin.getByRole("button", { name: "Invite", exact: true }).click();
    const inviteDialog = admin.getByRole("dialog", { name: "Invite a member" });
    await inviteDialog.getByLabel("Email address").fill(email);
    await inviteDialog.getByLabel("Role").click();
    await admin.getByRole("option", { name: "Editor" }).click();
    await inviteDialog.getByRole("button", { name: "Send invitation" }).click();
    await expect(inviteDialog).not.toBeVisible();
    await expect(admin.getByText(email, { exact: true })).toBeVisible();

    // The test acts as the mail transport: point the created invitation at a
    // token this journey can open without reading Wrangler's simulated mail log.
    runInvitationDatabaseAction("repoint", email, invitationTokenHash(token));

    const invitee = await inviteeContext.newPage();
    await invitee.goto(`/invitations/accept?token=${token}`);
    await expect(invitee.getByRole("heading", { name: /Join / })).toBeVisible();
    await expect(invitee.getByLabel("Email address")).toHaveValue(email);
    await invitee.getByLabel("Your name").fill("E2E Invitee");
    await invitee.getByLabel("Password").fill(password);
    await invitee.getByRole("button", { name: "Create account" }).click();
    await expect(invitee.getByText("You joined the workspace.")).toBeVisible({
      timeout: 30_000,
    });
    await invitee.getByRole("button", { name: "Open the workspace" }).click();
    await invitee.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
    await waitForWorkspace(invitee);
    await expect(invitee.locator("aside").getByText("Editor", { exact: true })).toBeVisible();
    await expect(invitee.locator("aside").getByText("Settings", { exact: true })).toHaveCount(0);
  } finally {
    await inviteeContext.close();
    await adminContext.close();
    await cleanupInvitee(email);
  }
});
