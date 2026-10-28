import { createHmac, randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { Pool } from "pg";

import { frontendOrigin } from "./ports";

/**
 * Drives the real `/device` consent page, the actual application proxy, and the
 * production-composed Better Auth device, bearer, JWT, and two-factor endpoints.
 * Nothing is mocked or intercepted with MSW: the browser signs in through the
 * real form, the page claims the pending request through same-origin
 * `/api/auth`, and the CLI steps use the public HTTP contract only.
 *
 * Test credentials are the documented local fixtures. Screenshots are captured
 * only after the review or terminal outcome renders, so passwords, the device
 * code, and JWTs never reach an artifact; traces are disabled for the same
 * reason. Every cookie/token stays in process memory.
 */

const deviceClient = "melti-cli";
const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const gammaEmail = "gamma@meltiply.local";
const gammaPassword = "MeltiplyLocal1!";
const gammaAuthUserId = "auth_user_local_gamma";

test.use({ screenshot: "off", trace: "off" });
test.setTimeout(180_000);

/** Unique documentation-range client IP per journey, isolating auth budgets. */
function clientIp(): string {
  return `2001:db8:${randomUUID().slice(0, 4)}::${Math.floor(Math.random() * 0xffff)}`;
}

/**
 * Headers a native client sends to the installation origin. The browser proxy
 * preserves them, so the same-origin Origin and a distinct edge IP reach the
 * Worker rate limiter exactly as in a real CLI deployment.
 *
 * @param ip - Edge client address for this journey.
 * @param extra - Additional request headers.
 * @returns Header record.
 */
function authHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: frontendOrigin, "cf-connecting-ip": ip, ...extra };
}

/**
 * Narrows parsed JSON to a plain object.
 *
 * @param value - Parsed JSON value.
 * @returns Object view.
 */
function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a required string field from untrusted JSON.
 *
 * @param record - Object to inspect.
 * @param key - Field name.
 * @returns String value.
 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`Expected string ${key}`);
  return value;
}

/**
 * Reads a required finite numeric field from untrusted JSON.
 *
 * @param record - Object to inspect.
 * @param key - Field name.
 * @returns Numeric value.
 */
function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Expected number ${key}`);
  return value;
}

interface IssuedDeviceCode {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

/**
 * Requests a code through the public CLI contract and validates the
 * client-visible shape the separately released CLI depends on.
 *
 * @param api - Playwright HTTP context against the installation origin.
 * @param ip - Edge client address.
 * @returns Issued code and absolute verification links.
 */
async function issueDeviceCode(api: APIRequestContext, ip: string): Promise<IssuedDeviceCode> {
  const response = await api.post("/api/auth/device/code", {
    data: { client_id: deviceClient },
    headers: authHeaders(ip),
  });
  expect(response.status(), "device code issuance").toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = readRecord(await response.json());
  const verificationUri = readString(body, "verification_uri");
  const verificationUriComplete = readString(body, "verification_uri_complete");
  expect(new URL(verificationUri).origin).toBe(frontendOrigin);
  const complete = new URL(verificationUriComplete);
  expect(complete.origin).toBe(frontendOrigin);
  expect(complete.pathname).toBe("/device");
  const userCode = readString(body, "user_code");
  expect(complete.searchParams.get("user_code")).toBe(userCode);
  const deviceCode = readString(body, "device_code");
  expect(deviceCode).not.toBe(userCode);
  expect(verificationUriComplete).not.toContain(deviceCode);
  expect(readNumber(body, "expires_in")).toBe(600);
  expect(readNumber(body, "interval")).toBe(5);
  return {
    deviceCode,
    expiresIn: readNumber(body, "expires_in"),
    interval: readNumber(body, "interval"),
    userCode,
    verificationUri,
    verificationUriComplete,
  };
}

interface DeviceTokenError {
  error: string;
  description: string;
  retryAfter?: number;
}

/**
 * Reads the RFC-style token error envelope.
 *
 * @param response - Non-success token response.
 * @returns Machine error, description, and Retry-After when present.
 */
async function readTokenError(response: APIResponse): Promise<DeviceTokenError> {
  const body = readRecord(await response.json());
  const retryAfter = Number(response.headers()["retry-after"]);
  return {
    description: readString(body, "error_description"),
    error: readString(body, "error"),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  };
}

/**
 * Polls once and returns either the RFC error or the redeemed credential.
 *
 * @param api - Playwright HTTP context.
 * @param deviceCode - Secret device code.
 * @param ip - Edge client address.
 * @returns Status, parsed error, or access token.
 */
async function pollDeviceToken(
  api: APIRequestContext,
  deviceCode: string,
  ip: string,
): Promise<{ error?: DeviceTokenError; status: number; token?: string }> {
  const response = await api.post("/api/auth/device/token", {
    data: {
      client_id: deviceClient,
      device_code: deviceCode,
      grant_type: deviceGrantType,
    },
    headers: authHeaders(ip),
  });
  if (response.status() === 200) {
    const body = readRecord(await response.json());
    expect(body.token_type).toBe("Bearer");
    expect(readNumber(body, "expires_in")).toBeGreaterThan(0);
    return { status: 200, token: readString(body, "access_token") };
  }
  return { error: await readTokenError(response), status: response.status() };
}

/**
 * Waits before retrying a throttled poll.
 *
 * @param milliseconds - Delay duration.
 * @returns Resolves after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

/**
 * Redeems an approved code, honoring the advertised polling interval if the
 * previous observation landed inside the distributed per-device window.
 *
 * @param api - Playwright HTTP context.
 * @param deviceCode - Secret device code.
 * @param ip - Edge client address.
 * @returns Raw CLI session credential.
 */
async function redeemDeviceCode(
  api: APIRequestContext,
  deviceCode: string,
  ip: string,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await pollDeviceToken(api, deviceCode, ip);
    if (result.token) return result.token;
    if (!result.error || result.error.error !== "slow_down") {
      throw new Error(`Device token failed: ${result.error?.error ?? result.status}`);
    }
    await delay((result.error.retryAfter ?? 5) * 1_000 + 250);
  }
  throw new Error("Device token remained throttled after honoring Retry-After");
}

/**
 * Returns a same-origin verification link with an explicit palette intent.
 * The shared bootstrap strips the parameter after applying it, so this is a
 * test presentation control only. It never carries a secret.
 *
 * @param verificationUriComplete - Link returned by the code endpoint.
 * @param palette - Requested palette.
 * @returns Absolute URL with the shared theme query parameter.
 */
function themedVerificationUrl(verificationUriComplete: string, palette: "dark" | "light"): string {
  const url = new URL(verificationUriComplete);
  url.searchParams.set("meltiply-theme", palette);
  return url.toString();
}

/**
 * Fills the real sign-in form without the workspace-session helper's assumed
 * `/posts` destination, so the device return path is observable.
 *
 * @param page - Browser page.
 * @param email - Fixture account.
 * @param password - Fixture password.
 */
async function submitCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

/**
 * Asserts the review context the member compares with the terminal.
 *
 * @param page - Browser page showing the consent review.
 * @param code - Issued device code.
 */
async function expectReview(page: Page, code: IssuedDeviceCode): Promise<void> {
  await expect(page.getByRole("heading", { name: "Approve melti-cli?" })).toBeVisible();
  await expect(page.getByText(code.userCode, { exact: true })).toBeVisible();
  await expect(page.getByText("Requesting client", { exact: true })).toBeVisible();
  await expect(page.getByText(deviceClient, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(gammaEmail, { exact: true })).toBeVisible();
  await expect(page.getByText("Editor", { exact: true })).toBeVisible();
  await expect(page.getByText("Create and edit Posts.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Never approve a code someone sent you/)).toBeVisible();
  const checkbox = page.getByRole("checkbox", {
    name: /code in my terminal matches this code/i,
  });
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Approve melti-cli" })).toBeDisabled();
}

/**
 * Captures a review screenshot in one palette after asserting legibility
 * constraints. Only the consent surface is captured.
 *
 * @param page - Browser page.
 * @param testInfo - Playwright test info for the output path.
 * @param name - Artifact name.
 * @param palette - Expected palette class.
 */
async function captureReview(
  page: Page,
  testInfo: TestInfo,
  name: string,
  palette: "dark" | "light",
): Promise<void> {
  if (palette === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath(`${name}.png`),
  });
}

/**
 * Generates the current authenticator code without retaining the shared secret.
 *
 * @param uri - Enrollment URI returned by the two-factor plugin.
 * @returns Six-digit TOTP for the current window.
 */
function totpCode(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("Expected an authenticator enrollment secret");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Removes the second-factor enrollment a failed retry could otherwise leave on
 * the shared gamma fixture. Direct database access is cleanup only; all policy
 * behavior in the journey is exercised through real HTTP.
 *
 * @returns Nothing.
 */
async function resetSecondFactorFixture(): Promise<void> {
  const connectionString = process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL?.trim();
  if (!connectionString) return;
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/meltiply") {
    throw new Error("Second-factor cleanup requires the dedicated loopback test database");
  }
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`DELETE FROM "session" WHERE "userId" = $1`, [gammaAuthUserId]);
    await pool.query(
      `DELETE FROM "verification"
       WHERE value = $1 AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%')`,
      [gammaAuthUserId],
    );
    await pool.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [gammaAuthUserId]);
    await pool.query(`UPDATE "user" SET "twoFactorEnabled" = FALSE WHERE id = $1`, [
      gammaAuthUserId,
    ]);
  } finally {
    await pool.end();
  }
}

test.beforeAll(async () => {
  await resetSecondFactorFixture();
});

test.afterEach(async () => {
  // A failed retry must not inherit an enrolled factor on the shared fixture.
  await resetSecondFactorFixture();
});

test.afterAll(async () => {
  await resetSecondFactorFixture();
});

test("returns a signed-out member to the pending request and requires explicit approval", async ({
  page,
  request,
}, testInfo) => {
  const ip = clientIp();
  // The application proxy reaches the API with this edge identity, keeping the
  // device and sign-in budgets isolated from other browser journeys.
  await page.route(`${frontendOrigin}/api/auth/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": ip },
    }),
  );

  const code = await issueDeviceCode(request, ip);
  await page.goto(code.verificationUriComplete);

  // Signed out: the same `/device?user_code=…` path is the post-sign-in return.
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  const redirect = new URL(page.url()).searchParams.get("redirect") ?? "";
  expect(redirect).toBe(`/device?user_code=${code.userCode}`);
  await submitCredentials(page, gammaEmail, gammaPassword);
  await expect(page).toHaveURL(new RegExp(`/device\\?user_code=${code.userCode}`));
  await expectReview(page, code);

  // Visiting the link claims the review but never grants. The CLI still sees a
  // pending request until the member acts.
  const pending = await pollDeviceToken(request, code.deviceCode, ip);
  expect(pending.status).toBe(400);
  expect(pending.error?.error).toBe("authorization_pending");

  // Desktop and phone, both palettes. Each reload re-verifies (claims) the same
  // pending request; it cannot approve it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(themedVerificationUrl(code.verificationUriComplete, "light"));
  await expectReview(page, code);
  await captureReview(page, testInfo, "device-consent-desktop-light", "light");
  await page.goto(themedVerificationUrl(code.verificationUriComplete, "dark"));
  await expectReview(page, code);
  await captureReview(page, testInfo, "device-consent-desktop-dark", "dark");

  // The review is a single desktop viewport at 1280×720; no page scroll.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(themedVerificationUrl(code.verificationUriComplete, "light"));
  await expectReview(page, code);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await captureReview(page, testInfo, "device-consent-desktop-compact", "light");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(themedVerificationUrl(code.verificationUriComplete, "light"));
  await expectReview(page, code);
  await captureReview(page, testInfo, "device-consent-mobile-light", "light");
  await page.goto(themedVerificationUrl(code.verificationUriComplete, "dark"));
  await expectReview(page, code);
  await captureReview(page, testInfo, "device-consent-mobile-dark", "dark");

  // Keyboard-only consent: the matching-code checkbox, Deny, then Approve.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(code.verificationUriComplete);
  await expectReview(page, code);
  await page.getByRole("heading", { name: "Approve melti-cli?" }).focus();
  await page.keyboard.press("Tab");
  const checkbox = page.getByRole("checkbox", {
    name: /code in my terminal matches this code/i,
  });
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Deny request" })).toBeFocused();
  await page.keyboard.press("Tab");
  const approve = page.getByRole("button", { name: "Approve melti-cli" });
  await expect(approve).toBeFocused();
  await expect(approve).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "melti-cli is approved" })).toBeVisible();

  // The CLI redeems its own session and uses JWTs for the existing API.
  const accessToken = await redeemDeviceCode(request, code.deviceCode, ip);
  const sessionResponse = await request.get("/api/auth/get-session", {
    headers: authHeaders(ip, { Authorization: `Bearer ${accessToken}` }),
  });
  expect(sessionResponse.status(), "CLI session transport").toBe(200);
  const sessionBody = readRecord(await sessionResponse.json());
  expect(readString(readRecord(sessionBody.user), "email")).toBe(gammaEmail);
  const jwt = sessionResponse.headers()["set-auth-jwt"];
  expect(jwt).toBeTruthy();
  const authorized = await request.get("/api/v1/posts", {
    headers: authHeaders(ip, { Authorization: `Bearer ${jwt}` }),
  });
  expect(authorized.status(), "CLI JWT authorization").toBe(200);
  const rawCredential = await request.get("/api/v1/posts", {
    headers: authHeaders(ip, { Authorization: `Bearer ${accessToken}` }),
  });
  expect(rawCredential.status()).toBe(401);

  // CLI logout revokes only the CLI session; the approving browser remains.
  const signOut = await request.post("/api/auth/sign-out", {
    data: {},
    headers: authHeaders(ip, { Authorization: `Bearer ${accessToken}` }),
  });
  expect(signOut.status(), "CLI sign-out").toBe(200);
  const revokedSession = await request.get("/api/auth/get-session", {
    headers: authHeaders(ip, { Authorization: `Bearer ${accessToken}` }),
  });
  expect(revokedSession.status()).toBe(200);
  expect(await revokedSession.json()).toBeNull();
  const revokedJwt = await request.get("/api/v1/posts", {
    headers: authHeaders(ip, { Authorization: `Bearer ${jwt}` }),
  });
  expect(revokedJwt.status()).toBe(401);
  await page.goto("/posts");
  await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();

  // A second, independent request can be denied explicitly and reports the
  // terminal rejection to the CLI without minting a session.
  const deniedCode = await issueDeviceCode(request, ip);
  await page.goto(deniedCode.verificationUriComplete);
  await expectReview(page, deniedCode);
  await page.getByRole("button", { name: "Deny request" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  // Reopening a completed request reports the terminal state instead of
  // offering stale decision controls. Read that before the CLI consumes the
  // one-time denial response.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "This request was already denied" }),
  ).toBeVisible();
  const denied = await pollDeviceToken(request, deniedCode.deviceCode, ip);
  expect(denied.status).toBe(400);
  expect(denied.error?.error).toBe("access_denied");
});

test("preserves the second-factor challenge and returns to the pending device request", async ({
  page,
  request,
}, testInfo) => {
  const ip = clientIp();
  await page.route(`${frontendOrigin}/api/auth/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": ip },
    }),
  );

  // Enroll through the real auth endpoints. The enrollment response's
  // totpURI and the generated code stay in memory.
  const enrollment = await request.post("/api/auth/sign-in/email", {
    data: { email: gammaEmail, password: gammaPassword },
    headers: authHeaders(ip),
  });
  expect(enrollment.status(), "fixture sign-in").toBe(200);
  const enable = await request.post("/api/auth/two-factor/enable", {
    data: { password: gammaPassword },
    headers: authHeaders(ip),
  });
  expect(enable.status(), "two-factor enrollment").toBe(200);
  const enrollmentBody = readRecord(await enable.json());
  const totpURI = readString(enrollmentBody, "totpURI");
  expect(Array.isArray(enrollmentBody.backupCodes)).toBe(true);
  const confirmed = await request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totpCode(totpURI), trustDevice: false },
    headers: authHeaders(ip),
  });
  expect(confirmed.status(), "two-factor confirmation").toBe(200);

  const code = await issueDeviceCode(request, ip);
  await page.goto(code.verificationUriComplete);
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  await submitCredentials(page, gammaEmail, gammaPassword);

  // Password alone is not enough: the same sign-in screen switches to the
  // authenticator challenge, and no device review is reachable yet.
  await expect(page.getByRole("heading", { name: "One more security check." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve melti-cli?" })).not.toBeVisible();
  await page.getByLabel(/authenticator code/i).fill(totpCode(totpURI));
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/device\\?user_code=${code.userCode}`));
  await expect(page.getByRole("heading", { name: "Approve melti-cli?" })).toBeVisible();

  const checkbox = page.getByRole("checkbox", {
    name: /code in my terminal matches this code/i,
  });
  await checkbox.check();
  await page.getByRole("button", { name: "Approve melti-cli" }).click();
  await expect(page.getByRole("heading", { name: "melti-cli is approved" })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("device-consent-two-factor-approved.png"),
  });

  const accessToken = await redeemDeviceCode(request, code.deviceCode, ip);
  expect(accessToken.length).toBeGreaterThan(20);

  // Restore the shared fixture through the authenticated browser session.
  const disable = await page.request.post(`${frontendOrigin}/api/auth/two-factor/disable`, {
    data: { password: gammaPassword },
    headers: { Origin: frontendOrigin },
  });
  expect(disable.status(), "two-factor disable").toBe(200);
});
