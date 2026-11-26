import { memoryAdapter } from "better-auth/adapters/memory";
import { decodeJwt } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  createBetterAuth,
  type BetterAuthConfig,
  type BetterAuthEmailConfig,
  type BetterAuthInstance,
} from "../src";

type Row = Record<string, unknown>;
type Database = Record<
  | "account"
  | "deviceCode"
  | "jwks"
  | "rateLimit"
  | "session"
  | "twoFactor"
  | "user"
  | "verification",
  Row[]
>;
type Message = Parameters<BetterAuthEmailConfig["send"]>[0];

const ORIGIN = "https://auth.example.test";
const EMAIL = "device-user@example.test";
const PASSWORD = "device-password-for-http-test";
const ID = expect.stringMatching(/^[A-Za-z0-9]{32}$/);
const device = {
  clientId: "melti-cli",
  expiresIn: "10m",
  interval: "5s",
  verificationUri: `${ORIGIN}/device`,
} as const;

class FakeMailer implements BetterAuthEmailConfig {
  readonly sent: Message[] = [];
  failure: Error | undefined;

  send = async (message: Message) => {
    if (this.failure) throw this.failure;
    this.sent.push(message);
  };
}

function emptyDatabase(): Database {
  return {
    account: [],
    deviceCode: [],
    jwks: [],
    rateLimit: [],
    session: [],
    twoFactor: [],
    user: [],
    verification: [],
  };
}

function build(database: Database, config: Partial<BetterAuthConfig> = {}) {
  return createBetterAuth({
    baseURL: ORIGIN,
    database: memoryAdapter(database),
    deviceAuthorization: device,
    jwt: { audience: "meltiply-api", issuer: "https://issuer.example.test" },
    requireEmailVerification: false,
    secret: "meltiply-auth-http-test-secret-32",
    trustedOrigins: [ORIGIN],
    ...config,
  });
}

function post(
  auth: BetterAuthInstance,
  path: string,
  body: Row,
  headers: Record<string, string> = {},
) {
  return auth.handler(
    new Request(`${ORIGIN}${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
      method: "POST",
    }),
  );
}

function get(auth: BetterAuthInstance, path: string, headers: Record<string, string>) {
  return auth.handler(new Request(`${ORIGIN}${path}`, { headers }));
}

async function record(response: Response): Promise<Row> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new TypeError("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function sessionCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((entry) => entry.includes("session_token="));
  const pair = header?.split(";", 1)[0];
  if (!pair) throw new Error("Expected a browser session cookie");
  return pair;
}

const signUp = (auth: BetterAuthInstance, email: string, extra: Row = {}) =>
  post(auth, "/api/auth/sign-up/email", {
    email,
    name: "Device User",
    password: PASSWORD,
    ...extra,
  });

async function approvedDeviceCode(auth: BetterAuthInstance, cookie: string): Promise<string> {
  const issued = await record(
    await post(auth, "/api/auth/device/code", { client_id: "melti-cli" }),
  );
  const userCode = String(issued.user_code);
  await get(auth, `/api/auth/device?user_code=${userCode}`, { Cookie: cookie });
  await post(auth, "/api/auth/device/approve", { userCode }, { Cookie: cookie });
  return String(issued.device_code);
}

const redeem = (auth: BetterAuthInstance, deviceCode: string) =>
  post(auth, "/api/auth/device/token", {
    client_id: "melti-cli",
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    clientChannel: "web",
  });

const snapshot = { database: emptyDatabase(), cookie: "", cliToken: "" };

beforeAll(async () => {
  const database = emptyDatabase();
  const auth = await build(database);
  snapshot.cookie = sessionCookie(await signUp(auth, EMAIL));
  await get(auth, "/api/auth/get-session", { Cookie: snapshot.cookie });
  const granted = await record(await redeem(auth, await approvedDeviceCode(auth, snapshot.cookie)));
  snapshot.cliToken = String(granted.access_token);
  snapshot.database = database;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(config: Partial<BetterAuthConfig> = {}) {
  const database = structuredClone(snapshot.database);
  const mail = new FakeMailer();
  const auth = await build(database, { email: mail, ...config });
  const channelOf = (token: unknown) =>
    database.session.find((session) => session.token === token)?.clientChannel;
  const identityOf = async (headers: Record<string, string>) =>
    auth.getSession?.(new Headers(headers));
  return { auth, database, mail, channelOf, identityOf };
}

const browser = () => ({ Cookie: snapshot.cookie });
const cli = () => ({ Authorization: `Bearer ${snapshot.cliToken}` });

describe("createBetterAuth", () => {
  it("unusable device authorization settings", async () => {
    await expect(
      build(emptyDatabase(), { deviceAuthorization: { ...device, clientId: " " } }),
    ).rejects.toThrow("device authorization requires an exact client identifier");
  });

  it("a sign-up that asks for the CLI channel", async () => {
    const { auth, channelOf } = await setup();

    const response = await signUp(auth, "new@example.test", { clientChannel: "cli" });

    expect(response.status).toBe(200);
    expect(channelOf((await record(response)).token)).toEqual("web");
  });

  it("a sign-up with an email already used", async () => {
    const { auth, database } = await setup();

    const response = await signUp(auth, EMAIL);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "User already exists. Use another email.",
    });
    expect(database.user).toEqual(snapshot.database.user);
  });

  it("a sign-up for a suspended account", async () => {
    const { auth, database } = await setup({ isAccountActive: async () => false });

    const response = await signUp(auth, "new@example.test");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "FAILED_TO_CREATE_SESSION",
      message: "Failed to create session",
    });
    expect(database.session).toEqual(snapshot.database.session);
  });

  it("a sign-up while the account check is down", async () => {
    const failure = new Error("account check down");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth, database } = await setup({
      isAccountActive: async () => {
        throw failure;
      },
    });

    const response = await signUp(auth, "new@example.test");

    expect(response.status).toBe(500);
    expect(database.session).toEqual(snapshot.database.session);
    expect(logged).toHaveBeenCalledWith("# SERVER_ERROR: ", failure);
  });

  it("a sign-up with mail configured", async () => {
    const { auth, mail } = await setup();

    await signUp(auth, "new@example.test");

    expect(mail.sent).toEqual([
      {
        html: expect.stringContaining(`<a href="${ORIGIN}/api/auth/verify-email?token=`),
        subject: "Verify your Meltiply email",
        text: expect.stringContaining(`${ORIGIN}/api/auth/verify-email?token=`),
        to: "new@example.test",
      },
    ]);
  });

  it("a sign-up while mail is down", async () => {
    const logged = vi.spyOn(console, "error");
    const { auth, database, mail } = await setup();
    mail.failure = new Error("mail down");

    const response = await signUp(auth, "new@example.test");

    expect(response.status).toBe(200);
    expect(database.user.map((user) => user.email)).toEqual([EMAIL, "new@example.test"]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("a password reset request", async () => {
    const { auth, mail } = await setup();

    const response = await post(auth, "/api/auth/request-password-reset", { email: EMAIL });

    expect(response.status).toBe(200);
    expect(mail.sent).toEqual([
      {
        html: expect.stringContaining(`<a href="${ORIGIN}/api/auth/reset-password/`),
        subject: "Reset your Meltiply password",
        text: expect.stringContaining(`${ORIGIN}/api/auth/reset-password/`),
        to: EMAIL,
      },
    ]);
  });

  it("a password reset request while mail is down", async () => {
    const logged = vi.spyOn(console, "error");
    const { auth, mail } = await setup();
    mail.failure = new Error("mail down");

    const response = await post(auth, "/api/auth/request-password-reset", { email: EMAIL });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: true,
      message: "If this email exists in our system, check your email for the reset link",
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it("an unverified sign-in where verification is required", async () => {
    const { auth, database } = await setup({ requireEmailVerification: true });

    const response = await post(auth, "/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(response.status).toBe(403);
    expect(database.session).toEqual(snapshot.database.session);
  });

  it("an unverified sign-in where verification is not required", async () => {
    const { auth, channelOf } = await setup();

    const response = await post(auth, "/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(channelOf((await record(response)).token)).toEqual("web");
  });

  it("a browser session lookup", async () => {
    const { identityOf } = await setup();

    expect(await identityOf(browser())).toEqual({ session: { id: ID }, user: { id: ID } });
  });

  it("a session lookup while the database is down", async () => {
    const failure = new Error("database down");
    const down = new Proxy(emptyDatabase(), {
      get() {
        throw failure;
      },
    });
    const auth = await build(down);

    await expect(auth.getSession?.(new Headers(browser()))).rejects.toThrow(
      "Failed to get session",
    );
  });

  it("a session lookup with no credential", async () => {
    const { identityOf } = await setup();

    expect(await identityOf({})).toEqual(null);
  });

  it("a device code for the first-party client", async () => {
    const { auth } = await setup();

    const response = await post(auth, "/api/auth/device/code", { client_id: "melti-cli" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verification_uri: `${ORIGIN}/device` });
  });

  it("a device code for another client", async () => {
    const { auth } = await setup();

    const response = await post(auth, "/api/auth/device/code", { client_id: "other" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client",
      error_description: "Invalid client ID",
    });
  });

  it("a device code without device authorization", async () => {
    const { auth } = await setup({ deviceAuthorization: undefined });

    const response = await post(auth, "/api/auth/device/code", { client_id: "melti-cli" });

    expect(response.status).toBe(404);
  });

  it("a device code under review", async () => {
    const { auth } = await setup();
    const issued = await record(
      await post(auth, "/api/auth/device/code", { client_id: "melti-cli" }),
    );

    const response = await get(auth, `/api/auth/device?user_code=${issued.user_code}`, browser());

    expect(await response.json()).toMatchObject({
      client_id: "melti-cli",
      status: "pending",
      user_code: issued.user_code,
    });
  });

  it("an approved device grant", async () => {
    const { auth, channelOf } = await setup();
    const deviceCode = await approvedDeviceCode(auth, snapshot.cookie);

    const response = await redeem(auth, deviceCode);

    expect(response.status).toBe(200);
    const granted = await record(response);
    expect(granted.token_type).toEqual("Bearer");
    expect(channelOf(granted.access_token)).toEqual("cli");
  });

  it("a device grant redeemed twice", async () => {
    const { auth, database } = await setup();
    const deviceCode = await approvedDeviceCode(auth, snapshot.cookie);
    await redeem(auth, deviceCode);
    const sessions = database.session.length;

    const response = await redeem(auth, deviceCode);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(database.session.length).toEqual(sessions);
  });

  it("a CLI session read", async () => {
    const { auth } = await setup();

    const response = await get(auth, "/api/auth/get-session", cli());

    const body = await record(response);
    expect(body.user).toMatchObject({ email: EMAIL });
    expect(body.session).toMatchObject({ id: ID });
    expect(body.session).not.toHaveProperty("clientChannel");
    const claims = decodeJwt(response.headers.get("set-auth-jwt") ?? "");
    expect(claims).toEqual({
      aud: "meltiply-api",
      email: EMAIL,
      exp: (claims.iat ?? 0) + 900,
      iat: expect.any(Number),
      iss: "https://issuer.example.test",
      name: "Device User",
      sid: ID,
      sub: ID,
    });
  });

  it("a session token with no configured audience or issuer", async () => {
    const { auth } = await setup({ jwt: undefined });

    const response = await get(auth, "/api/auth/get-session", cli());

    expect(decodeJwt(response.headers.get("set-auth-jwt") ?? "")).toMatchObject({
      aud: ORIGIN,
      iss: ORIGIN,
    });
  });

  it("a CLI sign-out", async () => {
    const { auth, identityOf } = await setup();

    const response = await post(auth, "/api/auth/sign-out", {}, cli());

    expect(response.status).toBe(200);
    expect(await identityOf(cli())).toEqual(null);
    expect(await identityOf(browser())).not.toEqual(null);
  });

  it.each([
    ["the browser", browser, "web"],
    ["the CLI", cli, "cli"],
  ])("a password change from %s", async (_example, credential, channel) => {
    const { auth, channelOf, identityOf } = await setup();

    const response = await post(
      auth,
      "/api/auth/change-password",
      {
        currentPassword: PASSWORD,
        newPassword: "replacement-password-for-http-test",
        revokeOtherSessions: true,
        clientChannel: "unknown",
      },
      credential(),
    );

    expect(response.status).toBe(200);
    const { token } = await record(response);
    expect(channelOf(token)).toEqual(channel);
    expect(await identityOf(credential())).toEqual(null);
    expect(await identityOf({ Authorization: `Bearer ${token}` })).not.toEqual(null);
  });
});
