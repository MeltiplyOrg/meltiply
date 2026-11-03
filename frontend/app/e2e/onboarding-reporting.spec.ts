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
const databaseHelper = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "support/onboarding-db.mjs",
);

/** One captured outbound report, kept only as the parsed JSON body. */
interface CapturedEvent {
  body: Record<string, unknown>;
  path: string;
}

/**
 * Starts the controlled PostHog-compatible receiver used as the reporting
 * egress seam. It records request bodies only; nothing is forwarded anywhere.
 *
 * @returns Receiver handle with the captured events and a close function.
 */
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
        events.push({
          body: JSON.parse(body) as Record<string, unknown>,
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
  // The listener reports a Node error, whose message is what a rejection needs;
  // passing the error object directly does not satisfy the promise reject type.
  server.once("error", (cause) => listening.reject(cause));
  server.listen(Number(new URL(egressUrl).port), new URL(egressUrl).hostname, listening.resolve);
  await listening.promise;
  return {
    close: () => {
      const closed = Promise.withResolvers<void>();
      // `close` invokes its callback with an optional error, which must be
      // discarded so the resolver keeps the promise's void shape.
      server.close(() => closed.resolve());
      return closed.promise;
    },
    events,
    server,
  };
}

/** Runs one installation fixture action against the loopback test database. */
function runInstallationFixture(action: "resume" | "complete"): void {
  execFileSync(process.execPath, [databaseHelper, adminDatabaseUrl, action], {
    stdio: "inherit",
  });
}

/**
 * Waits for the receiver to see one event with this name, tolerating the
 * Worker's background continuation after the mutation response.
 *
 * @param events Receiver capture.
 * @param name Expected event name.
 * @returns The captured event, or `null` when it never arrived.
 */
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

/** Signs the seeded Owner in through the real form with functional consent granted. */
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

/**
 * Opens the wizard in a fresh signed-in context after the fixture marked the
 * installation as resuming optional onboarding.
 *
 * @param browser - Playwright browser fixture.
 * @returns The opened page and its context.
 */
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

/**
 * First-run wizard acceptance over the real API, real PostgreSQL and the
 * controlled reporting egress. The journey covers both optional screens, the
 * explicit skip and share actions, resumption across a reload, withdrawal in
 * Settings, and the member-facing read-only disclosure.
 *
 * No screenshot or trace is produced, and the setup secret, password, and any
 * session credential stay in process memory.
 */
test("resumes optional onboarding, keeps reporting off unless chosen, and withdraws later", async ({
  browser,
}) => {
  const receiver = await startEgressReceiver();
  try {
    const { context, page } = await openWizard(browser);

    // Screen 2: both switches start off and reading the screen transmits nothing.
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Diagnostic reports" })).not.toBeChecked();
    expect(receiver.events, "reading the improvement screen must not transmit").toEqual([]);

    // Choosing an answer is local; only Share feedback may transmit it.
    await page.getByRole("combobox", { name: "Discovery source" }).click();
    await page.getByRole("option", { name: "GitHub", exact: true }).click();
    expect(receiver.events, "selecting an answer must not transmit").toEqual([]);

    await page.getByRole("button", { name: "Share feedback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued to send" })).toBeVisible();
    const feedback = await waitForEvent(receiver.events, "meltiply_feedback_discovery_source");
    expect(feedback, "the explicit share must reach the reporting destination").not.toBeNull();
    expect(feedback?.body.properties).toMatchObject({ discovery_source: "github" });
    // The answer is pseudonymous: no account or Workspace identity rides with it.
    expect(JSON.stringify(feedback?.body)).not.toContain(ownerEmail);
    expect(JSON.stringify(feedback?.body)).not.toContain("Alpha Creator");
    // Sharing feedback never enables a category.
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    expect(receiver.events).toHaveLength(1);

    // Opt into usage only, then finish into the Workspace.
    await page.getByRole("switch", { name: "Usage statistics" }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Enter the Workspace", exact: true }).click();
    await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    // Usage reports drain on the daily scheduled unit, never from this request.
    expect(receiver.events, "a finished setup must not send a usage report").toHaveLength(1);

    // Settings shows the stored choice and lets the Owner withdraw it.
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

    // A reload keeps the withdrawn state; nothing resumes the wizard.
    await page.reload();
    await expect(page.getByRole("switch", { name: "Usage statistics" })).not.toBeChecked();
    await expect(page.getByRole("heading", { name: "Help improve Meltiply" })).toHaveCount(0);

    // Phone width and the dark palette stay usable on the disclosure surface.
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

    // A member without ownership reads the same policy and cannot change it.
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

/**
 * Skipping the improvement screen must leave both categories off, transmit
 * nothing, and still allow setup to finish.
 */
test("skips the improvement screen without opting in or transmitting", async ({ browser }) => {
  const receiver = await startEgressReceiver();
  try {
    const { context, page } = await openWizard(browser);
    // Prefer not to say is a local decision: it records the answer, sends nothing.
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

/**
 * An interrupted journey resumes at the same optional screen after a reload and
 * after signing out and back in, with no credential kept in browser storage.
 */
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

    // Reading the improvement screen must not hide the acquisition controls: the
    // feedback read always resolves to a shape, so only a recorded answer may
    // replace the selector.
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

    // Advance to the final screen without completing, then close the browser
    // entirely: the reached screen is durable installation state, so the new
    // session must resume at "You're ready" rather than restarting the optional
    // improvement step.
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're ready", exact: true })).toBeVisible();
    await context.close();

    const restarted = await browser.newContext({ reducedMotion: "reduce" });
    const restartedPage = await restarted.newPage();
    await signIn(restartedPage);
    await expect(
      restartedPage.getByRole("heading", { name: "You're ready", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // The improvement screen must not reappear, and neither category was enabled
    // by the skip.
    await expect(
      restartedPage.getByRole("heading", { name: "Help improve Meltiply", exact: true }),
    ).toHaveCount(0);
    await restarted.close();
  } finally {
    runInstallationFixture("complete");
  }
});

/**
 * A completed installation never reopens the wizard, and registration stays
 * closed once the Owner exists.
 */
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

    // Registration is closed and the setup form never renders again.
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
