import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  createCloudflareAccessTokenVerifier,
  createJwtVerifier,
  createRemoteJwtVerifier,
} from "../src";

const jwtConfig = { audience: "meltiply-api", issuer: "https://api.example.test/api/auth" };
const accessConfig = {
  audience: "operator-application",
  teamDomain: "https://meltiply.cloudflareaccess.com",
};
const identity = { email: "alpha@example.test", name: "Alpha User", subject: "user-alpha" };
const operator = { email: "operator@example.test", subject: "access-user" };

let jwtKey: CryptoKey;
let otherKey: CryptoKey;
let accessKey: CryptoKey;
let jwtJwk: JWK;
let accessJwk: JWK;
let server: Server;
let origin: string;

beforeAll(async () => {
  const jwtKeys = await generateKeyPair("EdDSA");
  const accessKeys = await generateKeyPair("ES256");
  jwtKey = jwtKeys.privateKey;
  accessKey = accessKeys.privateKey;
  otherKey = (await generateKeyPair("EdDSA")).privateKey;
  jwtJwk = { ...(await exportJWK(jwtKeys.publicKey)), kid: "jwt-key" };
  accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "access-key" };
  server = createServer((request, response) => {
    if (request.url !== "/jwks") {
      response.writeHead(503).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [jwtJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await createRemoteJwtVerifier(jwtConfig, new URL(`${origin}/jwks`))(await jwt({}));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jwt(claims: Record<string, unknown>, expiry: string | number = "5m", key = jwtKey) {
  return new SignJWT({
    aud: jwtConfig.audience,
    email: "alpha@example.test",
    iss: jwtConfig.issuer,
    name: "Alpha User",
    sub: "user-alpha",
    ...claims,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "jwt-key" })
    .setExpirationTime(expiry)
    .sign(key);
}

function accessToken(claims: Record<string, unknown>) {
  return new SignJWT({
    aud: accessConfig.audience,
    email: "operator@example.test",
    iss: accessConfig.teamDomain,
    sub: "access-user",
    type: "app",
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "access-key" })
    .setExpirationTime("5m")
    .sign(accessKey);
}

const localJwtVerifier = () => createJwtVerifier(jwtConfig, createLocalJWKSet({ keys: [jwtJwk] }));

const localAccessVerifier = (config = accessConfig) =>
  createCloudflareAccessTokenVerifier(config, createLocalJWKSet({ keys: [accessJwk] }));

describe("createJwtVerifier", () => {
  it("a signed token", async () => {
    const verify = localJwtVerifier();

    expect(await verify(await jwt({}))).toEqual(identity);
  });

  it("a token signed by another key", async () => {
    const verify = localJwtVerifier();

    await expect(verify(await jwt({}, "5m", otherKey))).rejects.toThrow(
      "signature verification failed",
    );
  });

  it.each([
    ["another issuer", { iss: "https://attacker.test" }, 'unexpected "iss" claim value'],
    ["another audience", { aud: "other-api" }, 'unexpected "aud" claim value'],
    ["no identity", { sub: undefined }, "JWT requires an identity subject and email"],
  ])("a token with %s", async (_example, claims, message) => {
    const verify = localJwtVerifier();

    await expect(verify(await jwt(claims))).rejects.toThrow(message);
  });

  it("an expired token", async () => {
    const verify = localJwtVerifier();

    await expect(verify(await jwt({}, 0))).rejects.toThrow('"exp" claim timestamp check failed');
  });

  it.each([
    ["a blank issuer", { ...jwtConfig, issuer: " " }],
    ["a blank audience", { ...jwtConfig, audience: " " }],
  ])("%s", (_example, config) => {
    expect(() => createJwtVerifier(config, createLocalJWKSet({ keys: [] }))).toThrow(
      new TypeError("JWT issuer and audience are required"),
    );
  });
});

describe("createRemoteJwtVerifier", () => {
  it("a token signed by a published key", async () => {
    const verify = createRemoteJwtVerifier(jwtConfig, new URL(`${origin}/jwks`));

    expect(await verify(await jwt({}))).toEqual(identity);
  });

  it("a key endpoint that is down", async () => {
    const verify = createRemoteJwtVerifier(jwtConfig, new URL(`${origin}/down`));

    await expect(verify(await jwt({}))).rejects.toThrow(
      "Expected 200 OK from the JSON Web Key Set HTTP response",
    );
  });
});

describe("createCloudflareAccessTokenVerifier", () => {
  it("an application token", async () => {
    const verify = localAccessVerifier();

    expect(await verify(await accessToken({}))).toEqual(operator);
  });

  it("a team domain with padding and a trailing slash", async () => {
    const verify = localAccessVerifier({
      ...accessConfig,
      teamDomain: " https://meltiply.cloudflareaccess.com/ ",
    });

    expect(await verify(await accessToken({}))).toEqual(operator);
  });

  it.each([
    ["another application", { aud: "other" }, 'unexpected "aud" claim value'],
    ["a service identity", { type: "service" }, "Access token requires an identity"],
  ])("a token for %s", async (_example, claims, message) => {
    const verify = localAccessVerifier();

    await expect(verify(await accessToken(claims))).rejects.toThrow(message);
  });

  it("no key source", async () => {
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ keys: [accessJwk] }));
    const verify = createCloudflareAccessTokenVerifier(accessConfig);

    expect(await verify(await accessToken({}))).toEqual(operator);
    expect(fetched.mock.calls.map(([url]) => url)).toEqual([
      "https://meltiply.cloudflareaccess.com/cdn-cgi/access/certs",
    ]);
  });

  it("a blank audience", () => {
    expect(() => localAccessVerifier({ ...accessConfig, audience: " " })).toThrow(
      new TypeError("Access audience is required"),
    );
  });

  it.each([
    ["plain http", "http://meltiply.cloudflareaccess.com"],
    ["another host", "https://access.example.test"],
    ["the bare provider domain", "https://cloudflareaccess.com"],
    ["a path", "https://meltiply.cloudflareaccess.com/path"],
    ["a query", "https://meltiply.cloudflareaccess.com?a=1"],
    ["a fragment", "https://meltiply.cloudflareaccess.com#a"],
    ["credentials", "https://user:pass@meltiply.cloudflareaccess.com"],
    ["a port written out", "https://meltiply.cloudflareaccess.com:443"],
    ["text that is not a URL", "meltiply"],
  ])("a team domain with %s", (_example, teamDomain) => {
    expect(() => localAccessVerifier({ ...accessConfig, teamDomain })).toThrow(
      new TypeError("Access team domain must be a canonical HTTPS cloudflareaccess.com origin"),
    );
  });
});
