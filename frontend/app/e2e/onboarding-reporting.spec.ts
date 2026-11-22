import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

const password = "MeltiplyLocal1!";
const ownerEmail = "alpha@meltiply.local";
const adminDatabaseUrl =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const egressUrl = process.env.MELTIPLY_E2E_EGRESS_URL?.trim() || "http://127.0.0.1:9787";
const apiOrigin = process.env.MELTIPLY_E2E_API_BASE_URL?.trim() || "http://127.0.0.1:8787";
const databaseHelper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "support/onboarding-db.mjs",
);

interface CapturedEvent {
  body: Record<string, unknown>;
  path: string;
}

async function startEgressReceiver(): Promise<{
  events: CapturedEvent[];
  close: () => Promise<void>;
  server: Server;
}> {
  const events: CapturedEvent[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(body);
        events.push({
          body:
            parsed !== null && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : {},
          path: request.url ?? "",
        });
      } catch {
        events.push({ body: { malformed: body.slice(0, 200) }, path: request.url ?? "" });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", (cause) => listening.reject(cause));
  server.listen(Number(new URL(egressUrl).port), new URL(egressUrl).hostname, listening.resolve);
  await listening.promise;
  return {
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
    events,
    server,
  };
}

function runInstallationFixture(action: "resume" | "complete"): void {
  execFileSync(process.execPath, [databaseHelper, adminDatabaseUrl, action], {
    stdio: "inherit",
  });
}

async function runScheduledDelivery(): Promise<void> {
  const response = await fetch(`${apiOrigin}/__test__/automation/scheduled?cron=0 0 * * *`, {
    method: "POST",
  });
  if (response.status !== 204) {
    throw new Error(`scheduled reporting delivery failed: ${response.status}`);
  }
}

async function waitForEvent(events: CapturedEvent[], name: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const found = events.find((event) => event.body.event === name);
    if (found) return found;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 250);
    await tick.promise;
  }
  return null;
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const consent = encodeURIComponent(
      JSON.stringify({
        expires: Date.now() + 180 * 24 * 60 * 60 * 1_000,
        functional: true,
        v: 1,
      }),
    );
    document.cookie = `meltiply-consent=${consent}; Path=/; Max-Age=15552000; SameSite=Lax`;
  });
  await page.goto("/sign-in");
  await page.getByLabel(/email address/i).fill(ownerEmail);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

async function openWizard(browser: Browser) {
  runInstallationFixture("resume");
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Help improve Meltiply", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

test.use({ screenshot: "off", trace: "off" });
test.setTimeout(180_000);

test("resumes optional onboarding, keeps reporting off unless chosen, and withdraws later", async ({
  browser,
}) => {
  const receiver = await startEgressReceiver();
  try {
    const { context, page } = await openWizard(browser);

    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Diagnostic reports" })).not.toBeChecked();
    expect(receiver.events, "reading the improvement screen must not transmit").toEqual([]);

    await page.getByRole("combobox", { name: "Discovery source" }).click();
    await page.getByRole("option", { name: "GitHub", exact: true }).click();
    expect(receiver.events, "selecting an answer must not transmit").toEqual([]);

    await page.getByRole("button", { name: "Share feedback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued to send" })).toBeVisible();
    await runScheduledDelivery();
    const feedback = await waitForEvent(receiver.events, "meltiply_feedback_discovery_source");
    expect(feedback, "the explicit share must reach the reporting destination").not.toBeNull();
    expect(feedback?.body.properties).toMatchObject({ discovery_source: "github" });
    expect(JSON.stringify(feedback?.body)).not.toContain(ownerEmail);
    expect(JSON.stringify(feedback?.body)).not.toContain("Alpha Creator");
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    expect(receiver.events).toHaveLength(1);

    await page.getByRole("switch", { name: "Usage statistics" }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Enter the Workspace", exact: true }).click();
    await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    expect(receiver.events, "a finished setup must not send a usage report").toHaveLength(1);

    await page.goto("/settings?section=privacy");
    await expect(
      page.getByRole("heading", { name: "Improvement reporting", exact: true }),
    ).toBeVisible();
    const usageSwitch = page.getByRole("switch", { name: "Usage statistics" });
    await expect(usageSwitch, "the saved opt-in is reflected honestly").toBeChecked();
    await expect(page.getByRole("switch", { name: "Diagnostic reports" })).not.toBeChecked();
    await usageSwitch.click();
    await page.getByRole("button", { name: "Save reporting choices", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "Usage statistics" }),
      "withdrawal is persisted",
    ).not.toBeChecked();
    expect(receiver.events, "withdrawal sends nothing").toHaveLength(1);

    await page.reload();
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    await expect(page.getByRole("heading", { name: "Help improve Meltiply" })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "the privacy section must not scroll horizontally on a phone",
    ).toBe(true);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.getByRole("heading", { name: "Improvement reporting" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await context.close();

    const memberContext = await browser.newContext({ reducedMotion: "reduce" });
    const memberPage = await memberContext.newPage();
    await memberPage.addInitScript(() => {
      const consent = encodeURIComponent(
        JSON.stringify({
          expires: Date.now() + 180 * 24 * 60 * 60 * 1_000,
          functional: true,
          v: 1,
        }),
      );
      document.cookie = `meltiply-consent=${consent}; Path=/; Max-Age=15552000; SameSite=Lax`;
    });
    await memberPage.goto("/sign-in");
    await memberPage.getByLabel(/email address/i).fill("delta@meltiply.local");
    await memberPage.getByLabel(/^password$/i).fill(password);
    await memberPage.getByRole("button", { name: /^sign in$/i }).click();
    await expect(memberPage.getByRole("heading", { name: "Posts", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await memberPage.goto("/settings?section=privacy");
    await expect(
      memberPage.getByRole("heading", { name: "Improvement reporting", exact: true }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("switch", { name: "Usage statistics" }),
      "a member may read but not change the installation policy",
    ).toBeDisabled();
    await expect(
      memberPage.getByRole("button", { name: "Save reporting choices", exact: true }),
    ).toHaveCount(0);
    await memberContext.close();
    expect(receiver.events, "a member view sends nothing").toHaveLength(1);
  } finally {
    runInstallationFixture("complete");
    await receiver.close();
  }
});

test("skips the improvement screen without opting in or transmitting", async ({ browser }) => {
  const receiver = await startEgressReceiver();
  try {
    const { context, page } = await openWizard(browser);
    await page.getByRole("combobox", { name: "Discovery source" }).click();
    await page.getByRole("option", { name: "Prefer not to say", exact: true }).click();
    await page.getByRole("button", { name: "Share feedback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Nothing was sent" })).toBeVisible();

    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enter the Workspace", exact: true }).click();
    await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });

    await page.goto("/settings?section=privacy");
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Diagnostic reports" })).not.toBeChecked();
    await expect(page.getByText("Not requested").first()).toBeVisible();
    expect(receiver.events, "a declined answer and a skip must not transmit").toEqual([]);
    await context.close();
  } finally {
    runInstallationFixture("complete");
    await receiver.close();
  }
});

test("resumes an interrupted journey without keeping secrets", async ({ browser }) => {
  const { context, page } = await openWizard(browser);
  try {
    expect(
      await page.evaluate(() =>
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith("meltiply."))
          .map(([, value]) => value)
          .join("\n"),
      ),
      "no password or setup secret may be stored",
    ).not.toMatch(new RegExp(password));

    await expect(
      page.getByRole("combobox", { name: "Discovery source" }),
      "a fresh installation keeps the discovery-source control actionable",
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Share feedback", exact: true })).toBeVisible();
    expect(
      await page.getByRole("status").filter({ hasText: "Shared" }).count(),
      "no answer was submitted, so the screen must not claim one was shared",
    ).toBe(0);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Help improve Meltiply", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("combobox", { name: "Discovery source" }),
      "a reload must still offer the unanswered question",
    ).toBeVisible();

    await page.getByRole("button", { name: "Account menu", exact: true }).count();

    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeVisible();
    await context.close();

    const restarted = await browser.newContext({ reducedMotion: "reduce" });
    const restartedPage = await restarted.newPage();
    await signIn(restartedPage);
    await expect(
      restartedPage.getByRole("heading", { name: "You're ready", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      restartedPage.getByRole("heading", { name: "Help improve Meltiply", exact: true }),
    ).toHaveCount(0);
    await restarted.close();
  } finally {
    runInstallationFixture("complete");
  }
});

test("keeps closed registration and never forces a completed installation back into setup", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Help improve Meltiply" })).toHaveCount(0);

    await context.clearCookies();
    await page.goto("/sign-up");
    await expect(page.getByLabel(/setup secret/i)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    const rejected = await context.request.post("/api/auth/sign-up/email", {
      data: {
        email: `second-owner-${randomUUID().slice(0, 8)}@meltiply.local`,
        name: "Second owner",
        password,
      },
    });
    expect(rejected.status()).toBe(403);
  } finally {
    await context.close();
  }
});
