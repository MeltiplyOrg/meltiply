import type { BetterAuthInstance, JwtIdentity } from "@meltiply/auth";
import { Effect } from "effect";
import { CoreApiError } from "./api-errors";
import { sha256Hex } from "./crypto";
import { lazySystemPoolFor, lazyWithSystemTransactionEffect } from "./database-module";
import {
  deviceCodeRequest,
  deviceDecisionRequest,
  deviceTokenRequest,
  deviceVerificationRequest,
  noStore,
} from "./device-authorization";
import { requiresEmailVerification, type ApiWorkerEnv } from "./env";
import { clonedJsonRecord, clonedStringField } from "./request-json";
import { workspaceNameValue } from "./validation";

const controlCharactersPattern = /[\x00-\x1F\x7F]/;
// Hyperdrive pools in transaction mode, so only transaction-level advisory locks are safe:
// https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
const BOOTSTRAP_LOCK_KEY = 7_321_541;

async function installationInitialized(env: ApiWorkerEnv): Promise<boolean> {
  const pool = await lazySystemPoolFor(env);
  const result = await pool.query<{ initialized: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "user") AS initialized`,
  );
  return result.rows[0]?.initialized === true;
}

async function requestEmail(request: Request): Promise<string | undefined> {
  return (await clonedStringField(request, "email"))?.toLowerCase();
}

async function pendingInvitationEmail(
  env: ApiWorkerEnv,
  token: string,
): Promise<{ email: string } | null> {
  const pool = await lazySystemPoolFor(env);
  const tokenHash = await sha256Hex(token);
  const result = await pool.query<{ email: string }>(
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

async function withBootstrapLock<T>(env: ApiWorkerEnv, operation: () => Promise<T>): Promise<T> {
  return Effect.runPromise(
    lazyWithSystemTransactionEffect(env, (client) =>
      client
        .query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY])
        .pipe(Effect.flatMap(() => Effect.promise(operation))),
    ),
  );
}

function invitationRequiredResponse(): Response {
  return Response.json(
    {
      code: "INVITATION_REQUIRED",
      message: "This installation is invite-only. Ask an administrator for an invitation.",
    },
    { status: 403 },
  );
}

async function profileValidationResponse(request: Request): Promise<Response | null> {
  const body = await clonedJsonRecord(request);
  if (!body) {
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
async function signUpWorkspaceName(request: Request): Promise<string | undefined | Response> {
  const body = await clonedJsonRecord(request);
  if (!body || !("workspace_name" in body)) return undefined;
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

async function recordBootstrapIntent(
  env: ApiWorkerEnv,
  email: string,
  workspaceName: string | undefined,
): Promise<void> {
  if (!email) return;
  const pool = await lazySystemPoolFor(env);
  await pool.query(
    `INSERT INTO installation_bootstrap_intent (email, workspace_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE
       SET workspace_name = COALESCE(EXCLUDED.workspace_name, installation_bootstrap_intent.workspace_name)`,
    [email.toLowerCase(), workspaceName ?? null],
  );
}

async function discardBootstrapIntent(env: ApiWorkerEnv, email: string): Promise<void> {
  if (!email) return;
  const pool = await lazySystemPoolFor(env);
  await pool.query(
    "DELETE FROM installation_bootstrap_intent WHERE email = $1 AND auth_user_id IS NULL",
    [email.toLowerCase()],
  );
}

async function bindBootstrapIntent(
  env: ApiWorkerEnv,
  email: string,
  authUserId: string,
): Promise<void> {
  if (!email) return;
  const pool = await lazySystemPoolFor(env);
  await pool.query("UPDATE installation_bootstrap_intent SET auth_user_id = $2 WHERE email = $1", [
    email.toLowerCase(),
    authUserId,
  ]);
}

async function recordBootstrap(
  env: ApiWorkerEnv,
  authUserId: string | undefined,
  workspaceName: string | undefined,
): Promise<boolean> {
  if (!authUserId) return false;
  const pool = await lazySystemPoolFor(env);
  await pool.query(
    `INSERT INTO installation_bootstrap (auth_user_id, workspace_name)
     VALUES ($1, $2)
     ON CONFLICT (auth_user_id) DO UPDATE
       SET workspace_name = COALESCE(EXCLUDED.workspace_name, installation_bootstrap.workspace_name)`,
    [authUserId, workspaceName ?? null],
  );
  return true;
}

async function withoutWorkspaceName(request: Request): Promise<Request> {
  const body = await clonedJsonRecord(request);
  if (!body || !("workspace_name" in body)) return request;
  const { workspace_name: _ignored, ...rest } = body;
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  return new Request(request.url, { body: JSON.stringify(rest), headers, method: request.method });
}

async function signedUpSubject(response: Response): Promise<string | undefined> {
  if (!response.ok) return undefined;
  const body = await clonedJsonRecord(response);
  const user = body?.user;
  if (!user || typeof user !== "object" || !("id" in user)) return undefined;
  return typeof user.id === "string" ? user.id : undefined;
}

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
            if (email) await recordBootstrapIntent(env, email, workspaceName);
            const response = await auth.handler(await withoutWorkspaceName(request));
            if (response.ok) {
              const subject = await signedUpSubject(response);
              await recordBootstrap(env, subject, workspaceName);
              if (subject && email) await bindBootstrapIntent(env, email, subject);
            } else if (response.status < 500 && email) {
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

export async function activeIdentity(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
): Promise<JwtIdentity> {
  if (!identity.sessionId)
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  const pool = await lazySystemPoolFor(env);
  const result = await pool.query<{
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
    emailVerified: account.email_verified || verificationBypassed,
    name: account.name,
  };
}
