import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createHyperdrivePool } from "@meltiply/database";
import { activeIdentity } from "../src/auth-policy";
import { createJwtVerifier, jwtClaims } from "@meltiply/auth";
import { createApiApp } from "../src/app";

import { betterAuthFor, checkAuthRateLimit } from "../src/better-auth";
import { sha256Hex } from "../src/crypto";
import { systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

/**
 * These tests drive the real `betterAuthFor` → `createBetterAuth` →
 * `createCloudflareMailSender` stack against the local PostgreSQL database —
 * no auth internals are mocked. Mail capture happens at the `send_email`
 * binding seam: the recording binding exercises the same adapter mapping,
 * sender normalization, and receipt contract the real binding uses, and the
 * assertion target is the message Better Auth actually submitted (never HTTP
 * success alone, which Better Auth does not treat as delivery evidence).
 */

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

/**
 * System-pool connection string for the auth lifecycle fixtures, mirroring
 * `core-service.integration.test.ts`: Better Auth's `user`/`session`/
 * `account`/`verification`/`jwks` tables are revoked from the RLS role the
 * runner exports via `MELTIPLY_DATABASE_TEST_URL` (migration 001 keeps them
 * system-only), so `DB_SYSTEM` must reach the privileged local role rather
 * than the authenticated fixture URL.
 */
const baseSystemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
const isolatedDatabase = new URL(baseSystemConnectionString);
isolatedDatabase.searchParams.set("options", "-c search_path=auth_lifecycle,public");
const systemConnectionString = isolatedDatabase.href;
const setupSecret = crypto.randomUUID() + crypto.randomUUID();
const adminConnectionString =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const adminPool = createHyperdrivePool({ connectionString: adminConnectionString });

// Exercise the actual migrated auth tables and indexes without taking ownership
// of the shared RLS fixtures. No production or external database is accepted.
beforeAll(async () => {
  for (const connection of [systemConnectionString, adminConnectionString]) {
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/meltiply")
      throw new Error("Auth tests require the isolated local database.");
  }
  await adminPool.query(`DROP SCHEMA IF EXISTS auth_lifecycle CASCADE`);
  await adminPool.query(`CREATE SCHEMA auth_lifecycle AUTHORIZATION meltiply_system`);
  for (const table of [
    "user",
    "session",
    "account",
    "verification",
    "jwks",
    "twoFactor",
    "users",
    "workspace_invitations",
  ]) {
    await adminPool.query(
      `CREATE TABLE auth_lifecycle."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
    await adminPool.query(`GRANT ALL ON auth_lifecycle."${table}" TO meltiply_system`);
  }
  await adminPool.query(`
    CREATE TRIGGER revoke_password_sessions AFTER UPDATE OF password ON auth_lifecycle."account"
      FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
    CREATE TRIGGER revoke_account_sessions AFTER UPDATE OF "twoFactorEnabled", email, "emailVerified" ON auth_lifecycle."user"
      FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
  `);
});

beforeEach(async () => {
  await systemPoolFor(systemEnv()).query(
    `TRUNCATE "user", "session", "account", "verification", "twoFactor", users, workspace_invitations`,
  );
});

/**
 * One fixture secret for every environment this suite builds. Better Auth
 * stores JWKS private keys in the shared `jwks` table encrypted with the auth
 * secret, and this database is the same one the local development stack seeds
 * its keys with — using the local fallback secret keeps those rows readable.
 * Mixing a second secret in makes whichever instance reads the existing row
 * fail to decrypt it (HTTP 500 on sign-in and `/api/auth/token`). Production
 * behavior is untouched: outside local/test `BETTER_AUTH_SECRET` stays a
 * required binding with no fallback.
 */
const authSecret = "meltiply-local-auth-secret-32-chars-long";

/** Binding double plus the messages dispatched through it. */
interface RecordingMail {
  binding: SendEmail;
  sent: EmailMessageBuilder[];
}

/**
 * Implements both generated send overloads, rejecting raw MIME at the recording
 * seam because the adapter only composes builders. Captures the real payload
 * (`to`/`from`/subject/html/text) instead of a mocked option echo.
 */
function recordingMailBinding(): RecordingMail {
  const sent: EmailMessageBuilder[] = [];
  const binding: SendEmail = {
    send: async (payload: EmailMessage | EmailMessageBuilder) => {
      if (!("subject" in payload)) {
        throw new Error("expected a structured email builder");
      }
      sent.push(payload);
      return { messageId: `test-msg-${sent.length}` };
    },
  };
  return { binding, sent };
}

/**
 * Builds a Worker env bound to the integration database. `test` environment
 * keeps the explicit local policy — unverified sign-in allowed — while the
 * recording binding still captures every dispatched message.
 */
function localTestEnv(mail: RecordingMail) {
  return {
    ALLOWED_ORIGINS: "http://app.test",
    BETTER_AUTH_SECRET: authSecret,
    AUTH_SETUP_SECRET: setupSecret,
    BETTER_AUTH_URL: "http://auth.test",
    DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
    ENVIRONMENT: "test",
    MAIL: mail.binding,
    MAIL_FROM_ADDRESS: "no-reply@meltiply.test",
    MAIL_FROM_NAME: "Meltiply Test",
    VERSION: "1.0.0-target.0",
  } satisfies ApiWorkerEnv;
}

/**
 * Builds the deployed-environment env: verification is mandatory and the
 * `MAIL` binding/sender must be usable or `betterAuthFor` fails closed.
 */
function stagingEnv(mail: RecordingMail) {
  return {
    ALLOWED_ORIGINS: "http://app.test",
    BETTER_AUTH_SECRET: authSecret,
    AUTH_SETUP_SECRET: setupSecret,
    BETTER_AUTH_URL: "http://auth.test",
    DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
    ENVIRONMENT: "staging",
    MAIL: mail.binding,
    MAIL_FROM_ADDRESS: "no-reply@meltiply.test",
    MAIL_FROM_NAME: "Meltiply Test",
    VERSION: "1.0.0-target.0",
  } satisfies ApiWorkerEnv;
}

/**
 * Minimal env used for direct database assertions. `systemPoolFor` caches per
 * connection string, so this resolves the same isolate-cached pool the auth
 * instances use.
 */
function systemEnv() {
  return {
    ALLOWED_ORIGINS: "http://app.test",
    DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
    ENVIRONMENT: "test",
    VERSION: "1.0.0-target.0",
  } satisfies ApiWorkerEnv;
}

const baseURL = "http://auth.test";

/** Sends a JSON POST to a Better Auth endpoint path under `/api/auth`. */
function authPost(
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return auth.handler(
    new Request(`${baseURL}${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Setup-Secret": setupSecret, ...headers },
      method: "POST",
    }),
  );
}

/** Calls a Better Auth endpoint with the session cookie attached. */
function authGetWithCookie(
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  cookie: string,
) {
  return auth.handler(new Request(`${baseURL}${path}`, { headers: { Cookie: cookie } }));
}

/**
 * Extracts the session cookie pair (`name=value`) Better Auth set on a
 * sign-in/sign-up response. `getSetCookie` keeps multiple Set-Cookie headers
 * separate so the pick is deterministic.
 */
function sessionCookiePair(response: Response): string {
  const header = response.headers.getSetCookie().find((entry) => entry.includes("session_token="));
  expect(header, "response must set the session cookie").toBeTruthy();
  return header!.split(";")[0]!;
}

/**
 * Narrows a decoded JSON value (untrusted `Response.json()`/`JSON.parse`
 * output) to a plain record so property reads stay typed `unknown` instead of
 * flowing as `any` through unchecked assertions.
 */
function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected JSON object, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Pulls the single action URL a verification/reset email carries, requiring
 * both bodies despite their optional platform types. `text` holds the raw URL;
 * `html` holds it HTML-escaped inside the `href`; missing bodies fail the test.
 */
function actionLink(message: EmailMessageBuilder): string {
  if (message.text === undefined || message.html === undefined) {
    throw new Error("expected both email text and HTML bodies");
  }
  const match = message.text.match(/https?:\/\/\S+/);
  expect(match, "email text must carry the raw action URL").toBeTruthy();
  const link = match![0];
  expect(message.html.includes(`href="${link.replaceAll("&", "&amp;")}"`)).toBe(true);
  return link;
}

/**
 * Signs an HS256 verification JWT exactly as Better Auth's
 * `createEmailVerificationToken` does (algorithm-only header, secret-keyed,
 * `exp` claim), so tests can mint an already-expired link deterministically
 * instead of waiting out the one-hour default.
 */
function verificationJwt(email: string, expiresAtSeconds: number, secret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256" });
  const payload = encode({
    email,
    exp: expiresAtSeconds,
    iat: Math.floor(Date.now() / 1000) - 120,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Counts durable session rows for a Better Auth subject, so sign-out
 * revocation is observed against stored state instead of the session cookie
 * (the JWT cookie cache legitimately keeps `get-session` valid for five
 * minutes after a row is deleted).
 */
async function sessionRowsFor(userId: string): Promise<number> {
  const pool = systemPoolFor(systemEnv());
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "session" WHERE "userId" = $1`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

const emails = {
  cacheA: "auth-it-cache-a@example.test",
  cacheB: "auth-it-cache-b@example.test",
  enumeration: "auth-it-enumeration@example.test",
  localUnverified: "auth-it-local@example.test",
  reset: "auth-it-reset@example.test",
  resetExpired: "auth-it-expired@example.test",
  session: "auth-it-session@example.test",
  stagingVerified: "auth-it-staging@example.test",
};

/**
 * Removes every row this suite created, scoped to the fixture emails: Better
 * Auth stores a password-reset token with the target user id in
 * `verification.value`, and `"user"` cascades to `account`/`session`.
 *
 * JWKS rows are deliberately left alone. They are keyed by the shared auth
 * secret rather than by this suite, other suites and the local stack read the
 * same table, and deleting a key another isolate is mid-use turns the next
 * `/api/auth/token` into a decrypt failure.
 */
async function cleanupDatabase() {
  const pool = systemPoolFor(systemEnv());
  const emailList = Object.values(emails);
  await pool.query(
    `DELETE FROM "verification" v USING "user" u
     WHERE v.value = u.id AND u.email = ANY($1::text[])`,
    [emailList],
  );
  await pool.query(`DELETE FROM "user" WHERE email = ANY($1::text[])`, [emailList]);
}

afterAll(async () => {
  await cleanupDatabase();
  await systemPoolFor(systemEnv()).end();
  await adminPool.query(`DROP SCHEMA auth_lifecycle CASCADE`);
  await adminPool.end();
});

describe("betterAuthFor local/test policy", () => {
  it("keeps the historical default: unverified sign-in works, while sign-up still dispatches a verification email", async () => {
    const mail = recordingMailBinding();
    const env = localTestEnv(mail);
    const auth = await betterAuthFor(env);

    const signUp = await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.localUnverified,
      name: "Local Tester",
      password: "correct horse battery staple",
    });
    expect(signUp.status).toBe(200);

    // Local policy does not require verification — but delivery is wired, so
    // sign-up emits a verification message through the shared sender.
    const verificationMail = mail.sent.find(
      (message) => message.subject === "Verify your Meltiply email",
    );
    expect(verificationMail).toBeTruthy();
    expect(verificationMail!.to).toBe(emails.localUnverified);
    expect(verificationMail!.from).toEqual({
      email: "no-reply@meltiply.test",
      name: "Meltiply Test",
    });

    const signIn = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.localUnverified,
      password: "correct horse battery staple",
    });
    expect(signIn.status).toBe(200);
  });
});

describe("betterAuthFor staging policy", () => {
  it("fails closed when mail configuration is missing instead of disabling verification", async () => {
    const env = {
      ALLOWED_ORIGINS: "http://app.test",
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: "http://auth.test",
      DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
      ENVIRONMENT: "staging",
      VERSION: "1.0.0-target.0",
    } satisfies ApiWorkerEnv;
    await expect(betterAuthFor(env)).rejects.toThrow(/MAIL/);

    const malformedSender = stagingEnv(recordingMailBinding());
    await expect(
      betterAuthFor({
        ...malformedSender,
        MAIL_FROM_ADDRESS: "not an address",
      }),
    ).rejects.toThrow(/MAIL/);
  });

  it("requires verification before sign-in, honors the emailed link, and blocks invalid/expired tokens", async () => {
    const mail = recordingMailBinding();
    const auth = await betterAuthFor(stagingEnv(mail));

    const signUp = await authPost(auth, "/api/auth/sign-up/email", {
      callbackURL: "http://app.test/verified",
      email: emails.stagingVerified,
      name: "Staging Tester",
      password: "correct horse battery staple",
    });
    expect(signUp.status).toBe(200);

    const verificationMail = mail.sent.find(
      (message) =>
        message.to === emails.stagingVerified && message.subject === "Verify your Meltiply email",
    );
    expect(verificationMail).toBeTruthy();
    const verifyLink = actionLink(verificationMail!);

    const blocked = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.stagingVerified,
      password: "correct horse battery staple",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

    const verified = await auth.handler(new Request(verifyLink));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("http://app.test/verified");

    const signIn = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.stagingVerified,
      password: "correct horse battery staple",
    });
    expect(signIn.status).toBe(200);
    expect(sessionCookiePair(signIn)).toBeTruthy();

    const garbage = await auth.handler(
      new Request(
        `${baseURL}/api/auth/verify-email?token=not-a-token&callbackURL=${encodeURIComponent("http://app.test/verified")}`,
      ),
    );
    expect(garbage.status).toBe(302);
    expect(garbage.headers.get("location")).toContain("error=INVALID_TOKEN");

    const expired = await auth.handler(
      new Request(
        `${baseURL}/api/auth/verify-email?token=${verificationJwt(emails.stagingVerified, Math.floor(Date.now() / 1000) - 60, authSecret)}&callbackURL=${encodeURIComponent("http://app.test/verified")}`,
      ),
    );
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toContain("error=TOKEN_EXPIRED");
  });
});

describe("password recovery through the shared sender", () => {
  it("emails a usable reset link, signs in with the new password, and rejects expired/invalid tokens", async () => {
    const mail = recordingMailBinding();
    const auth = await betterAuthFor(localTestEnv(mail));

    await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.reset,
      name: "Reset Tester",
      password: "first password value",
    });
    mail.sent.length = 0;

    const request = await authPost(auth, "/api/auth/request-password-reset", {
      email: emails.reset,
      redirectTo: "http://app.test/reset",
    });
    expect(request.status).toBe(200);

    const resetMail = mail.sent.find(
      (message) => message.subject === "Reset your Meltiply password",
    );
    expect(resetMail).toBeTruthy();
    expect(resetMail!.to).toBe(emails.reset);
    const resetLink = actionLink(resetMail!);
    const token = new URL(resetLink).pathname.split("/").pop()!;

    const callback = await auth.handler(new Request(resetLink));
    expect(callback.status).toBe(302);
    const callbackLocation = new URL(callback.headers.get("location")!);
    expect(callbackLocation.origin).toBe("http://app.test");
    expect(callbackLocation.searchParams.get("token") === token).toBe(true);

    const reset = await authPost(auth, "/api/auth/reset-password", {
      newPassword: "second password value",
      token,
    });
    expect(reset.status).toBe(200);

    const oldPassword = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.reset,
      password: "first password value",
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.reset,
      password: "second password value",
    });
    expect(newPassword.status).toBe(200);

    // The consumed token cannot be replayed.
    const replay = await authPost(auth, "/api/auth/reset-password", {
      newPassword: "third password value",
      token,
    });
    expect(replay.status).toBe(400);

    const unknownToken = await authPost(auth, "/api/auth/reset-password", {
      newPassword: "third password value",
      token: "unknown-token",
    });
    expect(unknownToken.status).toBe(400);
  });

  it("rejects a reset token whose stored expiry has passed", async () => {
    const mail = recordingMailBinding();
    const auth = await betterAuthFor(localTestEnv(mail));

    await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.resetExpired,
      name: "Expired Tester",
      password: "first password value",
    });
    mail.sent.length = 0;

    await authPost(auth, "/api/auth/request-password-reset", {
      email: emails.resetExpired,
      redirectTo: "http://app.test/reset",
    });
    const resetMail = mail.sent.find(
      (message) => message.subject === "Reset your Meltiply password",
    );
    expect(resetMail).toBeTruthy();
    const token = new URL(actionLink(resetMail!)).pathname.split("/").pop()!;

    // Force the stored expiry into the past: the adapter's consume path must
    // treat an elapsed token as absent rather than honouring it.
    await systemPoolFor(systemEnv()).query(
      `UPDATE "verification" SET "expiresAt" = $1 WHERE identifier = $2`,
      [new Date(Date.now() - 60_000), `reset-password:${token}`],
    );

    const expiredReset = await authPost(auth, "/api/auth/reset-password", {
      newPassword: "second password value",
      token,
    });
    expect(expiredReset.status).toBe(400);
  });

  it("does not reveal whether an email is registered", async () => {
    const mail = recordingMailBinding();
    const auth = await betterAuthFor(localTestEnv(mail));
    const unknown = "nobody-here@example.test";
    // Sign-up legitimately emits a verification message, so recovery
    // submissions are counted by subject rather than by recipient alone.
    const resetSubmissions = () =>
      mail.sent.filter((message) => message.subject === "Reset your Meltiply password");

    await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.enumeration,
      name: "Enumeration Tester",
      password: "registered account password",
    });
    expect(mail.sent.some((message) => message.subject === "Verify your Meltiply email")).toBe(
      true,
    );
    const beforeReset = resetSubmissions().length;

    // An unknown address answers exactly like a registered one and submits
    // nothing, while a registered address submits exactly one recovery message.
    const missing = await authPost(auth, "/api/auth/request-password-reset", {
      email: unknown,
      redirectTo: "http://app.test/reset",
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ status: true });
    expect(mail.sent.filter((message) => message.to === unknown)).toHaveLength(0);
    expect(resetSubmissions()).toHaveLength(beforeReset);

    const known = await authPost(auth, "/api/auth/request-password-reset", {
      email: emails.enumeration,
      redirectTo: "http://app.test/reset",
    });
    expect(known.status).toBe(200);
    expect(await known.json()).toMatchObject({ status: true });
    expect(resetSubmissions()).toHaveLength(beforeReset + 1);
    const recovery = resetSubmissions().at(-1)!;
    expect(recovery.to).toBe(emails.enumeration);
    expect(new URL(actionLink(recovery)).pathname.startsWith("/api/auth/reset-password/")).toBe(
      true,
    );

    const unknownSignIn = await authPost(auth, "/api/auth/sign-in/email", {
      email: unknown,
      password: "registered account password",
    });
    const wrongPassword = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.enumeration,
      password: "wrong password value",
    });
    expect(unknownSignIn.status).toBe(401);
    expect(unknownSignIn.status).toBe(wrongPassword.status);
    expect(await unknownSignIn.json()).toEqual(await wrongPassword.json());
  });
});

describe("session cookie, bearer JWT, and sign-out", () => {
  it("mints the session cookie and JWT, and sign-out revokes the stored session", async () => {
    const mail = recordingMailBinding();
    const auth = await betterAuthFor(stagingEnv(mail));

    await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.session,
      name: "Session Tester",
      password: "correct horse battery staple",
    });
    const verifyMail = mail.sent.find(
      (message) =>
        message.to === emails.session && message.subject === "Verify your Meltiply email",
    );
    expect(verifyMail).toBeTruthy();
    await auth.handler(new Request(actionLink(verifyMail!)));

    const signIn = await authPost(auth, "/api/auth/sign-in/email", {
      email: emails.session,
      password: "correct horse battery staple",
    });
    expect(signIn.status).toBe(200);
    const cookie = sessionCookiePair(signIn);

    const session = await authGetWithCookie(auth, "/api/auth/get-session", cookie);
    expect(session.status).toBe(200);
    const sessionUser = recordOf(recordOf(await session.json()).user);
    if (typeof sessionUser.id !== "string" || typeof sessionUser.email !== "string") {
      throw new Error("get-session must return string user.id and user.email");
    }
    const sessionUserId = sessionUser.id;
    expect(sessionUser.email).toBe(emails.session);

    const token = await authGetWithCookie(auth, "/api/auth/token", cookie);
    expect(token.status).toBe(200);
    const tokenBody = recordOf(await token.json());
    if (typeof tokenBody.token !== "string") {
      throw new Error("/api/auth/token must return a string token");
    }
    const jwt = tokenBody.token;
    expect(jwt.split(".").length).toBe(3);
    const payload = recordOf(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()));
    expect(payload.sub).toBe(sessionUserId);
    expect(payload.email).toBe(emails.session);
    expect(typeof payload.exp).toBe("number");

    expect(await sessionRowsFor(sessionUserId)).toBeGreaterThan(0);

    const signOut = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-out`, {
        headers: { Cookie: cookie },
        method: "POST",
      }),
    );
    expect(signOut.status).toBe(200);

    // Revocation is observed on both cookie reads and the protected API's
    // authoritative session lookup, including the already-minted bearer JWT.
    expect(await sessionRowsFor(sessionUserId)).toBe(0);
    expect(
      (await (await authGetWithCookie(auth, "/api/auth/get-session", cookie)).json()) === null,
    ).toBe(true);
    await expect(activeIdentity(stagingEnv(mail), jwtClaims(payload))).rejects.toMatchObject({
      status: 401,
    });
    const published = recordOf(
      await (await auth.handler(new Request(`${baseURL}/api/auth/jwks`))).json(),
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
    const verifier = createJwtVerifier({ audience: baseURL, issuer: baseURL }, async () => key);
    expect(typeof (await verifier(jwt)).sessionId).toBe("string");
    let relays = 0;
    const app = createApiApp({
      verifyJwtToken: async (env, token) => activeIdentity(env, await verifier(token)),
      resolveActor: async () => {
        throw new Error("Revoked authority reached actor resolution");
      },
    });
    const denied = await app.request(
      "/api/v1/posts",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: "{}",
      },
      {
        ...stagingEnv(mail),
        AUTOMATION: {
          relayOutbox: async () => {
            relays++;
            return { claimed: 0, dead: 0, failed: 0, published: 0 };
          },
          requestCommentsSync: async () => 0,
        },
      },
    );
    expect(denied.status).toBe(401);
    expect(relays).toBe(0);
  });
});

describe("bootstrap and invite-only sign-up", () => {
  it("requires the setup secret, validates profile data, and closes public sign-up after bootstrap", async () => {
    const auth = await betterAuthFor(localTestEnv(recordingMailBinding()));
    const body = { email: emails.localUnverified, name: "Owner", password: crypto.randomUUID() };
    const noSecret = await authPost(auth, "/api/auth/sign-up/email", body, {
      "X-Setup-Secret": "",
    });
    expect(noSecret.status).toBe(403);
    const invalid = await authPost(auth, "/api/auth/sign-up/email", { ...body, name: "\u0000" });
    expect(invalid.status).toBe(400);
    const first = await authPost(auth, "/api/auth/sign-up/email", body);
    expect(first.status).toBe(200);

    // Once actor resolution has claimed the first account, public sign-up is
    // closed. Simulate that durable state directly: the auth surface reads the
    // internal owner marker, not a Better Auth column.
    await systemPoolFor(systemEnv()).query(
      `INSERT INTO users (id, auth_user_id, email, display_name, installation_owner)
       VALUES ($1, $2, $3, 'Owner', TRUE)`,
      ["10000000-0000-4000-8000-000000000099", "auth_bootstrap_owner", "owner@example.test"],
    );

    const status = await auth.handler(new Request(`${baseURL}/api/auth/setup-status`));
    expect(await status.json()).toEqual({ initialized: true });

    const closed = await authPost(auth, "/api/auth/sign-up/email", {
      ...body,
      email: emails.stagingVerified,
    });
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ code: "INVITATION_REQUIRED" });

    const token = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256Hex(token);
    await systemPoolFor(systemEnv()).query(
      `INSERT INTO workspace_invitations
         (org_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, 'editor', $3, $4, now() + interval '7 days')`,
      [
        "20000000-0000-4000-8000-000000000001",
        emails.stagingVerified,
        "10000000-0000-4000-8000-000000000099",
        tokenHash,
      ],
    );
    const invited = await authPost(
      auth,
      "/api/auth/sign-up/email",
      { ...body, email: emails.stagingVerified },
      { "X-Invitation-Token": token },
    );
    expect(invited.status).toBe(200);

    const wrongEmail = await authPost(
      auth,
      "/api/auth/sign-up/email",
      { ...body, email: emails.reset },
      { "X-Invitation-Token": token },
    );
    expect(wrongEmail.status).toBe(403);
    expect(await wrongEmail.json()).toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });

    const stored = await systemPoolFor(systemEnv()).query<{ plaintext: boolean; stored: boolean }>(
      `SELECT password = $1 AS plaintext, password IS NOT NULL AS stored
       FROM "account"
       WHERE "providerId" = 'credential'
         AND "userId" = (SELECT id FROM "user" WHERE email = $2)`,
      [body.password, emails.stagingVerified],
    );
    expect(stored.rows).toEqual([{ plaintext: false, stored: true }]);
  });

  it("serializes concurrent first registrations so only one account is created", async () => {
    const auth = await betterAuthFor(localTestEnv(recordingMailBinding()));
    const password = crypto.randomUUID();
    const responses = await Promise.all([
      authPost(auth, "/api/auth/sign-up/email", {
        email: emails.localUnverified,
        name: "First Setup",
        password,
      }),
      authPost(auth, "/api/auth/sign-up/email", {
        email: emails.stagingVerified,
        name: "Second Setup",
        password,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const count = await systemPoolFor(systemEnv()).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user"`,
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("revokes old bearer and cookie authority on password change and password reset", async () => {
    const mail = recordingMailBinding();
    const env = localTestEnv(mail);
    const auth = await betterAuthFor(env);
    const password = crypto.randomUUID();
    const registered = await authPost(auth, "/api/auth/sign-up/email", {
      email: emails.reset,
      name: "Owner",
      password,
    });
    let cookie = sessionCookiePair(registered);
    const mintIdentity = async () => {
      const minted = recordOf(
        await (await authGetWithCookie(auth, "/api/auth/token", cookie)).json(),
      );
      if (typeof minted.token !== "string") throw new Error("Expected access token");
      return jwtClaims(
        recordOf(JSON.parse(Buffer.from(minted.token.split(".")[1]!, "base64url").toString())),
      );
    };
    const first = await mintIdentity();
    await activeIdentity(env, first);
    const nextPassword = crypto.randomUUID();
    expect(
      (
        await authPost(
          auth,
          "/api/auth/change-password",
          { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true },
          { Cookie: cookie, Origin: "http://app.test" },
        )
      ).status,
    ).toBe(200);
    await expect(activeIdentity(env, first)).rejects.toMatchObject({ status: 401 });
    expect(
      (await (await authGetWithCookie(auth, "/api/auth/get-session", cookie)).json()) === null,
    ).toBe(true);
    cookie = sessionCookiePair(
      await authPost(auth, "/api/auth/sign-in/email", {
        email: emails.reset,
        password: nextPassword,
      }),
    );
    const second = await mintIdentity();
    await authPost(auth, "/api/auth/request-password-reset", {
      email: emails.reset,
      redirectTo: "http://app.test/sign-in",
    });
    const message = mail.sent.find((entry) => entry.subject === "Reset your Meltiply password");
    if (!message) throw new Error("Expected reset delivery");
    const token = new URL(actionLink(message)).pathname.split("/").pop();
    expect(
      (
        await authPost(auth, "/api/auth/reset-password", {
          token,
          newPassword: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await expect(activeIdentity(env, second)).rejects.toMatchObject({ status: 401 });
  });
});

/** Computes the current six-digit TOTP from a real enrollment URI without logging its secret. */
function enrollmentCode(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("Enrollment secret is missing");
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

describe("optional authenticator lifecycle", () => {
  it("confirms enrollment, challenges sign-in, consumes backup codes once, regenerates and disables with password reauthentication", async () => {
    const mail = recordingMailBinding();
    const env = localTestEnv(mail);
    const auth = await betterAuthFor(env);
    let password = crypto.randomUUID();
    const email = emails.session;
    const jar = new Map<string, string>();
    const capture = (response: Response) => {
      for (const entry of response.headers.getSetCookie()) {
        const pair = entry.split(";")[0]!;
        const index = pair.indexOf("=");
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    };
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await authPost(auth, `/api/auth/${path}`, body, {
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        Origin: "http://app.test",
      });
      capture(response);
      return response;
    };
    const signedUp = await post("sign-up/email", { email, name: "Owner", password });
    expect(signedUp.status).toBe(200);
    const pending = recordOf(await (await post("two-factor/enable", { password })).json());
    if (typeof pending.totpURI !== "string" || !Array.isArray(pending.backupCodes))
      throw new Error("Expected real enrollment");
    const backups = pending.backupCodes;
    const before = await systemPoolFor(systemEnv()).query<{ enabled: boolean }>(
      `SELECT "twoFactorEnabled" AS enabled FROM "user"`,
    );
    expect(before.rows[0]?.enabled).toBe(false);
    const confirmed = await post("two-factor/verify-totp", {
      code: enrollmentCode(pending.totpURI),
      trustDevice: false,
    });
    expect(confirmed.status).toBe(200);
    jar.clear();
    const challenge = await post("sign-in/email", { email, password });
    expect(recordOf(await challenge.json()).twoFactorRedirect).toBe(true);
    const cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    expect(
      (await (await authGetWithCookie(auth, "/api/auth/get-session", cookie)).json()) === null,
    ).toBe(true);
    await post("request-password-reset", { email, redirectTo: "http://app.test/sign-in" });
    const resetMail = mail.sent.find((entry) => entry.subject === "Reset your Meltiply password");
    if (!resetMail) throw new Error("Expected reset delivery");
    password = crypto.randomUUID();
    const resetToken = new URL(actionLink(resetMail)).pathname.split("/").pop();
    expect(
      (await post("reset-password", { token: resetToken, newPassword: password })).status,
    ).toBe(200);
    // A challenge issued before recovery cannot be upgraded into a fresh session.
    expect(
      (await post("two-factor/verify-backup-code", { code: backups[0], trustDevice: false }))
        .status,
    ).toBe(401);
    jar.clear();
    expect(
      recordOf(await (await post("sign-in/email", { email, password })).json()).twoFactorRedirect,
    ).toBe(true);
    const recovered = await post("two-factor/verify-backup-code", {
      code: backups[0],
      trustDevice: false,
    });
    expect(recovered.status).toBe(200);
    jar.clear();
    await post("sign-in/email", { email, password });
    expect(
      (
        await post("two-factor/verify-totp", {
          code: enrollmentCode(pending.totpURI),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
    const invalidPassword = await post("two-factor/generate-backup-codes", {
      password: crypto.randomUUID(),
    });
    expect(invalidPassword.status).toBeGreaterThanOrEqual(400);
    jar.clear();
    await post("sign-in/email", { email, password });
    expect(
      (await post("two-factor/verify-backup-code", { code: backups[0], trustDevice: false }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post("two-factor/verify-backup-code", { code: backups[1], trustDevice: false }))
        .status,
    ).toBe(200);
    const regenerated = await post("two-factor/generate-backup-codes", { password });
    expect(regenerated.status).toBe(200);
    const currentCookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    const currentSession = await (
      await authGetWithCookie(auth, "/api/auth/get-session", currentCookie)
    ).json();
    expect(currentSession !== null).toBe(true);
    jar.clear();
    await post("sign-in/email", { email, password });
    expect(
      (await post("two-factor/verify-backup-code", { code: backups[2], trustDevice: false }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    const replacement = recordOf(await regenerated.json()).backupCodes;
    if (!Array.isArray(replacement)) throw new Error("Expected replacement codes");
    expect(
      (await post("two-factor/verify-backup-code", { code: replacement[0], trustDevice: false }))
        .status,
    ).toBe(200);
    expect((await post("two-factor/disable", { password })).status).toBe(200);
    jar.clear();
    const signedIn = await post("sign-in/email", { email, password });
    expect(recordOf(await signedIn.json()).twoFactorRedirect).toBeUndefined();
    expect(signedIn.status).toBe(200);
  });
});
describe("shared credential and delivery budgets", () => {
  it("shares normalized credential and delivery budgets across independent callers", async () => {
    const env = localTestEnv(recordingMailBinding());
    const email = `${crypto.randomUUID()}@example.test`;
    const request = (index: number) =>
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": `2001:db8:${email.slice(0, 4)}::${index}`,
        },
        body: JSON.stringify({
          email: index % 2 ? email.toUpperCase() : email,
          password: crypto.randomUUID(),
        }),
      });
    const admitted = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        checkAuthRateLimit({ ...env }, "sign-in", request(index)),
      ),
    );
    expect(admitted.every((result) => result.status === "ok")).toBe(true);
    const blocked = await checkAuthRateLimit({ ...env }, "sign-in", request(11));
    expect(blocked.status).toBe("limited");
    expect(blocked.retryAfterSeconds! > 0 && blocked.retryAfterSeconds! <= 600).toBe(true);
    const sends = [];
    for (let index = 20; index < 26; index++)
      sends.push(await checkAuthRateLimit({ ...env }, "send-verification-email", request(index)));
    expect(sends.map((result) => result.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "limited"]);
  });
});
