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

let jwtVerifier: { configured: string; jwksOverride: string; value: JwtVerifier } | undefined;

function split(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

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

export function jwtVerifierFor(env: ApiWorkerEnv): JwtVerifier {
  const configured = env.APP_URL?.trim();
  if (!configured) {
    throw new Error("Better Auth JWT verifier configuration is unavailable");
  }
  const jwksOverride = env.BETTER_AUTH_JWKS_URL?.trim() ?? "";
  if (
    jwtVerifier &&
    jwtVerifier.configured === configured &&
    jwtVerifier.jwksOverride === jwksOverride
  ) {
    return jwtVerifier.value;
  }
  const origin = new URL(configured).origin;
  const jwksUrl = new URL(jwksOverride || `${origin}/api/auth/jwks`);
  const verifier = createRemoteJwtVerifier({ audience: origin, issuer: origin }, jwksUrl);
  jwtVerifier = { configured, jwksOverride, value: verifier };
  return verifier;
}
