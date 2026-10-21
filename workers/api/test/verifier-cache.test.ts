// Pins AUD-037: verifier/origin caches must be keyed on configuration, not
// on the per-request bindings object. The runtime hands every request a
// fresh env, so an env-keyed cache misses and rebuilds verifiers on
// every request; identical config must return the same instance.
// Better Auth tenant JWT verification also caches its public issuer and trusted
// signing-key endpoint independently of the per-request bindings object.
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";

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

describe("verifier cache", () => {
  it("returns the same access verifier for identical config on fresh env objects", () => {
    const first = accessVerifierFor(env());
    const second = accessVerifierFor(env());
    expect(second).toBe(first);
  });

  it("returns the same allowed-origins set for identical config on fresh env objects", () => {
    const first = allowedOriginsFor(env());
    const second = allowedOriginsFor(env());
    expect(second).toBe(first);
    expect(second.has("https://app.example.com")).toBe(true);
  });

  it("rebuilds the access verifier when the configuration actually changes", () => {
    const baseline = accessVerifierFor(env());
    const changed = accessVerifierFor(env({ ACCESS_POLICY_AUD: "policy-aud-b" }));
    expect(changed).not.toBe(baseline);
  });

  it("fails closed without Access verifier configuration", () => {
    expect(() => accessVerifierFor(env({ ACCESS_TEAM_DOMAIN: undefined }))).toThrow(
      "Access verifier configuration is unavailable",
    );
    expect(() => accessVerifierFor(env({ ACCESS_POLICY_AUD: undefined }))).toThrow(
      "Access verifier configuration is unavailable",
    );
  });

  // Exercise signature verification against internal keys while public issuer
  // and audience remain mandatory, even behind browser-only Access ingress.
  it("verifies internal JWKS tokens without weakening public issuer or audience", async () => {
    const origin = "https://protected.example.test";
    const jwksUrl = "http://127.0.0.1:9876/api/auth/jwks";
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input) === jwksUrl
          ? Response.json({ keys: [{ ...publicKey, alg: "EdDSA", kid: "internal-key" }] })
          : new Response(null, {
              status: 302,
              headers: { location: "https://access.example.test" },
            }),
      ),
    );
    try {
      const verify = jwtVerifierFor(
        env({ BETTER_AUTH_URL: origin, BETTER_AUTH_JWKS_URL: jwksUrl }),
      );
      for (const overrides of [{}, { iss: "https://other.example.test" }, { aud: "other" }]) {
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "internal-key" })).toString(
          "base64url",
        );
        const payload = Buffer.from(
          JSON.stringify({
            sub: "owner",
            email: "owner@example.test",
            sid: "active-session",
            iss: origin,
            aud: origin,
            exp: Math.floor(Date.now() / 1000) + 60,
            ...overrides,
          }),
        ).toString("base64url");
        const signed = `${header}.${payload}`;
        const signature = await crypto.subtle.sign(
          "Ed25519",
          keys.privateKey,
          new TextEncoder().encode(signed),
        );
        const result = verify(`${signed}.${Buffer.from(signature).toString("base64url")}`);
        if ("iss" in overrides || "aud" in overrides) {
          await expect(result).rejects.toThrow();
        } else {
          await expect(result).resolves.toEqual({
            subject: "owner",
            email: "owner@example.test",
            sessionId: "active-session",
          });
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
