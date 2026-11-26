import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getCurrentUser } from "./api";
import { authClient } from "./auth-client";
import { clearAuthJwt } from "./auth-token";

const AUTH = "http://localhost:8787/api/auth";
const ORIGIN = "https://app.example.com";
const user = { email: "user@example.com", id: "user-1" };
const session = { expiresAt: "2099-07-18T16:00:00.000Z", id: "session-1", userId: "user-1" };

interface Sent {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let sent: Sent[];
let answers: (() => Promise<Response>)[];
let storage: string[];

const reply = (body: unknown, init?: ResponseInit) => () =>
  Promise.resolve(Response.json(body, init));
const signedIn = (jwt: string) => reply({ session, user }, { headers: { "set-auth-jwt": jwt } });

beforeAll(async () => {
  vi.stubGlobal("fetch", reply({}));
  await Effect.runPromise(getCurrentUser(null));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sent = [];
  answers = [];
  storage = [];
  const recordingStorage = new Proxy(
    {},
    { get: (_target, name) => () => storage.push(String(name)) },
  );
  vi.stubGlobal("window", {
    location: { origin: ORIGIN },
    localStorage: recordingStorage,
    sessionStorage: recordingStorage,
    dispatchEvent: () => true,
  });
  vi.stubGlobal("localStorage", recordingStorage);
  vi.stubGlobal("sessionStorage", recordingStorage);
  vi.stubGlobal("fetch", (input: Request | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const url = input instanceof Request ? input.url : input;
    if (url !== "/__frontend-telemetry") {
      sent.push({
        url,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(headers),
      });
    }
    return (answers.shift() ?? reply({}))();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthJwt();
});

async function bearerOfNextApiCall(): Promise<string | undefined> {
  await Effect.runPromise(getCurrentUser(null));
  return sent.at(-1)?.headers.authorization;
}

describe("authClient.getSession", () => {
  it("a session with a JWT", async () => {
    answers = [signedIn("jwt-1")];

    const result = await authClient.getSession();

    expect(result).toEqual({ session, user });
    expect(await bearerOfNextApiCall()).toEqual("Bearer jwt-1");
  });

  it("a refreshed session", async () => {
    answers = [signedIn("jwt-1"), signedIn("jwt-2")];
    await authClient.getSession();

    await authClient.getSession();

    expect(await bearerOfNextApiCall()).toEqual("Bearer jwt-2");
  });

  it("no session", async () => {
    answers = [signedIn("jwt-1"), reply(null)];
    await authClient.getSession();

    const result = await authClient.getSession();

    expect(result).toEqual(null);
    expect(await bearerOfNextApiCall()).toEqual(undefined);
  });
});

describe("authClient.signOut", () => {
  it.each([
    ["a server failure", () => Promise.resolve(new Response(null, { status: 500 }))],
    ["a rejected request", () => Promise.reject(new TypeError("network failure"))],
  ])("%s still drops the bearer", async (_example, failure) => {
    answers = [signedIn("jwt-1"), failure];
    await authClient.getSession();

    await authClient.signOut().catch(() => undefined);

    expect(await bearerOfNextApiCall()).toEqual(undefined);
  });

  it("a whole session leaves Web Storage untouched", async () => {
    answers = [signedIn("jwt-1")];

    await authClient.getSession();
    await bearerOfNextApiCall();
    await authClient.signOut();

    expect(storage).toEqual([]);
  });
});

describe("an auth failure message", () => {
  it.each([
    ["a message", reply({ message: "Wrong password" }, { status: 401 }), "Wrong password"],
    ["a nested message", reply({ error: { message: "Locked" } }, { status: 403 }), "Locked"],
    ["no message", reply({}, { status: 400 }), "Authentication request failed with status 400"],
    [
      "a body that is not JSON",
      () => Promise.resolve(new Response("<html>", { status: 502 })),
      "Authentication request failed with status 502",
    ],
  ])("%s", async (_example, failure, message) => {
    answers = [failure];

    await expect(authClient.signInEmail({ email: "a@b.test", password: "p" })).rejects.toEqual(
      new Error(message),
    );
  });
});

describe("authClient.setupStatus", () => {
  it("an initialized installation", async () => {
    answers = [reply({ initialized: true, extra: 1 })];

    expect(await authClient.setupStatus()).toEqual({ initialized: true });
  });

  it.each([
    ["a null body", null],
    ["no flag", {}],
    ["a flag that is text", { initialized: "yes" }],
  ])("%s", async (_example, body) => {
    answers = [reply(body)];

    await expect(authClient.setupStatus()).rejects.toEqual(
      new Error("Invalid installation status. Try again."),
    );
  });
});

const json = { "content-type": "application/json" };
const posted = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  url: `${AUTH}/${path}`,
  method: "POST",
  body,
  headers: { ...json, ...headers },
});

describe("authClient requests", () => {
  const credentials = { email: "a@b.test", password: "p", name: "Ada" };

  it("a plain sign-up", async () => {
    await authClient.signUpEmail(credentials);

    expect(sent).toEqual([
      posted("sign-up/email", { ...credentials, callbackURL: `${ORIGIN}/sign-in?verified=1` }),
    ]);
  });

  it("a sign-up with an invitation, a setup secret and a workspace name", async () => {
    await authClient.signUpEmail({
      ...credentials,
      invitationToken: "tok en",
      setupSecret: "secret",
      workspaceName: "Studio",
    });

    expect(sent).toEqual([
      posted(
        "sign-up/email",
        {
          ...credentials,
          callbackURL: `${ORIGIN}/invitations/accept?token=tok%20en`,
          workspace_name: "Studio",
        },
        { "x-invitation-token": "tok en", "x-setup-secret": "secret" },
      ),
    ]);
  });

  it.each([
    [
      "a password reset request",
      () => authClient.requestPasswordReset({ email: "a@b.test" }),
      posted("request-password-reset", {
        email: "a@b.test",
        redirectTo: `${ORIGIN}/sign-in?recovery=1`,
      }),
    ],
    [
      "a new password",
      () => authClient.resetPassword({ newPassword: "n", token: "t" }),
      posted("reset-password", { newPassword: "n", token: "t" }),
    ],
    [
      "a password change",
      () => authClient.changePassword({ currentPassword: "c", newPassword: "n" }),
      posted("change-password", {
        currentPassword: "c",
        newPassword: "n",
        revokeOtherSessions: true,
      }),
    ],
    [
      "another verification mail",
      () => authClient.resendVerification("a@b.test"),
      posted("send-verification-email", {
        email: "a@b.test",
        callbackURL: `${ORIGIN}/sign-in?verified=1`,
      }),
    ],
    [
      "an authenticator code",
      () => authClient.verifySecondFactor("123456"),
      posted("two-factor/verify-totp", { code: "123456", trustDevice: false }),
    ],
    [
      "a backup code",
      () => authClient.verifySecondFactor("abc", true),
      posted("two-factor/verify-backup-code", { code: "abc", trustDevice: false }),
    ],
  ])("%s", async (_example, call, request) => {
    await call();

    expect(sent).toEqual([request]);
  });

  it("an email verification", async () => {
    await authClient.verifyEmail({ token: "a b" });

    expect(sent.map(({ url, method }) => [method, url])).toEqual([
      ["GET", `${AUTH}/verify-email?token=a+b`],
    ]);
  });

  it.each([
    ["a query", new URLSearchParams({ user_code: "ABC" }), "device?user_code=ABC"],
    ["no query", undefined, "device"],
  ])("a device request with %s", async (_example, query, path) => {
    await authClient.requestDeviceAuthorization("device", { method: "GET" }, query);

    expect(sent.map(({ url }) => url)).toEqual([`${AUTH}/${path}`]);
  });
});

describe("authClient.manageTwoFactor", () => {
  const totpURI = "otpauth://totp/Meltiply:a@b.test?secret=ABC";

  it.each([
    ["an enrollment", "enable", { totpURI, backupCodes: ["one"] }],
    ["new backup codes", "generate-backup-codes", { backupCodes: ["one", "two"] }],
    ["a removal", "disable", {}],
  ] as const)("%s", async (_example, action, body) => {
    answers = [reply({ ...body, status: true })];

    expect(await authClient.manageTwoFactor(action, "p")).toEqual(body);
  });

  it.each([
    ["a web URI", "https://totp/?secret=ABC"],
    ["another type", "otpauth://hotp/x?secret=ABC"],
    ["no secret", "otpauth://totp/x"],
  ])("an enrollment with %s", async (_example, uri) => {
    answers = [reply({ totpURI: uri, backupCodes: ["one"] })];

    await expect(authClient.manageTwoFactor("enable", "p")).rejects.toEqual(
      new Error("Invalid authenticator enrollment."),
    );
  });

  it.each([
    ["no backup codes", "enable", { totpURI }],
    ["no URI", "enable", { backupCodes: ["one"] }],
    ["an empty code list", "generate-backup-codes", { backupCodes: [] }],
    ["a code that is not text", "generate-backup-codes", { backupCodes: [1] }],
  ] as const)("an answer with %s", async (_example, action, body) => {
    answers = [reply(body)];

    await expect(authClient.manageTwoFactor(action, "p")).rejects.toEqual(
      new Error("Incomplete authenticator enrollment."),
    );
  });

  it("an answer that is not an object", async () => {
    answers = [reply("ok")];

    await expect(authClient.manageTwoFactor("disable", "p")).rejects.toEqual(
      new Error("Invalid security response."),
    );
  });
});
