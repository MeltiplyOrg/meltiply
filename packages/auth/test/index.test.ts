import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  accessClaims,
  bearerToken,
  createBetterAuth,
  createCloudflareAccessTokenVerifier,
  createJwtVerifier,
  createRemoteJwtVerifier,
  jwtClaims,
  type AccessTokenVerifier,
  type JwtVerifier,
} from "../src";

let signAccess: (claims?: Record<string, unknown>) => Promise<string>;
let verifyAccess: AccessTokenVerifier;
let signJwt: (claims?: Record<string, unknown>, key?: CryptoKey) => Promise<string>;
let verifyJwt: JwtVerifier;
let jwtPrivateKey: CryptoKey;
let jwksServer: Server;
let jwksUrl: URL;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  verifyAccess = createCloudflareAccessTokenVerifier(
    {
      audience: "operator-application-audience",
      teamDomain: "https://meltiply.cloudflareaccess.com",
    },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  signAccess = async (claims = {}) =>
    new SignJWT({
      aud: "operator-application-audience",
      email: "operator@example.test",
      type: "app",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer("https://meltiply.cloudflareaccess.com")
      .setSubject("access-user-alpha")
      .sign(privateKey);
  const jwtKeys = await generateKeyPair("EdDSA");
  jwtPrivateKey = jwtKeys.privateKey;
  const jwtPublicJwk = await exportJWK(jwtKeys.publicKey);
  jwtPublicJwk.kid = "jwt-test-key";
  const localJwtKeys = createLocalJWKSet({ keys: [jwtPublicJwk] });
  verifyJwt = createJwtVerifier(
    {
      audience: "meltiply-api",
      issuer: "https://api.example.test/api/auth",
    },
    localJwtKeys,
  );
  signJwt = async (claims = {}, key = jwtPrivateKey) => {
    const { exp, ...payload } = claims;
    return new SignJWT({
      aud: "meltiply-api",
      email: "alpha@example.test",
      iss: "https://api.example.test/api/auth",
      name: "Alpha User",
      sub: "user-alpha",
      ...payload,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "jwt-test-key" })
      .setIssuedAt()
      .setExpirationTime(
        typeof exp === "number" || typeof exp === "string" || exp instanceof Date ? exp : "5m",
      )
      .sign(key);
  };
  jwksServer = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwtPublicJwk] }));
  });
  await new Promise<void>((resolve) => {
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const address = jwksServer.address() as AddressInfo;
  jwksUrl = new URL(`http://127.0.0.1:${address.port}/api/auth/jwks`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Better Auth JWT verification", () => {
  it("verifies a locally signed JWT into subject, normalized email, and name", async () => {
    await expect(verifyJwt(await signJwt())).resolves.toEqual({
      email: "alpha@example.test",
      name: "Alpha User",
      subject: "user-alpha",
    });
    expect(
      jwtClaims({
        email: "  ALPHA@example.test  ",
        name: "Alpha User",
        sub: "user-alpha",
      }),
    ).toEqual({
      email: "alpha@example.test",
      name: "Alpha User",
      subject: "user-alpha",
    });
  });

  it("omits the display name when the JWT carries no name claim", async () => {
    const identity = await verifyJwt(await signJwt({ name: undefined }));
    expect(identity).toEqual({
      email: "alpha@example.test",
      subject: "user-alpha",
    });
    expect(identity).not.toHaveProperty("name");
  });

  it("rejects tokens signed by a different key", async () => {
    const { privateKey: otherKey } = await generateKeyPair("EdDSA");
    await expect(verifyJwt(await signJwt({}, otherKey))).rejects.toThrow();
  });

  it("rejects tokens with the wrong issuer or audience", async () => {
    await expect(
      verifyJwt(await signJwt({ iss: "https://attacker.example.test" })),
    ).rejects.toThrow();
    await expect(verifyJwt(await signJwt({ aud: "other-api" }))).rejects.toThrow();
  });

  it("rejects expired tokens and payloads missing identity claims", async () => {
    await expect(
      verifyJwt(await signJwt({ exp: Math.floor(Date.now() / 1000) - 60 })),
    ).rejects.toThrow();
    await expect(verifyJwt(await signJwt({ sub: undefined }))).rejects.toThrow(
      "identity subject and email",
    );
    await expect(verifyJwt(await signJwt({ email: undefined }))).rejects.toThrow(
      "identity subject and email",
    );
  });

  it("verifies tokens through the remote JWKS endpoint", async () => {
    const remoteVerifier = createRemoteJwtVerifier(
      {
        audience: "meltiply-api",
        issuer: "https://api.example.test/api/auth",
      },
      jwksUrl,
    );
    await expect(remoteVerifier(await signJwt())).resolves.toEqual({
      email: "alpha@example.test",
      name: "Alpha User",
      subject: "user-alpha",
    });
    await expect(remoteVerifier(await signJwt({ aud: "other-api" }))).rejects.toThrow();
  });
});

describe("Cloudflare Access verification", () => {
  it("verifies issuer, audience, identity type, subject, and normalized email", async () => {
    await expect(verifyAccess(await signAccess())).resolves.toEqual({
      email: "operator@example.test",
      subject: "access-user-alpha",
    });
    expect(
      accessClaims({
        email: "OPERATOR@example.test",
        sub: "access-user-alpha",
        type: "app",
      }),
    ).toEqual({
      email: "operator@example.test",
      subject: "access-user-alpha",
    });
  });

  it("rejects the wrong audience and non-identity service tokens", async () => {
    await expect(verifyAccess(await signAccess({ aud: ["other-application"] }))).rejects.toThrow();
    await expect(verifyAccess(await signAccess({ type: "service" }))).rejects.toThrow(
      "identity subject and email",
    );
    await expect(verifyAccess(await signAccess({ email: undefined }))).rejects.toThrow(
      "identity subject and email",
    );
    expect(() => accessClaims({ email: "operator@example.test", type: "app" })).toThrow(
      "identity subject and email",
    );
  });

  it("rejects non-Cloudflare and non-origin team domains", () => {
    for (const teamDomain of [
      "http://meltiply.cloudflareaccess.com",
      "https://access.example.test",
      "https://meltiply.cloudflareaccess.com/path",
    ]) {
      expect(() =>
        createCloudflareAccessTokenVerifier(
          { audience: "operator-application-audience", teamDomain },
          async () => {
            throw new Error("unused");
          },
        ),
      ).toThrow("canonical HTTPS cloudflareaccess.com origin");
    }
  });
});

describe("bearerToken", () => {
  it("accepts one exact bearer token", () => {
    expect(bearerToken("Bearer token-value")).toBe("token-value");
    expect(bearerToken("bearer token-value")).toBeUndefined();
    expect(bearerToken("Bearer two values")).toBeUndefined();
  });
});

describe("Better Auth device protocol HTTP composition", () => {
  it("completes a CLI grant and keeps browser and CLI session lifecycles separate", async () => {
    const origin = "https://auth.example.test";
    const email = "device-user@example.test";
    const database: {
      [model: string]: Record<string, unknown>[];
      session: Record<string, unknown>[];
    } = {
      account: [],
      deviceCode: [],
      jwks: [],
      rateLimit: [],
      session: [],
      twoFactor: [],
      user: [],
      verification: [],
    };
    const auth = await createBetterAuth({
      baseURL: origin,
      database: memoryAdapter(database),
      deviceAuthorization: {
        clientId: "melti-cli",
        expiresIn: "10m",
        interval: "5s",
        verificationUri: `${origin}/device`,
      },
      isAccountActive: async () => true,
      jwt: { audience: "meltiply-api", issuer: origin },
      requireEmailVerification: false,
      secret: "meltiply-auth-http-test-secret-32",
      trustedOrigins: [origin],
    });

    const postJson = (
      path: string,
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<Response> =>
      auth.handler(
        new Request(`${origin}${path}`, {
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            ...headers,
          },
          method: "POST",
        }),
      );

    const jsonRecord = async (response: Response): Promise<Record<string, unknown>> => {
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Expected an object response");
      }
      return Object.fromEntries(Object.entries(value));
    };

    const sessionCookie = (response: Response): string => {
      const header = response.headers
        .getSetCookie()
        .find((entry) => entry.includes("session_token="));
      const pair = header?.split(";", 1)[0];
      if (!pair) throw new Error("Expected a browser session cookie");
      return pair;
    };

    const signUp = await postJson("/api/auth/sign-up/email", {
      email,
      name: "Device User",
      password: "device-password-for-http-test",
      clientChannel: "cli",
    });
    expect(signUp.status).toBe(200);
    const browserCookie = sessionCookie(signUp);
    if (typeof auth.getSession !== "function") {
      throw new Error("Better Auth instance must expose its session lookup");
    }
    const browserIdentity = await auth.getSession(new Headers({ Cookie: browserCookie }));
    expect(browserIdentity).toMatchObject({
      session: { id: expect.any(String) },
      user: { id: expect.any(String) },
    });
    expect(
      database.session.find((session) => session.id === browserIdentity?.session.id)?.clientChannel,
    ).toBe("web");

    const issued = await postJson("/api/auth/device/code", { client_id: "melti-cli" });
    expect(issued.status).toBe(200);
    const issuedBody = await jsonRecord(issued);
    const deviceCode = issuedBody.device_code;
    const userCode = issuedBody.user_code;
    if (typeof deviceCode !== "string" || typeof userCode !== "string") {
      throw new TypeError("Expected device and user codes");
    }

    const review = await auth.handler(
      new Request(`${origin}/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
        headers: { Cookie: browserCookie },
      }),
    );
    const reviewBody = await jsonRecord(review);
    expect(reviewBody).toMatchObject({
      client_id: "melti-cli",
      status: "pending",
      user_code: userCode,
    });
    const approved = await postJson(
      "/api/auth/device/approve",
      { userCode },
      { Cookie: browserCookie },
    );
    expect(approved.status).toBe(200);

    const exchange = await postJson("/api/auth/device/token", {
      client_id: "melti-cli",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      clientChannel: "web",
    });
    expect(exchange.status).toBe(200);
    const exchangeBody = await jsonRecord(exchange);
    expect(exchangeBody.token_type).toBe("Bearer");
    const accessToken = exchangeBody.access_token;
    if (typeof accessToken !== "string") throw new TypeError("Expected a CLI session credential");

    const cliSession = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(cliSession.status).toBe(200);
    expect(cliSession.headers.get("set-auth-jwt")).toBeTruthy();
    const cliBody = await jsonRecord(cliSession);
    expect(cliBody.user).toMatchObject({ email });
    expect(cliBody.session).toMatchObject({ id: expect.any(String) });
    expect(cliBody.session).not.toHaveProperty("clientChannel");
    expect(database.session.find((session) => session.token === accessToken)?.clientChannel).toBe(
      "cli",
    );

    const signOut = await auth.handler(
      new Request(`${origin}/api/auth/sign-out`, {
        body: "{}",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
    );
    expect(signOut.status).toBe(200);

    const revokedCliSession = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    const revokedCliSessionBody: unknown = await revokedCliSession.json();
    expect(revokedCliSessionBody).toBeNull();

    const browserSession = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { Cookie: browserCookie },
      }),
    );
    expect((await jsonRecord(browserSession)).user).toMatchObject({ email });
    const changed = await postJson(
      "/api/auth/change-password",
      {
        currentPassword: "device-password-for-http-test",
        newPassword: "replacement-password-for-http-test",
        revokeOtherSessions: true,
        clientChannel: "cli",
      },
      { Cookie: browserCookie },
    );
    expect(changed.status).toBe(200);
    const replacement = await jsonRecord(changed);
    expect(
      database.session.find((session) => session.token === replacement.token)?.clientChannel,
    ).toBe("web");
    const replacedSession = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { Cookie: sessionCookie(changed) },
      }),
    );
    const replacedBody = await jsonRecord(replacedSession);
    expect(replacedBody.user).toMatchObject({ email });
    expect(replacedBody.session).toMatchObject({ id: expect.any(String) });
    expect(replacedBody.session).not.toHaveProperty("clientChannel");
    expect(await auth.getSession(new Headers({ Cookie: browserCookie }))).toBeNull();
  });
});
