import { createHmac } from "node:crypto";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { betterAuthFor } from "../src/better-auth";
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
const systemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";

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
      headers: { "Content-Type": "application/json", ...headers },
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
  expect(message.html).toContain(`href="${link.replaceAll("&", "&amp;")}"`);
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
    expect(callbackLocation.searchParams.get("token")).toBe(token);

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
    expect(actionLink(recovery)).toContain("/reset-password/");

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
    expect(jwt.split(".")).toHaveLength(3);
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

    // Sign-out deletes the durable session; the 5-minute JWT cookie cache stays
    // valid by design, so revocation is proven against stored state.
    expect(await sessionRowsFor(sessionUserId)).toBe(0);
  });
});

describe("auth instance cache identity", () => {
  it("reuses the instance for an unchanged env and rebuilds when the MAIL binding identity changes", async () => {
    const mailA = recordingMailBinding();
    const mailB = recordingMailBinding();
    const envA = localTestEnv(mailA);
    const envB = { ...envA, MAIL: mailB.binding };

    const first = await betterAuthFor(envA);
    expect(await betterAuthFor(envA)).toBe(first);

    const second = await betterAuthFor(envB);
    expect(second).not.toBe(first);
    // envB is now the cache entry; switching back must rebuild rather than
    // leak binding B into env A requests.
    const third = await betterAuthFor(envA);
    expect(third).not.toBe(second);

    await authPost(third, "/api/auth/sign-up/email", {
      email: emails.cacheA,
      name: "Cache A",
      password: "correct horse battery staple",
    });
    await authPost(second, "/api/auth/sign-up/email", {
      email: emails.cacheB,
      name: "Cache B",
      password: "correct horse battery staple",
    });

    expect(mailA.sent.some((m) => m.to === emails.cacheA)).toBe(true);
    expect(mailA.sent.some((m) => m.to === emails.cacheB)).toBe(false);
    expect(mailB.sent.some((m) => m.to === emails.cacheB)).toBe(true);
    expect(mailB.sent.some((m) => m.to === emails.cacheA)).toBe(false);

    // The normalized sender participates in the key: an untrimmed variant of
    // the same address keeps the cached instance, a different sender rebuilds.
    const envSameSender = {
      ...envA,
      MAIL_FROM_ADDRESS: "  no-reply@meltiply.test  ",
    };
    expect(await betterAuthFor(envSameSender)).toBe(third);
    const envNewSender = { ...envA, MAIL_FROM_NAME: "Renamed Sender" };
    expect(await betterAuthFor(envNewSender)).not.toBe(third);
  });
});
