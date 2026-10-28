import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { Effect } from "effect";
import { AuthenticationRequiredError, ForbiddenError } from "@meltiply/domain";

import {
  accessClaims,
  AuthService,
  bearerToken,
  createAccessTokenVerifier,
  createAuthServiceLive,
  createAuthServiceTest,
  createBetterAuth,
  createJwtVerifier,
  createRemoteJwtVerifier,
  jwtClaims,
  verifyAccessTokenEffect,
  verifyJwtTokenEffect,
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
  verifyAccess = createAccessTokenVerifier(
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
  // Better Auth signs tenant JWTs with EdDSA (Ed25519) by default; the verifier
  // pins issuer and audience so tokens minted for other surfaces are rejected.
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
  // A real HTTP JWKS endpoint exercises the remote verifier's fetch path the
  // same way the API Worker resolves the Better Auth /api/auth/jwks document.
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
    await expect(verifyJwt(await signJwt({ name: undefined }))).resolves.toEqual({
      email: "alpha@example.test",
      subject: "user-alpha",
    });
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
    await expect(
      verifyAccess(await signAccess({ email: undefined, type: "service" })),
    ).rejects.toThrow("identity subject and email");
  });

  it("rejects non-Cloudflare and non-origin team domains", () => {
    for (const teamDomain of [
      "http://meltiply.cloudflareaccess.com",
      "https://access.example.test",
      "https://meltiply.cloudflareaccess.com/path",
    ]) {
      expect(() =>
        createAccessTokenVerifier(
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

describe("Effect AuthService and verifier helpers", () => {
  it("verifyJwtTokenEffect succeeds with a valid JWT and fails closed with AuthenticationRequiredError", async () => {
    const identity = await Effect.runPromise(verifyJwtTokenEffect(verifyJwt, await signJwt()));
    expect(identity.subject).toBe("user-alpha");

    const invalidError = await Effect.runPromise(
      Effect.flip(verifyJwtTokenEffect(verifyJwt, "invalid.jwt.token")),
    );
    expect(invalidError).toBeInstanceOf(AuthenticationRequiredError);
  });

  it("verifyAccessTokenEffect succeeds with valid token and fails closed with ForbiddenError", async () => {
    const validToken = await signAccess();
    const claims = await Effect.runPromise(verifyAccessTokenEffect(verifyAccess, validToken));
    expect(claims.email).toBe("operator@example.test");

    const invalidError = await Effect.runPromise(
      Effect.flip(verifyAccessTokenEffect(verifyAccess, "invalid.jwt.token")),
    );
    expect(invalidError).toBeInstanceOf(ForbiddenError);
  });

  it("AuthService live layer verifies tenant JWTs and access tokens", async () => {
    const liveLayer = createAuthServiceLive({
      accessVerifier: verifyAccess,
      jwtVerifier: verifyJwt,
    });

    const program = Effect.gen(function* () {
      const auth = yield* AuthService;
      const identity = yield* auth.verifyJwtToken(yield* Effect.promise(() => signJwt()));
      const access = yield* auth.verifyAccessToken(yield* Effect.promise(() => signAccess()));
      return { access, identity };
    }).pipe(Effect.provide(liveLayer));

    const result = await Effect.runPromise(program);
    expect(result.identity.subject).toBe("user-alpha");
    expect(result.access.email).toBe("operator@example.test");
  });

  it("AuthService live layer builds the JWT verifier from remote JWKS config", async () => {
    const liveLayer = createAuthServiceLive({
      jwt: {
        audience: "meltiply-api",
        issuer: "https://api.example.test/api/auth",
        jwksUrl,
      },
    });

    const identity = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyJwtToken(yield* Effect.promise(() => signJwt()));
      }).pipe(Effect.provide(liveLayer)),
    );

    expect(identity).toEqual({
      email: "alpha@example.test",
      name: "Alpha User",
      subject: "user-alpha",
    });
  });

  it("AuthService live layer fails closed when verifiers are omitted or invalid", async () => {
    const emptyLayer = createAuthServiceLive({});

    const jwtExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyJwtToken("some-token");
      }).pipe(Effect.provide(emptyLayer)),
    );
    expect(jwtExit._tag).toBe("Failure");
    if (jwtExit._tag === "Failure") {
      expect(jwtExit.cause.toString()).toContain("AuthenticationRequiredError");
    }

    const accessExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyAccessToken("some-token");
      }).pipe(Effect.provide(emptyLayer)),
    );
    expect(accessExit._tag).toBe("Failure");
    if (accessExit._tag === "Failure") {
      expect(accessExit.cause.toString()).toContain("ForbiddenError");
    }

    // Invalid config shapes fail closed
    const invalidConfigLayer = createAuthServiceLive({
      access: {
        audience: "",
        teamDomain: "invalid-url",
      },
      jwt: {
        audience: "",
        issuer: "",
        jwksUrl: new URL("https://api.example.test/api/auth/jwks"),
      },
    });

    const invalidJwtExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyJwtToken("token");
      }).pipe(Effect.provide(invalidConfigLayer)),
    );
    expect(invalidJwtExit._tag).toBe("Failure");

    const invalidAccessExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyAccessToken("token");
      }).pipe(Effect.provide(invalidConfigLayer)),
    );
    expect(invalidAccessExit._tag).toBe("Failure");
  });

  it("AuthService test layer provides default doubles and respects overrides", async () => {
    const defaultLayer = createAuthServiceTest();

    const defaultProgram = Effect.gen(function* () {
      const auth = yield* AuthService;
      const identity = yield* auth.verifyJwtToken("any-token");
      const access = yield* auth.verifyAccessToken("any-token");
      return { access, identity };
    }).pipe(Effect.provide(defaultLayer));

    const defaultResult = await Effect.runPromise(defaultProgram);
    expect(defaultResult.identity.subject).toBe("mock-user");
    expect(defaultResult.access.email).toBe("operator@example.test");

    const overriddenLayer = createAuthServiceTest({
      verifyJwtToken: () =>
        Effect.fail(
          new AuthenticationRequiredError({
            message: "Custom JWT failure",
          }),
        ),
    });

    const customExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        return yield* auth.verifyJwtToken("token");
      }).pipe(Effect.provide(overriddenLayer)),
    );
    expect(customExit._tag).toBe("Failure");
    if (customExit._tag === "Failure") {
      expect(customExit.cause.toString()).toContain("Custom JWT failure");
    }
  });
});

describe("Better Auth device protocol HTTP composition", () => {
  it("completes a CLI grant and keeps browser and CLI session lifecycles separate", async () => {
    const origin = "https://auth.example.test";
    const email = "device-user@example.test";
    const auth = await createBetterAuth({
      baseURL: origin,
      database: memoryAdapter({}),
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

    /**
     * Sends a same-origin JSON request to the real Better Auth HTTP handler.
     *
     * @param path - Auth API path.
     * @param body - JSON request payload.
     * @param headers - Optional request headers such as a session cookie.
     * @returns The Better Auth HTTP response.
     */
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

    /**
     * Reads a JSON response as a record without trusting its runtime shape.
     *
     * @param response - Successful auth response.
     * @returns Parsed object with unknown-valued fields.
     */
    const jsonRecord = async (response: Response): Promise<Record<string, unknown>> => {
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Expected an object response");
      }
      return Object.fromEntries(Object.entries(value));
    };

    /**
     * Extracts the Better Auth session cookie from a response.
     *
     * @param response - Sign-up or sign-in response.
     * @returns `name=value` pair for subsequent browser requests.
     */
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
    });
    expect(signUp.status).toBe(200);
    const browserCookie = sessionCookie(signUp);
    expect(await auth.getSession(new Headers({ Cookie: browserCookie }))).toMatchObject({
      session: { id: expect.any(String) },
      user: { id: expect.any(String) },
    });

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
    expect((await jsonRecord(cliSession)).user).toMatchObject({ email });

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
  });
});
