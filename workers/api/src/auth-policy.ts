import type { BetterAuthInstance, JwtIdentity } from "@meltiply/auth";
import { CoreApiError } from "./core-types";
import { sha256Hex } from "./crypto";
import {
  deviceCodeRequest,
  deviceDecisionRequest,
  deviceTokenRequest,
  deviceVerificationRequest,
  noStore,
} from "./device-authorization";
import { requiresEmailVerification, type ApiWorkerEnv } from "./env";

/** Reads only the installation's public initialized bit; never returns owner details. */
async function installationInitialized(env: ApiWorkerEnv): Promise<boolean> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const result = await systemPoolFor(env).query<{ initialized: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "user") AS initialized`,
  );
  return result.rows[0]?.initialized === true;
}

/**
 * Reads the normalized email from a cloned auth request body without consuming it.
 *
 * @param request - Incoming Better Auth request.
 * @returns Lowercase email when the JSON body carries one.
 */
async function requestEmail(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === "object" && "email" in body) {
      const email = body.email;
      if (typeof email === "string" && email.trim()) {
        return email.trim().toLowerCase();
      }
    }
  } catch {
    // Invalid JSON is rejected by Better Auth; the gate only needs a usable email.
  }
  return undefined;
}

/**
 * Resolves the pending invitation bound to a sign-up token, if any.
 *
 * @param env - Worker environment bindings.
 * @param token - Raw `X-Invitation-Token` header value.
 * @returns The invited email when the token is pending and unexpired.
 */
async function pendingInvitationEmail(
  env: ApiWorkerEnv,
  token: string,
): Promise<{ email: string } | null> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const tokenHash = await sha256Hex(token);
  const result = await systemPoolFor(env).query<{ email: string }>(
    `SELECT email
     FROM workspace_invitations
     WHERE token_hash = $1
       AND accepted_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
     LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Serializes first-account bootstrap decisions across Worker isolates.
 *
 * Two concurrent setup submissions could otherwise both observe an empty
 * `"user"` table and both create accounts. A session advisory lock held across
 * the Better Auth sign-up handler makes the emptiness check and account
 * creation one serialized critical section.
 *
 * @param env - Worker environment bindings.
 * @param operation - Bootstrap work to run while holding the lock.
 * @returns The operation's result.
 */
async function withBootstrapLock<T>(env: ApiWorkerEnv, operation: () => Promise<T>): Promise<T> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const client = await systemPoolFor(env).connect();
  // Constant advisory-lock key; scoped to this database's bootstrap window.
  await client.query("SELECT pg_advisory_lock($1)", [7_321_541]);
  try {
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [7_321_541]);
    } finally {
      client.release();
    }
  }
}

/**
 * Returns the stable invite-only rejection response.
 *
 * @returns 403 response with the `INVITATION_REQUIRED` code.
 */
function invitationRequiredResponse(): Response {
  return Response.json(
    {
      code: "INVITATION_REQUIRED",
      message: "This installation is invite-only. Ask an administrator for an invitation.",
    },
    { status: 403 },
  );
}

/**
 * Validates bounded profile fields before Better Auth stores them.
 *
 * @param request - Incoming Better Auth request with a JSON body.
 * @returns A rejection response, or null when the body is acceptable.
 */
async function profileValidationResponse(request: Request): Promise<Response | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return Response.json({ message: "Expected a JSON object." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ message: "Expected a JSON object." }, { status: 400 });
  }
  if (
    "name" in body &&
    (typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100 ||
      /[\x00-\x1F\x7F]/.test(body.name))
  ) {
    return Response.json(
      { message: "Name must contain 1–100 characters without control characters." },
      { status: 400 },
    );
  }
  if (
    "image" in body &&
    body.image !== null &&
    (typeof body.image !== "string" ||
      body.image.length > 2048 ||
      !URL.canParse(body.image) ||
      new URL(body.image).protocol !== "https:")
  ) {
    return Response.json(
      { message: "Profile image must be an HTTPS URL of at most 2048 characters." },
      { status: 400 },
    );
  }
  return null;
}

/**
 * Validates the private bootstrap credential with a constant-time MAC check.
 *
 * @param env - Worker environment bindings.
 * @param request - Incoming sign-up request carrying `X-Setup-Secret`.
 * @returns True when the deployment secret is configured and matches.
 */
async function validSetupSecret(env: ApiWorkerEnv, request: Request): Promise<boolean> {
  const expected = env.AUTH_SETUP_SECRET;
  if (!expected || expected.length < 32) return false;
  const supplied = request.headers.get("X-Setup-Secret") ?? "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(supplied));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected));
}
/**
 * Guards account creation and verification at the auth surface.
 *
 * After bootstrap, public sign-up is closed: an account may only be created
 * with a pending invitation token whose invited email matches the sign-up
 * address. The first account still requires the deployment setup secret and is
 * serialized behind an advisory lock. The Better Auth session hook separately
 * rejects suspended accounts. Secrets are never logged and the setup secret is
 * compared with a constant-time MAC check.
 *
 * @param env - Worker environment bindings.
 * @param auth - Configured Better Auth instance.
 * @returns Auth surface with the installation policy applied.
 */
export function authPolicyHandler(env: ApiWorkerEnv, auth: BetterAuthInstance): BetterAuthInstance {
  return {
    handler: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/setup-status" && request.method === "GET") {
        const initialized = await installationInitialized(env);
        if (!initialized && (env.AUTH_SETUP_SECRET?.length ?? 0) < 32) {
          return Response.json(
            {
              message:
                "Configure AUTH_SETUP_SECRET with at least 32 random characters before initial setup.",
            },
            { status: 503, headers: { "Cache-Control": "no-store" } },
          );
        }
        return Response.json({ initialized }, { headers: { "Cache-Control": "no-store" } });
      }
      if (path === "/api/auth/sign-up/email" && request.method === "POST") {
        if (await installationInitialized(env)) {
          const token = request.headers.get("X-Invitation-Token")?.trim() ?? "";
          if (!token) return invitationRequiredResponse();
          const invitation = await pendingInvitationEmail(env, token);
          if (!invitation) {
            return Response.json(
              {
                code: "INVITATION_INVALID",
                message: "The invitation is invalid, expired, or already used.",
              },
              { status: 403 },
            );
          }
          const email = await requestEmail(request);
          if (!email || email !== invitation.email.toLowerCase()) {
            return Response.json(
              {
                code: "INVITATION_EMAIL_MISMATCH",
                message: "This invitation was issued to a different email address.",
              },
              { status: 403 },
            );
          }
        } else {
          return withBootstrapLock(env, async () => {
            if (await installationInitialized(env)) return invitationRequiredResponse();
            if (!(await validSetupSecret(env, request))) {
              const configured = (env.AUTH_SETUP_SECRET?.length ?? 0) >= 32;
              return Response.json(
                {
                  message: configured
                    ? "The setup secret is invalid."
                    : "Configure AUTH_SETUP_SECRET with at least 32 random characters before initial setup.",
                },
                { status: configured ? 403 : 503 },
              );
            }
            return (await profileValidationResponse(request)) ?? auth.handler(request);
          });
        }
      }
      if (
        request.method === "POST" &&
        (path === "/api/auth/sign-up/email" || path === "/api/auth/update-user")
      ) {
        const invalidProfile = await profileValidationResponse(request);
        if (invalidProfile) return invalidProfile;
      }
      if (path === "/api/auth/device/code" && request.method === "POST") {
        const sanitized = await deviceCodeRequest(request);
        if (sanitized instanceof Response) return sanitized;
        return noStore(await auth.handler(sanitized));
      }
      if (path === "/api/auth/device" && request.method === "GET") {
        return deviceVerificationRequest(env, auth, request);
      }
      if (
        request.method === "POST" &&
        (path === "/api/auth/device/approve" || path === "/api/auth/device/deny")
      ) {
        return deviceDecisionRequest(env, auth, request);
      }
      if (path === "/api/auth/device/token" && request.method === "POST") {
        return deviceTokenRequest(env, auth, request);
      }
      const response = await auth.handler(request);
      if (path.startsWith("/api/auth/device") || path === "/api/auth/get-session") {
        return noStore(response);
      }
      return response;
    },
    getSession: auth.getSession,
  };
}

/**
 * Resolves a JWT's live session before any protected work. Reads the current
 * account rather than trusting stale JWT claims. Missing, revoked, expired, or
 * suspended sessions fail closed; email verification follows the installation's
 * configured policy. No cookie is accepted on this surface.
 *
 * The returned `emailVerified` lets actor resolution decide whether a pending
 * invitation may become an active membership.
 *
 * @param env - Worker environment bindings.
 * @param identity - Verified bearer JWT identity.
 * @returns The refreshed identity with live email verification state.
 * @throws {CoreApiError} 401 unauthenticated, 403 suspended or unverified.
 */
export async function activeIdentity(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
): Promise<JwtIdentity> {
  if (!identity.sessionId)
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const result = await systemPoolFor(env).query<{
    email: string;
    email_verified: boolean;
    name: string;
    suspended_at: Date | string | null;
  }>(
    `SELECT u.email, u.name, u."emailVerified" AS email_verified, iu.suspended_at
     FROM "session" s
     JOIN "user" u ON u.id = s."userId"
     LEFT JOIN users iu ON iu.auth_user_id = u.id
     WHERE s.id = $1 AND u.id = $2 AND s."expiresAt" > now()`,
    [identity.sessionId, identity.subject],
  );
  const account = result.rows[0];
  if (!account)
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  if (account.suspended_at !== null) {
    throw new CoreApiError(403, "account_suspended", "This account is suspended.");
  }
  const verificationBypassed = !requiresEmailVerification(env);
  if (!account.email_verified && !verificationBypassed) {
    throw new CoreApiError(403, "email_verification_required", "Verify your email to continue.");
  }
  return {
    ...identity,
    email: account.email,
    // Explicit verification policy also governs invitation activation; an
    // unverified account admitted by that policy must resolve consistently.
    emailVerified: account.email_verified || verificationBypassed,
    name: account.name,
  };
}
