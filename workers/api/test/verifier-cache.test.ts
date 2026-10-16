// Pins AUD-037: verifier/origin caches must be keyed on configuration, not
// on the per-request bindings object. The runtime hands every request a
// fresh env, so an env-keyed cache misses and rebuilds verifiers on
// every request; identical config must return the same instance.
// Better Auth is the only session authority: the module caches only the
// Cloudflare Access operator verifier plus the CORS origin set.
import { describe, expect, it } from "vite-plus/test";

import type { ApiWorkerEnv } from "../src/env";
import { accessVerifierFor, allowedOriginsFor } from "../src/verifier-cache";

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
});
