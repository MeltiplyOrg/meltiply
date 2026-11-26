import type { JWTPayload } from "jose";

const bearerTokenPattern = /^Bearer ([^\s]+)$/;

/**
 * Identity from a verified Better Auth JWT. `clientChannel` and `emailVerified` are never JWT
 * claims; the host fills them from the live database session.
 */
export interface JwtIdentity {
  clientChannel?: "web" | "cli" | "unknown";
  email: string;
  emailVerified?: boolean;
  name?: string;
  subject: string;
  sessionId?: string;
}

export interface AccessClaims {
  email: string;
  subject: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(bearerTokenPattern)?.[1];
}

/** Throws `TypeError` unless the payload carries a non-empty subject and email. */
export function jwtClaims(payload: JWTPayload): JwtIdentity {
  const subject = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  if (!subject || !email) {
    throw new TypeError("JWT requires an identity subject and email");
  }
  const name = nonEmptyString(payload.name);
  const sessionId = nonEmptyString(payload.sid);
  return { email, ...(name ? { name } : {}), ...(sessionId ? { sessionId } : {}), subject };
}

/** Throws `TypeError` unless the payload is an Access application identity (`type: "app"`). */
export function accessClaims(payload: JWTPayload): AccessClaims {
  const subject = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  if (!subject || !email || payload.type !== "app") {
    throw new TypeError("Access token requires an identity subject and email");
  }
  return { email, subject };
}
