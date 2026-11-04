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
import { workspaceNameValue } from "./validation";

const controlCharactersPattern = /[\x00-\x1F\x7F]/;

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
      controlCharactersPattern.test(body.name))
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
      URL.parse(body.image)?.protocol !== "https:")
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
 * Reads and validates the optional `workspace_name` from a sign-up body.
 *
 * The name belongs to the setup form rather than the Better Auth user record,
 * so it is validated here (before any account exists) and stripped before the
 * library sees the body.
 *
 * @param request - Incoming sign-up request.
 * @returns The trimmed name, undefined when the field was omitted, or the
 *   rejection response for an invalid value.
 */
async function signUpWorkspaceName(request: Request): Promise<string | undefined | Response> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || !("workspace_name" in body)) return undefined;
  if (body.workspace_name === undefined || body.workspace_name === null) return undefined;
  try {
    return workspaceNameValue(body.workspace_name, "workspace_name");
  } catch (cause) {
    if (cause instanceof CoreApiError) {
      return Response.json({ message: cause.message }, { status: cause.status });
    }
    throw cause;
  }
}

/**
 * Persists the setup form's chosen Workspace name before the account exists.
 *
 * The sign-up response is not the only way an account becomes real: the
 * verification mail can fail after Better Auth committed the account, and the
 * invocation can end between the account write and any follow-up. Writing the
 * name against the normalized sign-up email first makes the choice recoverable
 * from durable state in all of those cases, without touching the account row and
 * without giving an unauthenticated request any authority. Registration remains
 * gated on account existence, so a recoverable intent never reopens sign-up.
 *
 * @param env - Worker environment bindings.
 * @param email - Normalized sign-up email.
 * @param workspaceName - Chosen name, or undefined when the form omitted it.
 * @returns Effect resolving void.
 */
async function recordBootstrapIntent(
  env: ApiWorkerEnv,
  email: string,
  workspaceName: string | undefined,
): Promise<void> {
  if (!email) return;
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(
    `INSERT INTO installation_bootstrap_intent (email, workspace_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE
       SET workspace_name = COALESCE(EXCLUDED.workspace_name, installation_bootstrap_intent.workspace_name)`,
    [email.toLowerCase(), workspaceName ?? null],
  );
}

/**
 * Discards an intent whose sign-up definitively created no account.
 *
 * A 4xx response from Better Auth (rejected password, duplicate address, failed
 * profile validation) proves nothing was written, so the row must not become a
 * permanent name for an address that never signed up. A 5xx or a thrown handler
 * proves nothing either way, so the intent is kept for recovery.
 *
 * @param env - Worker environment bindings.
 * @param email - Normalized sign-up email.
 * @returns Effect resolving void.
 */
async function discardBootstrapIntent(env: ApiWorkerEnv, email: string): Promise<void> {
  if (!email) return;
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(
    "DELETE FROM installation_bootstrap_intent WHERE email = $1 AND auth_user_id IS NULL",
    [email.toLowerCase()],
  );
}

/**
 * Binds a recorded intent to the account Better Auth created.
 *
 * @param env - Worker environment bindings.
 * @param email - Normalized sign-up email.
 * @param authUserId - Created subject.
 * @returns Effect resolving void.
 */
async function bindBootstrapIntent(
  env: ApiWorkerEnv,
  email: string,
  authUserId: string,
): Promise<void> {
  if (!email) return;
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(
    "UPDATE installation_bootstrap_intent SET auth_user_id = $2 WHERE email = $1",
    [email.toLowerCase(), authUserId],
  );
}

/**
 * Persists the chosen Workspace name against the account Better Auth created.
 *
 * Called inside the bootstrap lock after a successful sign-up, so the name is
 * durable before the verification handoff and later applied by actor resolution
 * when the canonical shared Workspace is provisioned.
 *
 * @param env - Worker environment bindings.
 * @param authUserId - Better Auth subject returned by the sign-up response.
 * @param workspaceName - Chosen name, or undefined to keep the derived default.
 * @returns True when a bootstrap row was written.
 */
async function recordBootstrap(
  env: ApiWorkerEnv,
  authUserId: string | undefined,
  workspaceName: string | undefined,
): Promise<boolean> {
  if (!authUserId) return false;
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(
    `INSERT INTO installation_bootstrap (auth_user_id, workspace_name)
     VALUES ($1, $2)
     ON CONFLICT (auth_user_id) DO UPDATE
       SET workspace_name = COALESCE(EXCLUDED.workspace_name, installation_bootstrap.workspace_name)`,
    [authUserId, workspaceName ?? null],
  );
  return true;
}

/**
 * Strips the setup-only `workspace_name` field from a sign-up request body.
 *
 * Better Auth's sign-up schema rejects undeclared user fields, and the name is
 * not part of the account record. The rebuilt request keeps every other header
 * and body field, so the library still receives the exact credentials the
 * caller submitted.
 *
 * @param request - Incoming sign-up request.
 * @returns A request whose JSON body omits `workspace_name`.
 */
async function withoutWorkspaceName(request: Request): Promise<Request> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!body || typeof body !== "object" || !("workspace_name" in body)) return request;
  const { workspace_name: _ignored, ...rest } = body as Record<string, unknown>;
  const headers = new Headers(request.headers);
  // The rebuilt body has a different length; a copied Content-Length would make
  // the request unreadable for the library.
  headers.delete("Content-Length");
  return new Request(request.url, { body: JSON.stringify(rest), headers, method: request.method });
}

/**
 * Extracts the Better Auth subject from a sign-up response body.
 *
 * @param response - Sign-up response to inspect without consuming it.
 * @returns The created subject, or undefined when the body is unusable.
 */
async function signedUpSubject(response: Response): Promise<string | undefined> {
  if (!response.ok) return undefined;
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== "object" || !("user" in body)) return undefined;
    const user = body.user;
    if (!user || typeof user !== "object" || !("id" in user)) return undefined;
    return typeof user.id === "string" ? user.id : undefined;
  } catch {
    return undefined;
  }
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
            const workspaceName = await signUpWorkspaceName(request);
            if (workspaceName instanceof Response) return workspaceName;
            const invalidProfile = await profileValidationResponse(request);
            if (invalidProfile) return invalidProfile;
            const email = await requestEmail(request);
            // The name is durable before the account exists, so a failed
            // verification mail or an invocation ending after account creation
            // cannot lose what the Owner already typed. This adds no authority:
            // public sign-up is still closed by account existence alone.
            if (email) await recordBootstrapIntent(env, email, workspaceName);
            // A thrown handler proves nothing about the account write, so the
            // intent above stays for recovery rather than being discarded here.
            const response = await auth.handler(await withoutWorkspaceName(request));
            if (response.ok) {
              const subject = await signedUpSubject(response);
              // Recorded under the lock, so the name is ordered with account
              // creation and a retry cannot pair it with a different account.
              await recordBootstrap(env, subject, workspaceName);
              if (subject && email) await bindBootstrapIntent(env, email, subject);
            } else if (response.status < 500 && email) {
              // A 4xx rejection proves nothing was written, so the intent must
              // not become a permanent name for an address that never signed up.
              await discardBootstrapIntent(env, email);
            }
            return response;
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
 * invitation may become an active membership. `clientChannel` comes from the
 * live session row, never a JWT claim or client-supplied header.
 *
 * @param env - Worker environment bindings.
 * @param identity - Verified bearer JWT identity.
 * @returns The refreshed identity with live verification state and credential provenance.
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
    client_channel: "web" | "cli" | "unknown";
    email: string;
    email_verified: boolean;
    name: string;
    suspended_at: Date | string | null;
  }>(
    `SELECT u.email, u.name, u."emailVerified" AS email_verified, iu.suspended_at,
            s."clientChannel" AS client_channel
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
    clientChannel: account.client_channel,
    email: account.email,
    // Explicit verification policy also governs invitation activation; an
    // unverified account admitted by that policy must resolve consistently.
    emailVerified: account.email_verified || verificationBypassed,
    name: account.name,
  };
}
