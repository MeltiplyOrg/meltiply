import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

/** Polls actual SMTP capture for a requested owner action, without printing links or secrets. */
async function mailLink(email, subject, after) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const messages = await (await fetch("http://localhost:8025/api/v1/messages")).json();
    const message = messages.messages?.find(
      (entry) =>
        entry.Subject === subject &&
        entry.To?.some((recipient) => recipient.Address === email) &&
        !after.has(entry.ID),
    );
    if (message) {
      const content = await (
        await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)
      ).json();
      const link = content.Text.match(/https?:\/\/[^\s<>"']+\/api\/auth\/[^\s<>"']+/)?.[0];
      if (link) return link;
    }
    await delay(500);
  }
  throw new Error("Expected authentication email did not reach SMTP capture");
}

/** Generates a live enrollment proof; the URI and decoded secret never leave process memory. */
function totp(uri) {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("Missing authenticator secret");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replace(/=+$/, ""))
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  return String(
    (digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}

/**
 * Exercises the production images in Chromium: guarded first setup, real SMTP
 * verification, closed signup, owner login, password change/reset, TOTP enrollment
 * and backup recovery. Never records traces, filled forms, or secret artifacts.
 * Returns only the current cookie to the API smoke in the same process.
 */
export async function ownerBrowserSession({ origin, email, password, setupSecret }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await mkdir("artifacts/selfhost", { recursive: true });
  let phase = "initial setup";
  const signIn = async (currentPassword) => {
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(currentPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  };
  const signOut = async () => {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(/\/sign-in/);
  };
  try {
    await page.goto(`${origin}/sign-in`);
    await expect(page.getByRole("heading", { name: "Make this workspace yours." })).toBeVisible();
    await page.screenshot({ path: "artifacts/selfhost/owner-setup-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: "artifacts/selfhost/owner-setup-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const rejected = await context.request.post(`${origin}/api/auth/sign-up/email`, {
      data: { email, password, name: "Owner" },
    });
    assert.equal(rejected.status(), 403);
    await page.getByLabel("Your name", { exact: true }).fill("Installation owner");
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Setup secret", { exact: true }).fill(setupSecret);
    await page.getByRole("button", { name: "Create owner account", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Owner account created" }),
    ).toBeVisible();
    phase = "email verification and owner sign-in";
    const link = await mailLink(email, "Verify your Meltiply email", new Set());
    await page.goto(link);
    await signIn(password);
    await page.waitForURL(/\/posts/);
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    const closed = await context.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { "X-Setup-Secret": setupSecret },
      data: { email: `other-${randomUUID()}@example.com`, password, name: "Another owner" },
    });
    assert.equal(closed.status(), 403);
    await signOut();
    await page.goto(`${origin}/sign-up`);
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(page.getByLabel("Setup secret", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: "artifacts/selfhost/owner-login-desktop.png" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: "artifacts/selfhost/owner-login-dark.png" });
    await signIn(password);
    await page.waitForURL(/\/posts/);
    phase = "password change";
    await page.goto(`${origin}/settings?section=security`);
    let dialog = page.getByRole("region", { name: "Account security" });
    await dialog.getByLabel("Current password", { exact: true }).fill(password);
    const changedPassword = randomUUID() + randomUUID();
    await dialog.getByLabel("New password", { exact: true }).fill(changedPassword);
    await dialog.getByRole("button", { name: "Change password and sign out", exact: true }).click();
    await page.waitForURL(/\/sign-in/);
    await signIn(changedPassword);
    await page.waitForURL(/\/posts/);
    await signOut();
    phase = "password reset";
    await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send reset link", exact: true }).click();
    phase = "password reset request acknowledgement";
    await expect(
      page.getByRole("status").filter({ hasText: "If this address belongs" }),
    ).toBeVisible();
    phase = "password reset SMTP delivery";
    const resetLink = await mailLink(email, "Reset your Meltiply password", new Set());
    const callback = await context.request.get(resetLink, { maxRedirects: 0 });
    assert.equal(
      callback.status(),
      302,
      "Recovery callback must return its redirect to the browser",
    );
    const destination = new URL(callback.headers().location);
    assert.equal(destination.pathname, "/sign-in");
    assert.equal(destination.searchParams.has("token"), true);
    const resetResponse = await page.goto(resetLink);
    phase = "password reset form";
    assert.equal(resetResponse?.status(), 200, "Recovery callback must reach the application");
    await expect(page.getByRole("heading", { name: "Choose a new password." })).toBeVisible();
    const recoveredPassword = randomUUID() + randomUUID();
    await page.getByLabel("Password", { exact: true }).fill(recoveredPassword);
    await page.getByRole("button", { name: "Update password", exact: true }).click();
    phase = "password reset completion";
    await expect(page.getByRole("status").filter({ hasText: "Password updated" })).toBeVisible();
    phase = "sign-in after password reset";
    await signIn(recoveredPassword);
    await page.waitForURL(/\/posts/);
    phase = "authenticator enrollment";
    await page.goto(`${origin}/settings?section=security`);
    dialog = page.getByRole("region", { name: "Account security" });
    await dialog.getByLabel("Current password", { exact: true }).fill(recoveredPassword);
    await dialog.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    const setupKey = await dialog
      .getByLabel("Authenticator setup key", { exact: true })
      .inputValue();
    const backupCodes = (await dialog.locator("pre").textContent()).trim().split("\n");
    await dialog
      .getByLabel("Authenticator code", { exact: true })
      .fill(totp(`otpauth://totp/Meltiply?secret=${setupKey}`));
    await dialog.getByRole("button", { name: "I saved my codes — verify", exact: true }).click();
    await page.waitForURL(/\/sign-in/);
    phase = "backup recovery";
    await signIn(recoveredPassword);
    await expect(page.getByRole("heading", { name: "One more security check." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "One more security check." })).toBeFocused();
    await page.getByLabel("Authenticator code", { exact: true }).fill("invalid-code");
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Use a backup code", exact: true }).click();
    await page.getByLabel("Backup code", { exact: true }).fill(backupCodes[0]);
    await page.getByRole("button", { name: "Verify and sign in", exact: true }).click();
    await page.waitForURL(/\/posts/);
    phase = "authenticator removal";
    await page.goto(`${origin}/settings?section=security`);
    dialog = page.getByRole("region", { name: "Account security" });
    await dialog.getByLabel("Current password", { exact: true }).fill(recoveredPassword);
    await dialog.getByRole("button", { name: "Disable two-factor", exact: true }).click();
    await page.waitForURL(/\/sign-in/);
    await signIn(recoveredPassword);
    await page.waitForURL(/\/posts/);
    return (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    // Playwright call logs can include fill values: never forward the exception.
    const current = new URL(page.url());
    console.error("Owner browser state", {
      phase,
      onSignIn: current.pathname === "/sign-in",
      resetTokenInLocation: current.searchParams.has("token"),
      invalidLink: current.searchParams.has("error"),
      resetForm: await page.getByRole("heading", { name: "Choose a new password." }).count(),
      signInForm: await page.getByRole("heading", { name: "Welcome back." }).count(),
    });
    throw new Error(
      `Owner browser smoke failed during ${phase}; sensitive browser details suppressed.`,
    );
  } finally {
    await browser.close();
  }
}
