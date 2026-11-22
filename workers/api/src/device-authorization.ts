import type { BetterAuthInstance } from "@meltiply/auth";

import { lazySystemPoolFor } from "./database-module";
import { applicationOrigin, requiresEmailVerification, type ApiWorkerEnv } from "./env";
import { clonedJsonRecord } from "./request-json";

const nonAlphanumericPattern = /[^a-zA-Z0-9]/g;

export const DEVICE_CLIENT_ID = "melti-cli";
export const DEVICE_CODE_EXPIRES_IN = "10m";
export const DEVICE_POLL_INTERVAL = "5s";

interface DeviceClaimRow extends Record<string, unknown> {
  claim_session_id: string | null;
  status: string;
  user_id: string | null;
}
interface DeviceRedemptionClaimRow extends Record<string, unknown> {
  claim_session_id: string | null;
  claim_session_live: boolean;
  status: string;
  user_id: string | null;
}

interface DeviceSessionEligibility {
  eligible: boolean;
  reason?: string;
}

interface DeviceSessionRow extends Record<string, unknown> {
  email_verified: boolean;
  has_membership: boolean;
  member_id: string | null;
  suspended_at: Date | string | null;
}

export function deviceVerificationUri(env: ApiWorkerEnv): string {
  return `${applicationOrigin(env)}/device`;
}

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function deviceErrorResponse(status: number, error: string, description: string): Response {
  return noStore(Response.json({ error, error_description: description }, { status }));
}

function normalizeUserCode(value: string): string {
  return value.replace(nonAlphanumericPattern, "").toUpperCase();
}

export async function deviceCodeRequest(request: Request): Promise<Request | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return deviceErrorResponse(
      400,
      "invalid_request",
      "Device authorization requests must use a JSON body.",
    );
  }
  const body = await clonedJsonRecord(request);
  if (!body) {
    return deviceErrorResponse(400, "invalid_request", "Expected a JSON object.");
  }
  const clientId = body.client_id;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return deviceErrorResponse(400, "invalid_request", "client_id is required.");
  }
  if (clientId !== DEVICE_CLIENT_ID) {
    return deviceErrorResponse(400, "invalid_client", "The client is not supported.");
  }
  if (
    "user_id" in body &&
    body.user_id !== undefined &&
    body.user_id !== null &&
    body.user_id !== ""
  ) {
    return deviceErrorResponse(
      400,
      "invalid_request",
      "user_id is not supported for device authorization.",
    );
  }

  const sanitized: Record<string, unknown> = { ...body, client_id: DEVICE_CLIENT_ID };
  delete sanitized.user_id;
  delete sanitized.scope;
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request.url, {
    body: JSON.stringify(sanitized),
    headers,
    method: request.method,
    signal: request.signal,
  });
}

export async function deviceVerificationRequest(
  env: ApiWorkerEnv,
  auth: BetterAuthInstance,
  request: Request,
): Promise<Response> {
  const session = auth.getSession ? await auth.getSession(request.headers) : null;
  const response = await auth.handler(request);
  if (!session || response.status !== 200) return noStore(response);

  const userCode = new URL(request.url).searchParams.get("user_code");
  if (!userCode?.trim()) return noStore(response);
  const reviewable = typeof (await clonedJsonRecord(response))?.client_id === "string";
  if (!reviewable) return noStore(response);
  const pool = await lazySystemPoolFor(env);
  await pool.query(
    `UPDATE "deviceCode"
     SET "claimSessionId" = $1
     WHERE "userCode" = $2
       AND "userId" = $3
       AND status = 'pending'
       AND "claimSessionId" IS NULL`,
    [session.session.id, normalizeUserCode(userCode), session.user.id],
  );
  return noStore(response);
}

export async function deviceDecisionRequest(
  env: ApiWorkerEnv,
  auth: BetterAuthInstance,
  request: Request,
): Promise<Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return deviceErrorResponse(
      400,
      "invalid_request",
      "Device consent requests must use a JSON body.",
    );
  }
  const session = auth.getSession ? await auth.getSession(request.headers) : null;
  if (session) {
    const body = await clonedJsonRecord(request);
    const userCode = body?.userCode;
    if (typeof userCode === "string" && userCode.trim()) {
      const pool = await lazySystemPoolFor(env);
      const result = await pool.query<DeviceClaimRow>(
        `SELECT "userId" AS user_id,
                "claimSessionId" AS claim_session_id,
                status
         FROM "deviceCode"
         WHERE "userCode" = $1
         LIMIT 1`,
        [normalizeUserCode(userCode)],
      );
      const claim = result.rows[0];
      if (
        claim &&
        claim.status === "pending" &&
        claim.user_id === session.user.id &&
        claim.claim_session_id !== session.session.id
      ) {
        return deviceErrorResponse(
          403,
          "access_denied",
          "This device request was verified in a different browser session.",
        );
      }
    }
  }
  return noStore(await auth.handler(request));
}

export async function deviceTokenRequest(
  env: ApiWorkerEnv,
  auth: BetterAuthInstance,
  request: Request,
): Promise<Response> {
  const body = await clonedJsonRecord(request);
  const deviceCode = body?.device_code;
  let claimSession: { id: string; userId: string } | undefined;
  if (body?.client_id === DEVICE_CLIENT_ID && typeof deviceCode === "string" && deviceCode) {
    const pool = await lazySystemPoolFor(env);
    const result = await pool.query<DeviceRedemptionClaimRow>(
      `SELECT dc.status,
              dc."claimSessionId" AS claim_session_id,
              dc."userId" AS user_id,
              EXISTS (
                SELECT 1
                FROM "session" s
                WHERE s.id = dc."claimSessionId"
                  AND s."userId" = dc."userId"
                  AND s."expiresAt" > now()
              ) AS claim_session_live
       FROM "deviceCode" dc
       WHERE dc."deviceCode" = $1
       LIMIT 1`,
      [deviceCode],
    );
    const grant = result.rows[0];
    if (
      grant?.status === "approved" &&
      (!grant.claim_session_id || !grant.user_id || !grant.claim_session_live)
    ) {
      await pool.query(
        `UPDATE "deviceCode"
         SET status = 'denied'
         WHERE "deviceCode" = $1 AND status = 'approved'`,
        [deviceCode],
      );
    } else if (grant?.claim_session_id && grant.user_id) {
      claimSession = { id: grant.claim_session_id, userId: grant.user_id };
    }
  }

  const response = await auth.handler(request);
  if (response.status !== 200) return noStore(response);

  const tokenValue = (await clonedJsonRecord(response))?.access_token;
  const accessToken = typeof tokenValue === "string" && tokenValue ? tokenValue : undefined;
  if (!accessToken) {
    return deviceErrorResponse(500, "server_error", "The device grant could not be completed.");
  }

  let eligibility: DeviceSessionEligibility;
  try {
    eligibility = await deviceSessionEligibility(env, accessToken);
  } catch {
    await revokeSessionByToken(env, accessToken);
    return deviceErrorResponse(500, "server_error", "The device grant could not be completed.");
  }
  if (!eligibility.eligible) {
    await revokeSessionByToken(env, accessToken);
    return deviceErrorResponse(
      403,
      "access_denied",
      eligibility.reason ?? "This account is not eligible for CLI access.",
    );
  }
  if (!claimSession) {
    await revokeSessionByToken(env, accessToken);
    return deviceErrorResponse(
      400,
      "access_denied",
      "The browser session that approved this request is no longer active.",
    );
  }

  let claimStillLive: boolean;
  try {
    const pool = await lazySystemPoolFor(env);
    const live = await pool.query(
      `SELECT 1 FROM "session"
       WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()`,
      [claimSession.id, claimSession.userId],
    );
    claimStillLive = live.rows.length === 1;
  } catch {
    await revokeSessionByToken(env, accessToken);
    return deviceErrorResponse(500, "server_error", "The device grant could not be completed.");
  }
  if (!claimStillLive) {
    await revokeSessionByToken(env, accessToken);
    return deviceErrorResponse(
      400,
      "access_denied",
      "The browser session that approved this request is no longer active.",
    );
  }
  return noStore(response);
}

async function deviceSessionEligibility(
  env: ApiWorkerEnv,
  sessionToken: string,
): Promise<DeviceSessionEligibility> {
  const pool = await lazySystemPoolFor(env);
  const result = await pool.query<DeviceSessionRow>(
    `SELECT u."emailVerified" AS email_verified,
            iu.id AS member_id,
            iu.suspended_at,
            EXISTS (
              SELECT 1
              FROM org_members om
              JOIN organizations o ON o.id = om.org_id
              WHERE om.user_id = iu.id AND o.is_shared
            ) AS has_membership
     FROM "session" s
     JOIN "user" u ON u.id = s."userId"
     LEFT JOIN users iu ON iu.auth_user_id = u.id
     WHERE s.token = $1 AND s."expiresAt" > now()
     LIMIT 1`,
    [sessionToken],
  );
  const session = result.rows[0];
  if (!session || !session.member_id || session.suspended_at !== null) {
    return { eligible: false };
  }
  if (requiresEmailVerification(env) && !session.email_verified) {
    return { eligible: false };
  }
  if (!session.has_membership) {
    return {
      eligible: false,
      reason: "This account is not an active Workspace member.",
    };
  }
  return { eligible: true, reason: undefined };
}

async function revokeSessionByToken(env: ApiWorkerEnv, sessionToken: string): Promise<void> {
  const pool = await lazySystemPoolFor(env);
  await pool.query(`DELETE FROM "session" WHERE token = $1`, [sessionToken]);
}
