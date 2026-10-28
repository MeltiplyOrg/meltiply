import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createJwtVerifier, jwtClaims, type JwtIdentity } from "@meltiply/auth";

import { activeIdentity } from "../src/auth-policy";
import { createApiApp } from "../src/app";
import { betterAuthFor } from "../src/better-auth";
import { CoreApiError } from "../src/core-types";
import { systemPoolFor } from "../src/database";
import { applicationOrigin, type ApiWorkerEnv } from "../src/env";

/**
 * Drives the complete melti-cli device-authorization lifecycle through the real
 * production composition: the Hono API app, `betterAuthFor` →
 * `createBetterAuth` → installed Better Auth device-authorization, bearer, JWT,
 * and two-factor plugins, the database-backed auth rate limiter, and the
 * tenant API authorization pipeline.
 *
 * The auth endpoints use the public migrated Better Auth tables so the seeded
 * Workspace members can sign in with their real credentials; the tenant API
 * assertions use the RLS-authenticated role from `MELTIPLY_DATABASE_TEST_URL`.
 * No plugin internals, private calls, or source text are asserted — every
 * expectation is an HTTP result or a subsequently allowed/denied HTTP request.
 *
 * Fixture isolation: device codes and auth rate-limit rows are cleared around
 * each case, sessions created by a case are deleted afterwards, and the two
 * dedicated accounts are removed in `afterAll`. The seeded Workspace members
 * and their content are never mutated.
 */

const authenticatedConnectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!authenticatedConnectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

/** Privileged local role retained for Better Auth tables and fixture setup. */
const systemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";

/** Canonical installation origin used for auth requests and verification links. */
const authOrigin = "https://auth.test";
/** Trusted browser origin used for credentialed sign-in and consent requests. */
const appOrigin = "https://app.test";
const seedPassword = "MeltiplyLocal1!";
/** Same scrypt hash the local seed uses for every fixture member. */
const seedPasswordHash =
  "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d:51ebb76380734dbeaa0619246752b97221ef1ebff0304296c848df2b68974f91a7c07a7d5f2abd36638784a22f8161967d2b7d089c2b5e1b4fe65d72f9977914";
const authSecret = "meltiply-local-auth-secret-32-chars-long";
const seededProfileId = "c0000000-0000-4000-8000-000000000001";
const gammaAuthUserId = "auth_user_local_gamma";
const gammaEmail = "gamma@meltiply.local";
const deltaAuthUserId = "auth_user_local_delta";
const deltaEmail = "delta@meltiply.local";

/**
 * Dedicated auth fixtures for lifecycle cases that must not mutate seeded
 * members. All use the seeded password hash, so the real sign-in endpoint
 * issues the browser session rather than a synthetic cookie, and each joins the
 * shared Workspace so token eligibility is decided by the policy under test
 * rather than by missing membership.
 */
const suspendedAuthUserId = "auth_user_device_suspended";
const suspendedEmail = "device-suspended@meltiply.local";
const suspendedInternalUserId = "10000000-0000-4000-8000-00000000d001";
const rateLimitAuthUserId = "auth_user_device_rate_limit";
const rateLimitEmail = "device-rate-limit@meltiply.local";
const rateLimitInternalUserId = "10000000-0000-4000-8000-00000000d002";
const twoFactorAuthUserId = "auth_user_device_two_factor";
const twoFactorEmail = "device-two-factor@meltiply.local";
const twoFactorInternalUserId = "10000000-0000-4000-8000-00000000d003";
const unverifiedAuthUserId = "auth_user_device_unverified";
const unverifiedEmail = "device-unverified@meltiply.local";
const unverifiedInternalUserId = "10000000-0000-4000-8000-00000000d004";
const securityAuthUserId = "auth_user_device_security";
const securityEmail = "device-security@meltiply.local";
const securityInternalUserId = "10000000-0000-4000-8000-00000000d005";

/** The single shared Workspace, resolved by `deviceSessionEligibility`. */
const sharedOrganizationId = "20000000-0000-4000-8000-000000000005";
/** Seeded member password reused by every dedicated fixture. */
const dedicatedPassword = seedPassword;

const dedicatedAccounts = [
  { authUserId: suspendedAuthUserId, email: suspendedEmail, internalId: suspendedInternalUserId },
  { authUserId: rateLimitAuthUserId, email: rateLimitEmail, internalId: rateLimitInternalUserId },
  { authUserId: twoFactorAuthUserId, email: twoFactorEmail, internalId: twoFactorInternalUserId },
  {
    authUserId: unverifiedAuthUserId,
    email: unverifiedEmail,
    internalId: unverifiedInternalUserId,
  },
  { authUserId: securityAuthUserId, email: securityEmail, internalId: securityInternalUserId },
] as const;

const trackedAuthUserIds = [
  "auth_user_local_alpha",
  "auth_user_local_beta",
  gammaAuthUserId,
  deltaAuthUserId,
  "auth_user_local_epsilon",
  ...dedicatedAccounts.map((account) => account.authUserId),
];

const env = {
  ALLOWED_ORIGINS: appOrigin,
  APP_URL: authOrigin,
  AUTH_SETUP_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  AUTOMATION: {
    relayOutbox: async () => ({ claimed: 0, dead: 0, failed: 0, published: 0 }),
    requestCommentsSync: async () => 0,
  },
  BETTER_AUTH_SECRET: authSecret,
  DB_AUTHENTICATED: { connectionString: authenticatedConnectionString } as Hyperdrive,
  DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

/**
 * Deployed-policy composition over the same database: HTTPS installation
 * origin, required mailbox verification, and a recording mail binding. Only
 * requests that need the stricter policy use this environment; lifecycle cases
 * reuse the local test composition above.
 */
const verifiedMailBinding: SendEmail = {
  send: async () => ({ messageId: "device-verification-test" }),
};
const verificationOrigin = "https://auth.test";
const verificationAppOrigin = "https://app.test";
const verificationEnv = {
  ...env,
  ALLOWED_ORIGINS: verificationAppOrigin,
  APP_URL: verificationOrigin,
  ENVIRONMENT: "staging",
  MAIL: verifiedMailBinding,
  MAIL_FROM_ADDRESS: "no-reply@meltiply.test",
  MAIL_FROM_NAME: "Meltiply Test",
} satisfies ApiWorkerEnv;
const verificationApp = createApiApp();

/** Lazily resolves the installed signing key once, mirroring the API verifier. */
let localJwtVerifier: ((token: string) => Promise<JwtIdentity>) | undefined;

/**
 * Builds a JWT verifier from the live `/jwks` response instead of the network,
 * so the API request assertions exercise real signature/issuer/audience checks.
 *
 * @returns Verifier bound to the installation origin.
 */
async function jwtVerifier(): Promise<(token: string) => Promise<JwtIdentity>> {
  if (localJwtVerifier) return localJwtVerifier;
  const auth = await betterAuthFor(env);
  const published = recordOf(
    await (await auth.handler(new Request(`${authOrigin}/api/auth/jwks`))).json(),
  );
  if (!Array.isArray(published.keys)) throw new Error("Expected published verification keys");
  const publicKey = recordOf(published.keys[0]);
  if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || typeof publicKey.x !== "string")
    throw new Error("Unexpected auth signing algorithm");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  localJwtVerifier = createJwtVerifier(
    { audience: authOrigin, issuer: authOrigin },
    async () => key,
  );
  return localJwtVerifier;
}

const app = createApiApp({
  // The production default verifier maps signature/issuer/audience failures to
  // the authenticated 401 envelope; this seam supplies the same key source
  // without a network round-trip and must preserve that normalization so a
  // malformed bearer (including a raw CLI session credential) cannot surface as
  // an unhandled 500. `activeIdentity` still performs the live-session and
  // membership checks after signature verification.
  verifyJwtToken: async (requestEnv, token) => {
    let identity: JwtIdentity;
    try {
      identity = await (await jwtVerifier())(token);
    } catch {
      throw new CoreApiError(401, "authentication_required", "Authentication is required.");
    }
    return activeIdentity(requestEnv, identity);
  },
});

/**
 * Narrows untrusted JSON to a plain record without unchecked `any` access.
 *
 * @param value - Parsed JSON value.
 * @returns A record view of the object.
 */
function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected JSON object, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a required string field from an untrusted JSON object.
 *
 * @param value - Record to inspect.
 * @param key - Field name.
 * @returns The string value.
 */
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`expected string ${key}`);
  return field;
}

/**
 * Reads a required numeric field from an untrusted JSON object.
 *
 * @param value - Record to inspect.
 * @param key - Field name.
 * @returns The number value.
 */
function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field))
    throw new Error(`expected number ${key}`);
  return field;
}

/**
 * Extracts the session cookie pair from a response's separate Set-Cookie headers.
 *
 * @param response - Sign-in response.
 * @returns `name=value` cookie pair for the session token.
 */
function sessionCookiePair(response: Response): string {
  const header = response.headers.getSetCookie().find((entry) => entry.includes("session_token="));
  if (!header) throw new Error("response must set the session cookie");
  return header.split(";")[0]!;
}

/**
 * Joins every cookie pair a response sets, preserving an in-progress two-factor
 * challenge as well as any session cookie.
 *
 * @param response - Auth response that may set challenge or session cookies.
 * @returns Cookie header value, or an empty string when none were set.
 */
function cookieHeaderFor(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
}

/**
 * Sends a request through the production app with an installation-origin URL.
 *
 * @param path - Path under the auth surface.
 * @param init - Fetch initializer.
 * @param host - Absolute origin to exercise forwarded-origin behavior.
 * @returns HTTP response.
 */
function authRequest(path: string, init: RequestInit = {}, host = authOrigin): Promise<Response> {
  return Promise.resolve(app.request(`${host}${path}`, init, env));
}

/**
 * Posts JSON to an auth endpoint as a browser would.
 *
 * @param path - Auth path.
 * @param body - JSON body.
 * @param options - Cookie, origin, and client IP overrides.
 * @returns HTTP response.
 */
function authPostJson(
  path: string,
  body: Record<string, unknown>,
  options: { cookie?: string; ip?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": options.ip ?? randomIp(),
    "Content-Type": "application/json",
  };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin !== null) headers.Origin = options.origin ?? appOrigin;
  return authRequest(path, { body: JSON.stringify(body), headers, method: "POST" });
}

/**
 * Returns a unique client IP so per-IP auth budgets from earlier cases never
 * bleed into the next one.
 *
 * @returns IPv6 documentation-range address.
 */
function randomIp(): string {
  return `2001:db8:${crypto.randomUUID().slice(0, 4)}::${Math.floor(Math.random() * 0xffff)}`;
}

/**
 * Posts JSON through the deployed-policy composition, used only where required
 * mailbox verification changes the outcome.
 *
 * @param path - Auth path.
 * @param body - JSON body.
 * @param options - Optional cookie and client IP.
 * @returns HTTP response.
 */
function verificationPostJson(
  path: string,
  body: Record<string, unknown>,
  options: { cookie?: string; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": options.ip ?? randomIp(),
    "Content-Type": "application/json",
    Origin: verificationAppOrigin,
  };
  if (options.cookie) headers.Cookie = options.cookie;
  return Promise.resolve(
    verificationApp.request(
      `${verificationOrigin}${path}`,
      { body: JSON.stringify(body), headers, method: "POST" },
      verificationEnv,
    ),
  );
}

/**
 * Generates the current six-digit authenticator code for an enrollment URI
 * without logging or retaining the shared secret.
 *
 * @param uri - `otpauth://` enrollment URI returned by the two-factor plugin.
 * @returns Six-digit TOTP for the current thirty-second window.
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
 * Signs a seeded or dedicated credential account in through the real endpoint.
 *
 * @param email - Account email.
 * @param ip - Optional client IP override.
 * @returns Browser cookie and decoded user identity.
 */
async function signIn(
  email: string,
  ip = randomIp(),
): Promise<{ cookie: string; userId: string; response: Response }> {
  const response = await authPostJson(
    "/api/auth/sign-in/email",
    { email, password: seedPassword },
    { ip },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = recordOf(await response.json());
  const user = recordOf(body.user);
  return {
    cookie: sessionCookiePair(response),
    response,
    userId: stringField(user, "id"),
  };
}

/**
 * Requests a device code through the public HTTP contract.
 *
 * @param options - Optional client id, body overrides, client IP, and host.
 * @returns Issued device-code payload and status.
 */
async function issueDeviceCode(
  options: {
    body?: Record<string, unknown>;
    clientId?: string;
    host?: string;
    ip?: string;
    origin?: string | null;
  } = {},
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const response = await authPostJson(
    "/api/auth/device/code",
    {
      client_id: options.clientId ?? "melti-cli",
      ...options.body,
    },
    {
      ip: options.ip,
      origin: options.origin === undefined ? authOrigin : options.origin,
    },
  );
  return { body: response.ok ? recordOf(await response.json()) : {}, response };
}

/**
 * Verifies/claims a user code with the browser session.
 *
 * @param cookie - Browser session cookie.
 * @param userCode - User-facing code.
 * @param ip - Optional client IP override.
 * @returns HTTP response.
 */
function verifyDeviceCode(cookie: string | undefined, userCode: string, ip = randomIp()) {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (cookie) headers.Cookie = cookie;
  return authRequest(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { headers });
}

/**
 * Approves or denies a device request with the browser session.
 *
 * @param cookie - Browser session cookie.
 * @param decision - Approval or denial.
 * @param userCode - User-facing code.
 * @param ip - Optional client IP override.
 * @returns HTTP response.
 */
function decideDeviceCode(
  cookie: string | undefined,
  decision: "approve" | "deny",
  userCode: string,
  ip = randomIp(),
) {
  return authPostJson(
    `/api/auth/device/${decision}`,
    { userCode },
    { cookie, ip, origin: appOrigin },
  );
}

/**
 * Redeems a device code for the raw CLI session credential.
 *
 * @param deviceCode - Secret device code.
 * @param options - Optional client id and client IP.
 * @returns HTTP response.
 */
function redeemDeviceCode(
  deviceCode: string,
  options: { clientId?: string; ip?: string } = {},
): Promise<Response> {
  return authPostJson(
    "/api/auth/device/token",
    {
      client_id: options.clientId ?? "melti-cli",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    { ip: options.ip, origin: authOrigin },
  );
}

/**
 * Reads the RFC-style `error` and `error_description` fields.
 *
 * @param response - Token or verification error response.
 * @returns Decoded error fields.
 */
async function deviceError(response: Response): Promise<{ error: string; description: string }> {
  const body = recordOf(await response.json());
  return {
    description: stringField(body, "error_description"),
    error: stringField(body, "error"),
  };
}

/**
 * Calls get-session with the CLI session credential as a bearer token.
 *
 * @param token - Raw or signed CLI session credential.
 * @param ip - Optional client IP override.
 * @returns HTTP response.
 */
function getSessionWithBearer(token: string, ip = randomIp()): Promise<Response> {
  return authRequest("/api/auth/get-session", {
    headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": ip },
  });
}

/**
 * Calls get-session with the browser cookie.
 *
 * @param cookie - Browser session cookie.
 * @returns HTTP response.
 */
function getSessionWithCookie(cookie: string): Promise<Response> {
  return authRequest("/api/auth/get-session", {
    headers: { Cookie: cookie, "CF-Connecting-IP": randomIp() },
  });
}

/**
 * Signs the CLI session out through the bearer transport.
 *
 * @param token - CLI session credential.
 * @param ip - Optional client IP override.
 * @returns HTTP response.
 */
function signOutWithBearer(token: string, ip = randomIp()): Promise<Response> {
  return Promise.resolve(
    app.request(
      `${authOrigin}/api/auth/sign-out`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ip,
          Origin: appOrigin,
        },
        method: "POST",
      },
      env,
    ),
  );
}

/**
 * Issues a request to the tenant API with the supplied Authorization header.
 *
 * @param path - `/api/v1` path.
 * @param authorization - Raw Authorization header value.
 * @param init - Optional method/body/headers.
 * @returns HTTP response.
 */
function tenantRequest(
  path: string,
  authorization: string,
  init: { body?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        body: init.body,
        headers: {
          Authorization: authorization,
          "CF-Connecting-IP": randomIp(),
          "Content-Type": "application/json",
          Origin: appOrigin,
          ...init.headers,
        },
        method: init.method ?? "GET",
      },
      env,
    ),
  );
}

/**
 * Inserts one dedicated credential account, its internal member row, and its
 * shared-Workspace membership using the same password hash as the local seed.
 * Re-running resets mutable policy state so a retried suite starts clean.
 *
 * @param input - Auth subject, internal id, email, mailbox verification, and role.
 * @returns Nothing.
 */
async function createDedicatedAccount(input: {
  authUserId: string;
  email: string;
  internalId: string;
  emailVerified?: boolean;
  role?: "admin" | "editor" | "viewer";
}): Promise<void> {
  const pool = systemPoolFor(env);
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "twoFactorEnabled")
     VALUES ($1, $2, $3, $4, FALSE)
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         email = EXCLUDED.email,
         "emailVerified" = EXCLUDED."emailVerified",
         "twoFactorEnabled" = FALSE`,
    [input.authUserId, "Device Fixture", input.email, input.emailVerified ?? true],
  );
  await pool.query(
    `INSERT INTO "account" (id, "accountId", "providerId", "userId", password)
     VALUES ($1, $2, 'credential', $3, $4)
     ON CONFLICT (id) DO UPDATE
     SET password = EXCLUDED.password, "updatedAt" = now()`,
    [`${input.authUserId}_account`, input.authUserId, input.authUserId, seedPasswordHash],
  );
  await pool.query(
    `INSERT INTO users (id, auth_user_id, email, display_name, installation_owner, suspended_at, suspension_reason)
     VALUES ($1, $2, $3, 'Device Fixture', FALSE, NULL, NULL)
     ON CONFLICT (id) DO UPDATE
     SET auth_user_id = EXCLUDED.auth_user_id,
         email = EXCLUDED.email,
         suspended_at = NULL,
         suspension_reason = NULL`,
    [input.internalId, input.authUserId, input.email],
  );
  await pool.query(
    `INSERT INTO org_members (id, org_id, user_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [crypto.randomUUID(), sharedOrganizationId, input.internalId, input.role ?? "editor"],
  );
  await pool.query(`DELETE FROM "session" WHERE "userId" = $1`, [input.authUserId]);
  await pool.query(`DELETE FROM "twoFactor" WHERE "userId" = $1`, [input.authUserId]);
}

/**
 * Removes a dedicated fixture account and everything cascading from it.
 *
 * @param authUserId - Auth subject id.
 */
async function deleteDedicatedAccount(authUserId: string): Promise<void> {
  const pool = systemPoolFor(env);
  await pool.query(`DELETE FROM users WHERE auth_user_id = $1`, [authUserId]);
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [authUserId]);
}

/** Records session ids that pre-date a case so only the case's sessions are removed. */
let priorSessionIds: string[] = [];

/**
 * Reads all session ids for the tracked auth users.
 *
 * @returns Session ids.
 */
async function trackedSessionIds(): Promise<string[]> {
  const result = await systemPoolFor(env).query<{ id: string }>(
    `SELECT id FROM "session" WHERE "userId" = ANY($1::text[])`,
    [trackedAuthUserIds],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Advances past the distributed five-second token-polling window without
 * sleeping, so the next HTTP request observes the plugin's own polling state
 * rather than the Worker-level budget denial. Production behavior is unchanged;
 * this is the test equivalent of waiting for the advertised interval.
 */
async function advanceTokenPollingWindow(): Promise<void> {
  await systemPoolFor(env).query(`DELETE FROM auth_rate_limits WHERE action = 'device-token'`);
}

beforeAll(async () => {
  const url = new URL(systemConnectionString);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/meltiply")
    throw new Error("Device auth tests require the isolated local database.");
  for (const account of dedicatedAccounts) {
    await createDedicatedAccount(account);
  }
});

beforeEach(async () => {
  const pool = systemPoolFor(env);
  const present = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public."deviceCode"') IS NOT NULL AS present`,
  );
  if (present.rows[0]?.present) await pool.query(`DELETE FROM "deviceCode"`);
  await pool.query(`DELETE FROM auth_rate_limits`);
  await pool.query(
    `UPDATE users SET suspended_at = NULL, suspension_reason = NULL
    WHERE id = ANY($1::uuid[])`,
    [
      [
        suspendedInternalUserId,
        rateLimitInternalUserId,
        twoFactorInternalUserId,
        unverifiedInternalUserId,
        securityInternalUserId,
      ],
    ],
  );
  // Reset mutable auth policy state a prior case may have exercised, then drop
  // every session it created so each case starts from the seeded baseline.
  await pool.query(
    `UPDATE "user" SET "emailVerified" = TRUE, "twoFactorEnabled" = FALSE
     WHERE id = ANY($1::text[])`,
    [dedicatedAccounts.map((account) => account.authUserId)],
  );
  await pool.query(
    `UPDATE "account" SET password = $2, "updatedAt" = now()
     WHERE "userId" = ANY($1::text[])`,
    [dedicatedAccounts.map((account) => account.authUserId), seedPasswordHash],
  );
  await pool.query(`DELETE FROM "twoFactor" WHERE "userId" = ANY($1::text[])`, [
    dedicatedAccounts.map((account) => account.authUserId),
  ]);
  await pool.query(`DELETE FROM "session" WHERE "userId" = ANY($1::text[])`, [
    dedicatedAccounts.map((account) => account.authUserId),
  ]);
  priorSessionIds = await trackedSessionIds();
});

afterEach(async () => {
  const pool = systemPoolFor(env);
  await pool.query(
    `DELETE FROM "session"
     WHERE "userId" = ANY($1::text[])
       AND NOT (id = ANY($2::text[]))`,
    [trackedAuthUserIds, priorSessionIds],
  );
  await pool.query(
    `UPDATE users SET suspended_at = NULL, suspension_reason = NULL
    WHERE id = ANY($1::uuid[])`,
    [
      [
        suspendedInternalUserId,
        rateLimitInternalUserId,
        twoFactorInternalUserId,
        unverifiedInternalUserId,
        securityInternalUserId,
      ],
    ],
  );
});

afterAll(async () => {
  for (const account of dedicatedAccounts) {
    await deleteDedicatedAccount(account.authUserId);
  }
});

describe("device code issuance contract", () => {
  it("issues an unpredictable code bound to melti-cli with absolute same-origin verification links", async () => {
    const { body, response } = await issueDeviceCode({ host: "http://api.internal.test" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const deviceCode = stringField(body, "device_code");
    const userCode = stringField(body, "user_code");
    expect(deviceCode.length).toBeGreaterThanOrEqual(32);
    expect(deviceCode).not.toBe(userCode);
    expect(numberField(body, "expires_in")).toBe(600);
    expect(numberField(body, "interval")).toBe(5);
    expect(stringField(body, "verification_uri")).toBe(`${authOrigin}/device`);

    const complete = new URL(stringField(body, "verification_uri_complete"));
    expect(complete.origin).toBe(authOrigin);
    expect(complete.pathname).toBe("/device");
    expect(complete.searchParams.get("user_code")).toBe(userCode);
    expect(complete.toString()).not.toContain(deviceCode);
  });

  it("rejects unsupported clients, pre-bound users, non-JSON bodies, and untrusted origins", async () => {
    const wrongClient = await issueDeviceCode({ clientId: "some-other-cli" });
    expect(wrongClient.response.status).toBe(400);
    expect(await deviceError(wrongClient.response)).toMatchObject({ error: "invalid_client" });
    const paddedClient = await issueDeviceCode({ clientId: " melti-cli " });
    expect(paddedClient.response.status).toBe(400);
    expect(await deviceError(paddedClient.response)).toMatchObject({ error: "invalid_client" });

    const prebound = await issueDeviceCode({
      body: { user_id: gammaAuthUserId },
    });
    expect(prebound.response.status).toBe(400);
    expect(await deviceError(prebound.response)).toMatchObject({ error: "invalid_request" });

    const form = await authRequest("/api/auth/device/code", {
      body: "client_id=melti-cli",
      headers: {
        "CF-Connecting-IP": randomIp(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(form.status).toBe(400);
    expect(await deviceError(form)).toMatchObject({ error: "invalid_request" });

    const untrusted = await issueDeviceCode({ origin: "http://evil.test" });
    expect(untrusted.response.status).toBe(403);
  });
});

describe("browser verification and consent ownership", () => {
  it("claims, approves, and redeems exactly once while binding approval to the verifying session", async () => {
    const first = await signIn(gammaEmail);
    const second = await signIn(gammaEmail);
    expect(first.userId).toBe(second.userId);
    expect(first.cookie).not.toBe(second.cookie);

    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    const deviceCode = stringField(body, "device_code");

    const verified = await verifyDeviceCode(first.cookie, userCode);
    expect(verified.status).toBe(200);
    const review = recordOf(await verified.json());
    expect(review).toMatchObject({
      client_id: "melti-cli",
      status: "pending",
      user_code: userCode,
    });

    // A second browser session for the same member cannot consent for the
    // session that verified the code, even though Better Auth binds ownership
    // to the member.
    const sameMemberOtherSession = await decideDeviceCode(second.cookie, "approve", userCode);
    expect(sameMemberOtherSession.status).toBe(403);
    expect(await deviceError(sameMemberOtherSession)).toMatchObject({ error: "access_denied" });

    const approved = await decideDeviceCode(first.cookie, "approve", userCode);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ success: true });

    const redeemed = await redeemDeviceCode(deviceCode);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toContain("no-store");
    const token = recordOf(await redeemed.json());
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("");
    expect(numberField(token, "expires_in")).toBeGreaterThan(0);
    expect(typeof token.access_token).toBe("string");

    await advanceTokenPollingWindow();
    const replay = await redeemDeviceCode(deviceCode);
    expect(replay.status).toBe(400);
    expect(await deviceError(replay)).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses approval from a different member and never claims their verification view", async () => {
    const gamma = await signIn(gammaEmail);
    const delta = await signIn(deltaEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");

    const gammaView = await verifyDeviceCode(gamma.cookie, userCode);
    expect(gammaView.status).toBe(200);

    const deltaView = await verifyDeviceCode(delta.cookie, userCode);
    expect(deltaView.status).toBe(200);
    const unclaimedView = recordOf(await deltaView.json());
    expect(unclaimedView.status).toBe("pending");
    expect(unclaimedView.client_id).toBeUndefined();

    const deltaDecision = await decideDeviceCode(delta.cookie, "approve", userCode);
    expect(deltaDecision.status).toBe(403);
    expect(await deviceError(deltaDecision)).toMatchObject({ error: "access_denied" });

    expect((await decideDeviceCode(gamma.cookie, "approve", userCode)).status).toBe(200);
  });

  it("denies a pending request after its claiming browser session ends instead of re-claiming it", async () => {
    const claiming = await signIn(gammaEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    const deviceCode = stringField(body, "device_code");
    expect((await verifyDeviceCode(claiming.cookie, userCode)).status).toBe(200);

    const signedOut = await authPostJson("/api/auth/sign-out", {}, { cookie: claiming.cookie });
    expect(signedOut.status).toBe(200);

    const replacement = await signIn(gammaEmail);
    const verification = await verifyDeviceCode(replacement.cookie, userCode);
    expect(verification.status).toBe(200);
    expect(recordOf(await verification.json()).status).toBe("denied");

    const approval = await decideDeviceCode(replacement.cookie, "approve", userCode);
    expect(approval.status).toBe(400);
    expect(await deviceError(approval)).toMatchObject({ error: "invalid_request" });

    const redemption = await redeemDeviceCode(deviceCode);
    expect(redemption.status).toBe(400);
    expect(await deviceError(redemption)).toMatchObject({ error: "access_denied" });
  });

  it("requires an authenticated browser session for approval, denial, and claims", async () => {
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");

    const anonymousView = await verifyDeviceCode(undefined, userCode);
    expect(anonymousView.status).toBe(200);
    const anonymousReview = recordOf(await anonymousView.json());
    expect(anonymousReview.status).toBe("pending");
    expect(anonymousReview.client_id).toBeUndefined();

    for (const decision of ["approve", "deny"] as const) {
      const response = await decideDeviceCode(undefined, decision, userCode);
      expect(response.status).toBe(401);
      expect(await deviceError(response)).toMatchObject({ error: "unauthorized" });
    }

    const { body: pending } = await issueDeviceCode();
    const pendingToken = await redeemDeviceCode(stringField(pending, "device_code"));
    expect(pendingToken.status).toBe(400);
    expect(await deviceError(pendingToken)).toMatchObject({ error: "authorization_pending" });
  });

  it("denies access, reports access_denied once, and rejects malformed or unknown codes", async () => {
    const { cookie } = await signIn(gammaEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    const deviceCode = stringField(body, "device_code");

    expect((await verifyDeviceCode(cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(cookie, "deny", userCode)).status).toBe(200);

    const denied = await redeemDeviceCode(deviceCode);
    expect(denied.status).toBe(400);
    expect(await deviceError(denied)).toMatchObject({ error: "access_denied" });

    await advanceTokenPollingWindow();
    const replay = await redeemDeviceCode(deviceCode);
    expect(replay.status).toBe(400);
    expect(await deviceError(replay)).toMatchObject({ error: "invalid_grant" });

    const malformedView = await verifyDeviceCode(cookie, "NOT-A-CODE");
    expect(malformedView.status).toBe(400);
    expect(await deviceError(malformedView)).toMatchObject({ error: "invalid_request" });

    const unknown = await redeemDeviceCode(`unknown-${crypto.randomUUID()}`);
    expect(unknown.status).toBe(400);
    expect(await deviceError(unknown)).toMatchObject({ error: "invalid_grant" });
  });

  it("expires pending authorization without minting a session", async () => {
    const { cookie } = await signIn(gammaEmail);
    const expiredViewCode = await issueDeviceCode();
    const expiredTokenCode = await issueDeviceCode();
    const pool = systemPoolFor(env);
    await pool.query(
      `UPDATE "deviceCode" SET "expiresAt" = now() - interval '1 second'
       WHERE "deviceCode" = ANY($1::text[])`,
      [
        [
          stringField(expiredViewCode.body, "device_code"),
          stringField(expiredTokenCode.body, "device_code"),
        ],
      ],
    );

    const expiredView = await verifyDeviceCode(
      cookie,
      stringField(expiredViewCode.body, "user_code"),
    );
    expect(expiredView.status).toBe(400);
    expect(await deviceError(expiredView)).toMatchObject({ error: "expired_token" });

    const expiredToken = await redeemDeviceCode(stringField(expiredTokenCode.body, "device_code"));
    expect(expiredToken.status).toBe(400);
    expect(await deviceError(expiredToken)).toMatchObject({ error: "expired_token" });
  });

  it("reports slow_down for polling faster than the advertised interval", async () => {
    const { body } = await issueDeviceCode();
    const deviceCode = stringField(body, "device_code");
    const ip = randomIp();

    const first = await redeemDeviceCode(deviceCode, { ip });
    expect(first.status).toBe(400);
    expect(await deviceError(first)).toMatchObject({ error: "authorization_pending" });

    // Clear only the Worker-level window so this request exercises Better
    // Auth's own lastPolledAt interval check for a too-frequent poll.
    await advanceTokenPollingWindow();
    const tooFast = await redeemDeviceCode(deviceCode, { ip });
    expect(tooFast.status).toBe(400);
    expect(await deviceError(tooFast)).toMatchObject({ error: "slow_down" });
  });

  it("rejects a token request bound to a different client", async () => {
    const { body } = await issueDeviceCode();
    const response = await redeemDeviceCode(stringField(body, "device_code"), {
      clientId: "another-client",
    });
    expect(response.status).toBe(400);
    expect(await deviceError(response)).toMatchObject({ error: "invalid_grant" });
  });

  it("allows only one of two concurrent redemptions", async () => {
    const { cookie } = await signIn(gammaEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    const deviceCode = stringField(body, "device_code");
    expect((await verifyDeviceCode(cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(cookie, "approve", userCode)).status).toBe(200);

    const sessionsBefore = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [gammaAuthUserId],
    );

    const responses = await Promise.all([
      redeemDeviceCode(deviceCode),
      redeemDeviceCode(deviceCode),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const rejection = responses.find((response) => response.status !== 200)!;
    expect(rejection.status).toBe(400);
    // The distributed per-device poll budget may reject the concurrent retry
    // before the plugin's atomic consume; either way the first redemption owns
    // the code and no second session may be minted.
    const rejectionError = await deviceError(rejection);
    expect(["invalid_grant", "slow_down"]).toContain(rejectionError.error);

    const sessionsAfter = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [gammaAuthUserId],
    );
    expect(Number(sessionsAfter.rows[0]?.count)).toBe(Number(sessionsBefore.rows[0]?.count) + 1);
  });
});

describe("native session transport and revocation", () => {
  it("mints CLI JWTs, renews the session, and keeps the browser session after CLI sign-out", async () => {
    const browser = await signIn(gammaEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    expect((await verifyDeviceCode(browser.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(browser.cookie, "approve", userCode)).status).toBe(200);

    const redeemed = await redeemDeviceCode(stringField(body, "device_code"));
    expect(redeemed.status).toBe(200);
    const accessToken = stringField(recordOf(await redeemed.json()), "access_token");

    const sessionResponse = await getSessionWithBearer(accessToken);
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("cache-control")).toContain("no-store");
    const session = recordOf(await sessionResponse.json());
    const sessionUser = recordOf(session.session);
    expect(stringField(recordOf(session.user), "id")).toBe(browser.userId);
    expect(stringField(recordOf(session.user), "email")).toBe(gammaEmail);

    const jwt = sessionResponse.headers.get("set-auth-jwt");
    expect(jwt).toBeTruthy();
    const payload = recordOf(JSON.parse(Buffer.from(jwt!.split(".")[1]!, "base64url").toString()));
    expect(payload.sub).toBe(browser.userId);
    expect(payload.email).toBe(gammaEmail);
    expect(typeof jwtClaims(payload).sessionId).toBe("string");

    // Force the renewal branch: the session is inside its update window, so
    // get-session extends it and the bearer plugin exposes the replacement
    // credential without rotating the member.
    const sessionId = stringField(sessionUser, "id");
    await systemPoolFor(env).query(
      `UPDATE "session" SET "expiresAt" = now() + interval '1 hour' WHERE id = $1`,
      [sessionId],
    );
    const renewed = await getSessionWithBearer(accessToken);
    expect(renewed.status).toBe(200);
    const renewedUser = recordOf(recordOf(await renewed.json()).user);
    expect(stringField(renewedUser, "id")).toBe(browser.userId);
    const replacement = renewed.headers.get("set-auth-token");
    expect(replacement).toBeTruthy();
    expect(renewed.headers.get("set-auth-jwt")).toBeTruthy();
    const replacementSession = await getSessionWithBearer(replacement!);
    expect(replacementSession.status).toBe(200);

    // The JWT authorizes an ordinary tenant request; the raw session
    // credential and browser cookies do not.
    const authorized = await tenantRequest("/api/v1/posts", `Bearer ${jwt}`);
    expect(authorized.status).toBe(200);
    const rawCredential = await tenantRequest("/api/v1/posts", `Bearer ${accessToken}`);
    expect(rawCredential.status).toBe(401);
    const cookieCredential = await app.request(
      "/api/v1/posts",
      { headers: { Cookie: browser.cookie, "CF-Connecting-IP": randomIp(), Origin: appOrigin } },
      env,
    );
    expect(cookieCredential.status).toBe(401);

    const signOut = await signOutWithBearer(accessToken);
    expect(signOut.status).toBe(200);

    const revokedSession = await getSessionWithBearer(accessToken);
    expect(revokedSession.status).toBe(200);
    expect(await revokedSession.json()).toBeNull();
    expect(await (await getSessionWithBearer(replacement!)).json()).toBeNull();

    const revoked = await tenantRequest("/api/v1/posts", `Bearer ${jwt}`);
    expect(revoked.status).toBe(401);

    const browserStillLive = await getSessionWithCookie(browser.cookie);
    expect(browserStillLive.status).toBe(200);
    expect(stringField(recordOf(recordOf(await browserStillLive.json()).user), "email")).toBe(
      gammaEmail,
    );
  });

  it("reports an expired CLI session as unusable", async () => {
    const browser = await signIn(securityEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    expect((await verifyDeviceCode(browser.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(browser.cookie, "approve", userCode)).status).toBe(200);
    const redeemed = await redeemDeviceCode(stringField(body, "device_code"));
    expect(redeemed.status).toBe(200);
    const accessToken = stringField(recordOf(await redeemed.json()), "access_token");
    const sessionResponse = await getSessionWithBearer(accessToken);
    expect(sessionResponse.status).toBe(200);
    const jwt = sessionResponse.headers.get("set-auth-jwt");
    expect(jwt).toBeTruthy();
    const sessionId = stringField(recordOf(recordOf(await sessionResponse.json()).session), "id");

    // Expiry is a session-store fact; the HTTP surface must report it as no
    // usable grant rather than a successful session.
    await systemPoolFor(env).query(
      `UPDATE "session" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`,
      [sessionId],
    );
    const expiredSession = await getSessionWithBearer(accessToken);
    expect(expiredSession.status).toBe(200);
    expect(await expiredSession.json()).toBeNull();
    expect((await tenantRequest("/api/v1/posts", `Bearer ${jwt}`)).status).toBe(401);
    expect(await (await getSessionWithCookie(browser.cookie)).json()).toBeNull();
  });

  it("keeps Viewer read-only and Editor write access for CLI sessions", async () => {
    const delta = await signIn(deltaEmail);
    // A request-supplied scope is not an authority grant: the viewer completes
    // the flow with an "admin write" request but retains only their real role.
    const viewerCode = await issueDeviceCode({ body: { scope: "admin write" } });
    expect(
      (await verifyDeviceCode(delta.cookie, stringField(viewerCode.body, "user_code"))).status,
    ).toBe(200);
    expect(
      (await decideDeviceCode(delta.cookie, "approve", stringField(viewerCode.body, "user_code")))
        .status,
    ).toBe(200);
    const viewerTokenResponse = await redeemDeviceCode(stringField(viewerCode.body, "device_code"));
    expect(viewerTokenResponse.status).toBe(200);
    const viewerToken = stringField(recordOf(await viewerTokenResponse.json()), "access_token");
    const viewerSession = await getSessionWithBearer(viewerToken);
    const viewerJwt = viewerSession.headers.get("set-auth-jwt");
    expect(viewerJwt).toBeTruthy();

    expect((await tenantRequest("/api/v1/posts", `Bearer ${viewerJwt}`)).status).toBe(200);
    const viewerMutation = await tenantRequest("/api/v1/posts", `Bearer ${viewerJwt}`, {
      body: JSON.stringify({ brand_profile_id: seededProfileId, title: "Viewer draft" }),
      headers: { "Idempotency-Key": `device-viewer-${crypto.randomUUID()}` },
      method: "POST",
    });
    expect(viewerMutation.status).toBe(403);

    const gamma = await signIn(gammaEmail);
    const editorCode = await issueDeviceCode();
    expect(
      (await verifyDeviceCode(gamma.cookie, stringField(editorCode.body, "user_code"))).status,
    ).toBe(200);
    expect(
      (await decideDeviceCode(gamma.cookie, "approve", stringField(editorCode.body, "user_code")))
        .status,
    ).toBe(200);
    const editorTokenResponse = await redeemDeviceCode(stringField(editorCode.body, "device_code"));
    expect(editorTokenResponse.status).toBe(200);
    const editorToken = stringField(recordOf(await editorTokenResponse.json()), "access_token");
    const editorJwt = (await getSessionWithBearer(editorToken)).headers.get("set-auth-jwt");
    expect(editorJwt).toBeTruthy();

    const created = await tenantRequest("/api/v1/posts", `Bearer ${editorJwt}`, {
      body: JSON.stringify({
        brand_profile_id: seededProfileId,
        default_text: "CLI editor draft",
        title: `Device editor ${crypto.randomUUID().slice(0, 8)}`,
      }),
      headers: { "Idempotency-Key": `device-editor-${crypto.randomUUID()}` },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const postId = stringField(recordOf(await created.json()), "id");
    const deleted = await tenantRequest(`/api/v1/posts/${postId}`, `Bearer ${editorJwt}`, {
      body: JSON.stringify({ brand_profile_id: seededProfileId }),
      headers: { "Idempotency-Key": `device-editor-delete-${postId}` },
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
  });

  it("does not issue a CLI session after the approving member is suspended", async () => {
    const suspended = await signIn(suspendedEmail);
    // The fixture is an eligible shared-Workspace member before suspension, so
    // the later denial is attributable to suspension rather than missing access.
    const activeCode = await issueDeviceCode();
    expect(
      (await verifyDeviceCode(suspended.cookie, stringField(activeCode.body, "user_code"))).status,
    ).toBe(200);
    expect(
      (
        await decideDeviceCode(
          suspended.cookie,
          "approve",
          stringField(activeCode.body, "user_code"),
        )
      ).status,
    ).toBe(200);
    const activeRedemption = await redeemDeviceCode(stringField(activeCode.body, "device_code"));
    expect(activeRedemption.status).toBe(200);
    const activeToken = stringField(recordOf(await activeRedemption.json()), "access_token");
    expect((await getSessionWithBearer(activeToken)).status).toBe(200);

    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    expect((await verifyDeviceCode(suspended.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(suspended.cookie, "approve", userCode)).status).toBe(200);

    await systemPoolFor(env).query(
      `UPDATE users SET suspended_at = now(), suspension_reason = 'Device test'
       WHERE id = $1`,
      [suspendedInternalUserId],
    );
    const sessionsBefore = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [suspendedAuthUserId],
    );

    const denied = await redeemDeviceCode(stringField(body, "device_code"));
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).not.toBe(200);

    const sessionsAfter = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [suspendedAuthUserId],
    );
    expect(sessionsAfter.rows[0]?.count).toBe(sessionsBefore.rows[0]?.count);
  });
});

describe("existing credential policy", () => {
  it("requires the configured second factor before a CLI session can be approved", async () => {
    const enrollment = await signIn(twoFactorEmail);
    const enable = await authPostJson(
      "/api/auth/two-factor/enable",
      { password: dedicatedPassword },
      { cookie: enrollment.cookie },
    );
    expect(enable.status, await enable.clone().text()).toBe(200);
    const pending = recordOf(await enable.json());
    const totpURI = stringField(pending, "totpURI");
    expect(Array.isArray(pending.backupCodes)).toBe(true);
    const confirmedEnrollment = await authPostJson(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(totpURI), trustDevice: false },
      { cookie: enrollment.cookie },
    );
    expect(confirmedEnrollment.status, await confirmedEnrollment.clone().text()).toBe(200);

    // Enabling the factor revoked the enrollment session, so a fresh password
    // sign-in must challenge before any session exists to consent with.
    const challenge = await authPostJson("/api/auth/sign-in/email", {
      email: twoFactorEmail,
      password: dedicatedPassword,
    });
    expect(challenge.status, await challenge.clone().text()).toBe(200);
    expect(recordOf(await challenge.json()).twoFactorRedirect).toBe(true);
    expect(await (await getSessionWithCookie(cookieHeaderFor(challenge))).json()).toBeNull();
    const challengeCookies = cookieHeaderFor(challenge);
    expect(challengeCookies).not.toBe("");

    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    // A password-only challenge cannot claim or approve the pending request.
    expect((await decideDeviceCode(undefined, "approve", userCode)).status).toBe(401);

    // A wrong factor does not mint a session; a fresh challenge with the right
    // code does, and only then can the device request be approved.
    const wrongChallenge = await authPostJson("/api/auth/sign-in/email", {
      email: twoFactorEmail,
      password: dedicatedPassword,
    });
    expect(wrongChallenge.status).toBe(200);
    const rejectedFactor = await authPostJson(
      "/api/auth/two-factor/verify-totp",
      { code: "000000", trustDevice: false },
      { cookie: cookieHeaderFor(wrongChallenge), ip: randomIp() },
    );
    expect(rejectedFactor.status).toBeGreaterThanOrEqual(400);
    expect(await (await getSessionWithCookie(cookieHeaderFor(rejectedFactor))).json()).toBeNull();

    const verified = await authPostJson(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(totpURI), trustDevice: false },
      { cookie: challengeCookies },
    );
    expect(verified.status, await verified.clone().text()).toBe(200);
    const cookie = sessionCookiePair(verified);

    expect((await verifyDeviceCode(cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(cookie, "approve", userCode)).status).toBe(200);
    const redeemed = await redeemDeviceCode(stringField(body, "device_code"));
    expect(redeemed.status).toBe(200);
    const accessToken = stringField(recordOf(await redeemed.json()), "access_token");
    const deviceSession = await getSessionWithBearer(accessToken);
    expect(deviceSession.status).toBe(200);
    expect(stringField(recordOf(recordOf(await deviceSession.json()).user), "email")).toBe(
      twoFactorEmail,
    );
  });

  it("denies an approved grant when enabling two-factor authentication revokes its browser session", async () => {
    const browser = await signIn(securityEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    const deviceCode = stringField(body, "device_code");
    expect((await verifyDeviceCode(browser.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(browser.cookie, "approve", userCode)).status).toBe(200);

    const enrollment = await authPostJson(
      "/api/auth/two-factor/enable",
      { password: dedicatedPassword },
      { cookie: browser.cookie },
    );
    expect(enrollment.status, await enrollment.clone().text()).toBe(200);
    const enrollmentBody = recordOf(await enrollment.json());
    const totpURI = stringField(enrollmentBody, "totpURI");
    const confirmation = await authPostJson(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(totpURI), trustDevice: false },
      { cookie: browser.cookie },
    );
    expect(confirmation.status, await confirmation.clone().text()).toBe(200);
    expect(await (await getSessionWithCookie(browser.cookie)).json()).toBeNull();

    const redemption = await redeemDeviceCode(deviceCode);
    expect(redemption.status).toBe(400);
    expect(await deviceError(redemption)).toMatchObject({ error: "access_denied" });
  });

  it("enforces required mailbox verification before releasing a CLI session", async () => {
    // Local test composition allows the unverified fixture to sign in; the
    // deployed policy composition below is the authority that rejects it.
    const browser = await signIn(unverifiedEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    expect((await verifyDeviceCode(browser.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(browser.cookie, "approve", userCode)).status).toBe(200);

    await systemPoolFor(env).query(`UPDATE "user" SET "emailVerified" = FALSE WHERE id = $1`, [
      unverifiedAuthUserId,
    ]);

    const blockedSignIn = await verificationPostJson("/api/auth/sign-in/email", {
      email: unverifiedEmail,
      password: dedicatedPassword,
    });
    expect(blockedSignIn.status).toBe(403);
    expect(await blockedSignIn.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await (await getSessionWithCookie(cookieHeaderFor(blockedSignIn))).json()).toBeNull();

    const sessionsBefore = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [unverifiedAuthUserId],
    );
    const denied = await verificationPostJson("/api/auth/device/token", {
      client_id: "melti-cli",
      device_code: stringField(body, "device_code"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(denied.status).toBe(403);
    expect(await deviceError(denied)).toMatchObject({ error: "access_denied" });
    const sessionsAfter = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
      [unverifiedAuthUserId],
    );
    expect(sessionsAfter.rows[0]?.count).toBe(sessionsBefore.rows[0]?.count);
  });

  it("revokes an issued CLI session when the existing security policy revokes sessions", async () => {
    const browser = await signIn(securityEmail);
    const { body } = await issueDeviceCode();
    const userCode = stringField(body, "user_code");
    expect((await verifyDeviceCode(browser.cookie, userCode)).status).toBe(200);
    expect((await decideDeviceCode(browser.cookie, "approve", userCode)).status).toBe(200);
    const redeemed = await redeemDeviceCode(stringField(body, "device_code"));
    expect(redeemed.status).toBe(200);
    const accessToken = stringField(recordOf(await redeemed.json()), "access_token");
    const sessionResponse = await getSessionWithBearer(accessToken);
    expect(sessionResponse.status).toBe(200);
    const jwt = sessionResponse.headers.get("set-auth-jwt");
    expect(jwt).toBeTruthy();
    expect((await tenantRequest("/api/v1/posts", `Bearer ${jwt}`)).status).toBe(200);

    const changed = await authPostJson(
      "/api/auth/change-password",
      {
        currentPassword: dedicatedPassword,
        newPassword: crypto.randomUUID(),
        revokeOtherSessions: true,
      },
      { cookie: browser.cookie },
    );
    expect(changed.status, await changed.clone().text()).toBe(200);

    const revokedSession = await getSessionWithBearer(accessToken);
    expect(revokedSession.status).toBe(200);
    expect(await revokedSession.json()).toBeNull();
    expect((await tenantRequest("/api/v1/posts", `Bearer ${jwt}`)).status).toBe(401);
    expect(await (await getSessionWithCookie(browser.cookie)).json()).toBeNull();
  });
});

describe("distributed device abuse controls", () => {
  it("returns retryable HTTP outcomes for code-issuance and token-polling abuse", async () => {
    const codeIp = randomIp();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const issued = await issueDeviceCode({ ip: codeIp });
      expect(issued.response.status, `code attempt ${attempt}`).toBe(200);
    }
    const limitedCode = await issueDeviceCode({ ip: codeIp });
    expect(limitedCode.response.status).toBe(429);
    const retryAfter = Number(limitedCode.response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);

    // Token polling uses its own distributed per-device budget: the first
    // request is admitted and reports pending, while the immediate retry backs
    // off with the RFC-style slow_down error and a Retry-After hint.
    const deviceIp = randomIp();
    const firstCode = await issueDeviceCode({ ip: deviceIp });
    const firstPoll = await redeemDeviceCode(stringField(firstCode.body, "device_code"), {
      ip: deviceIp,
    });
    expect(firstPoll.status).toBe(400);
    expect(await deviceError(firstPoll)).toMatchObject({ error: "authorization_pending" });
    const tooFast = await redeemDeviceCode(stringField(firstCode.body, "device_code"), {
      ip: deviceIp,
    });
    expect(tooFast.status).toBe(400);
    expect(await deviceError(tooFast)).toMatchObject({ error: "slow_down" });
    expect(Number(tooFast.headers.get("retry-after"))).toBeGreaterThan(0);

    // A different device request from the same caller is not blocked by the
    // first request's per-device budget.
    const secondCode = await issueDeviceCode({ ip: deviceIp });
    const otherDevice = await redeemDeviceCode(stringField(secondCode.body, "device_code"), {
      ip: deviceIp,
    });
    expect(otherDevice.status).toBe(400);
    expect(await deviceError(otherDevice)).toMatchObject({ error: "authorization_pending" });
  });
  it("counts per-device throttled polls against the caller ceiling before a new code can allocate a bucket", async () => {
    const ip = randomIp();
    const { body } = await issueDeviceCode({ ip });
    const deviceCode = stringField(body, "device_code");
    const first = await redeemDeviceCode(deviceCode, { ip });
    expect(await deviceError(first)).toMatchObject({ error: "authorization_pending" });

    for (let attempt = 1; attempt < 120; attempt += 1) {
      const throttled = await redeemDeviceCode(deviceCode, { ip });
      expect(throttled.status).toBe(400);
      expect(await deviceError(throttled)).toMatchObject({ error: "slow_down" });
    }

    const distinctCode = await redeemDeviceCode(`unknown-${crypto.randomUUID()}`, { ip });
    expect(distinctCode.status).toBe(400);
    expect(await deviceError(distinctCode)).toMatchObject({ error: "slow_down" });
    expect(Number(distinctCode.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("installation origin policy", () => {
  it("fails closed on an insecure installation origin outside local development", async () => {
    await expect(
      betterAuthFor({
        ...env,
        APP_URL: "http://insecure.example",
        ENVIRONMENT: "staging",
      }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("allows insecure origins only for local/test loopback hosts", () => {
    expect(applicationOrigin({ ...env, APP_URL: "http://127.0.0.1:8787" })).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => applicationOrigin({ ...env, APP_URL: "http://auth.test" })).toThrow(/HTTPS/);
    expect(() =>
      applicationOrigin({
        ...env,
        APP_URL: "http://127.0.0.1:8787",
        ENVIRONMENT: "staging",
      }),
    ).toThrow(/HTTPS/);
  });
});
