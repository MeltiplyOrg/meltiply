import { Buffer } from "node:buffer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { ApiWorkerEnv } from "../src/env";
import { accessVerifierFor, allowedOriginsFor, jwtVerifierFor } from "../src/verifier-cache";

function env(overrides: Partial<ApiWorkerEnv> = {}): ApiWorkerEnv {
  return {
    ACCESS_POLICY_AUD: "policy-aud",
    ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    ALLOWED_ORIGINS: "https://app.example.com",
    ENVIRONMENT: "test",
    VERSION: "test",
    ...overrides,
  };
}

describe("accessVerifierFor", () => {
  it("reuses the verifier for identical config on fresh env objects", () => {
    const first = accessVerifierFor(env());

    expect(accessVerifierFor(env())).toBe(first);
  });

  it("rebuilds the verifier when the policy audience changes", () => {
    const baseline = accessVerifierFor(env());

    expect(accessVerifierFor(env({ ACCESS_POLICY_AUD: "policy-aud-b" }))).not.toBe(baseline);
  });

  it.each([
    ["missing team domain", { ACCESS_TEAM_DOMAIN: undefined }],
    ["missing policy audience", { ACCESS_POLICY_AUD: undefined }],
  ])("fails closed with %s", (_example, overrides) => {
    expect(() => accessVerifierFor(env(overrides))).toThrow(
      "Access verifier configuration is unavailable",
    );
  });
});

describe("allowedOriginsFor", () => {
  it("reuses the parsed origin set for identical config", () => {
    const first = allowedOriginsFor(env());
    const second = allowedOriginsFor(env());

    expect(second).toBe(first);
    expect([...second]).toEqual(["https://app.example.com"]);
  });
});

describe("jwtVerifierFor", () => {
  const origin = "https://protected.example.test";
  const jwksUrl = "http://127.0.0.1:9876/api/auth/jwks";
  let keys: CryptoKeyPair;
  let publicKey: JsonWebKey;

  beforeAll(async () => {
    keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function signToken(overrides: Record<string, unknown> = {}) {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "internal-key" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        aud: origin,
        email: "owner@example.test",
        exp: Math.floor(Date.now() / 1000) + 60,
        iss: origin,
        sid: "active-session",
        sub: "owner",
        ...overrides,
      }),
    ).toString("base64url");
    const signed = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  }

  function stubJwksFetch() {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input) === jwksUrl
        ? Response.json({ keys: [{ ...publicKey, alg: "EdDSA", kid: "internal-key" }] })
        : new Response(null, {
            headers: { location: "https://access.example.test" },
            status: 302,
          }),
    );
  }

  it("verifies a valid internal JWKS token matching public issuer and audience", async () => {
    stubJwksFetch();
    const verify = jwtVerifierFor(env({ APP_URL: origin, BETTER_AUTH_JWKS_URL: jwksUrl }));

    expect(await verify(await signToken())).toEqual({
      email: "owner@example.test",
      sessionId: "active-session",
      subject: "owner",
    });
  });

  it.each([
    ["a foreign issuer", { iss: "https://other.example.test" }],
    ["a foreign audience", { aud: "other" }],
  ])("rejects a token with %s", async (_example, overrides) => {
    stubJwksFetch();
    const verify = jwtVerifierFor(env({ APP_URL: origin, BETTER_AUTH_JWKS_URL: jwksUrl }));

    await expect(verify(await signToken(overrides))).rejects.toThrow();
  });
});
