// Module-level verifier/origin caches for the API Worker (AUD-037).
//
// The runtime hands every request a fresh bindings object, so caching keyed
// on `env` never hits. These caches live at module scope (isolate lifetime)
// and are keyed on the configuration strings that actually change the
// verifier behavior — identical config returns the same instance across
// requests, and a different config (tests, mixed bindings) rebuilds safely.
import {
  createCloudflareAccessTokenVerifier,
  createRemoteJwtVerifier,
  type AccessTokenVerifier,
  type JwtVerifier,
} from "@meltiply/auth";

import type { ApiWorkerEnv } from "./env";

let accessVerifier:
  | { audience: string; teamDomain: string; value: AccessTokenVerifier }
  | undefined;

let allowedOrigins: { raw: string; values: ReadonlySet<string> } | undefined;

let jwtVerifier: { origin: string; jwksUrl: string; value: JwtVerifier } | undefined;

/**
 * Splits a comma-separated configuration string into a trimmed, non-empty list of tokens.
 *
 * @param value - Raw comma-separated configuration string.
 * @returns Array of trimmed tokens, or undefined if the input is empty or undefined.
 */
function split(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

/**
 * Returns the cached set of approved CORS origins parsed from the environment.
 *
 * Trusts APP_URL by default and adds explicitly configured ALLOWED_ORIGINS.
 * Reuses the resulting ReadonlySet until either configuration string changes.
 *
 * @param env - Worker environment bindings containing APP_URL and optional extra origins.
 * @returns ReadonlySet of approved origin strings.
 */
export function allowedOriginsFor(env: ApiWorkerEnv): ReadonlySet<string> {
  const raw = `${env.APP_URL?.trim() ?? ""},${env.ALLOWED_ORIGINS ?? ""}`;
  if (allowedOrigins && allowedOrigins.raw === raw) {
    return allowedOrigins.values;
  }
  const values = new Set(split(env.ALLOWED_ORIGINS) ?? []);
  if (env.APP_URL?.trim()) values.add(new URL(env.APP_URL.trim()).origin);
  allowedOrigins = { raw, values };
  return values;
}

/**
 * Returns a cached Cloudflare Access token verifier keyed by team domain and audience.
 *
 * Reuses the JWKS verifier across requests in the same isolate, preventing redundant
 * certificate fetches. Reconstructs the verifier if teamDomain or audience change.
 *
 * @param env - Worker environment bindings containing Access verifier configuration.
 * @returns Configured `AccessTokenVerifier` capable of verifying Cloudflare Access JWTs.
 * @throws {Error} If `ACCESS_TEAM_DOMAIN` or `ACCESS_POLICY_AUD` is missing.
 */
export function accessVerifierFor(env: ApiWorkerEnv): AccessTokenVerifier {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_POLICY_AUD;
  if (!teamDomain || !audience) {
    throw new Error("Access verifier configuration is unavailable");
  }
  if (
    accessVerifier &&
    accessVerifier.teamDomain === teamDomain &&
    accessVerifier.audience === audience
  ) {
    return accessVerifier.value;
  }
  const verifier = createCloudflareAccessTokenVerifier({
    audience,
    teamDomain,
  });
  accessVerifier = { audience, teamDomain, value: verifier };
  return verifier;
}

/**
 * Returns a cached Better Auth JWT verifier keyed by issuer and signing-key URL.
 *
 * Issuer and audience remain pinned to the public auth origin. An optional
 * BETTER_AUTH_JWKS_URL routes key retrieval through trusted internal ingress,
 * avoiding browser-only Access challenges on protected development tunnels.
 * Without the override, keys come from the public origin's /api/auth/jwks.
 *
 * @param env - Worker environment bindings containing Better Auth URL configuration.
 * @returns Configured `JwtVerifier` validating signature, issuer, audience, and identity claims.
 * @throws {Error} If APP_URL is not configured.
 */
export function jwtVerifierFor(env: ApiWorkerEnv): JwtVerifier {
  const configured = env.APP_URL?.trim();
  if (!configured) {
    throw new Error("Better Auth JWT verifier configuration is unavailable");
  }
  const origin = new URL(configured).origin;
  const jwksUrl = new URL(env.BETTER_AUTH_JWKS_URL?.trim() || `${origin}/api/auth/jwks`).href;
  if (jwtVerifier && jwtVerifier.origin === origin && jwtVerifier.jwksUrl === jwksUrl) {
    return jwtVerifier.value;
  }
  const verifier = createRemoteJwtVerifier({ audience: origin, issuer: origin }, new URL(jwksUrl));
  jwtVerifier = { origin, jwksUrl, value: verifier };
  return verifier;
}
