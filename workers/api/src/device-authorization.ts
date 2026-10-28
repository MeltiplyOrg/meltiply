import type { BetterAuthInstance } from "@meltiply/auth";

import { applicationOrigin, requiresEmailVerification, type ApiWorkerEnv } from "./env";

/**
 * The only supported device-flow client. The CLI protocol names this value in
 * every code and token request; arbitrary clients are rejected by the installed
 * Better Auth device plugin and again here before any database work.
 */
export const DEVICE_CLIENT_ID = "melti-cli";
/** Pending device requests expire after ten minutes. */
export const DEVICE_CODE_EXPIRES_IN = "10m";
/** Advertised minimum polling interval for the CLI. */
export const DEVICE_POLL_INTERVAL = "5s";

/** Row shape read by the same-browser-session consent guard. */
interface DeviceClaimRow extends Record<string, unknown> {
  claim_session_id: string | null;
  status: string;
  user_id: string | null;
}

/** Result of resolving a freshly minted CLI session against member policy. */
interface DeviceSessionEligibility {
  eligible: boolean;
  reason?: string;
}

/** Row shape read by the CLI session eligibility check. */
interface DeviceSessionRow extends Record<string, unknown> {
  email_verified: boolean;
  has_membership: boolean;
  member_id: string | null;
  suspended_at: Date | string | null;
}

/**
 * Builds the absolute browser verification URL on the installation application
 * origin. The URL is derived from validated configuration, never from the
 * request's (possibly forwarded) host, so a proxy or alternate API origin
 * cannot move consent to another site.
 *
 * @param env - Worker environment bindings containing the application origin.
 * @returns Absolute `${applicationOrigin}/device` URL.
 */
export function deviceVerificationUri(env: ApiWorkerEnv): string {
  return new URL("/device", applicationOrigin(env)).href;
}

/**
 * Marks a credential-bearing auth response non-cacheable in place.
 *
 * Better Auth builds these responses locally, so their header guards are
 * mutable; mutating avoids rebuilding a response and preserves every
 * Set-Cookie header.
 *
 * @param response - Auth response to protect.
 * @returns The same response with no-store pragmas.
 */
export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

/**
 * Returns an RFC 8628-style device error response without credentials.
 *
 * @param status - HTTP status code.
 * @param error - Machine error (`invalid_request`, `slow_down`, ...).
 * @param description - Human-readable, non-secret explanation.
 * @returns Non-cacheable JSON error response.
 */
export function deviceErrorResponse(
  status: number,
  error: string,
  description: string,
): Response {
  return noStore(
    Response.json({ error, error_description: description }, { status }),
  );
}

/**
 * Parses a cloned JSON request body as a plain record without consuming the
 * original request stream.
 *
 * @param request - Incoming auth request.
 * @returns The JSON object, or undefined when the body is absent or not an object.
 */
async function requestJsonRecord(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await request.clone().json();
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The endpoint returns the protocol's invalid_request error below.
  }
  return undefined;
}

/**
 * Normalizes a user-facing code exactly as the installed plugin does before a
 * lookup: remove separators and uppercase the remaining characters.
 *
 * @param value - Raw user code from a request.
 * @returns Normalized code used in deviceCode lookups.
 */
function normalizeUserCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Enforces the supported-client contract on device-code issuance before Better
 * Auth handles the request.
 *
 * The installed plugin accepts optional `user_id` (pre-binding a request to a
 * member) and `scope`. Meltiply's protocol allows neither: the approving
 * browser claims the request, and scope is not an authority grant. This
 * wrapper rejects non-JSON bodies, rejects pre-binding, strips scope, and
 * rebuilds the request so the plugin can only persist the supported fields.
 *
 * @param request - Incoming `POST /api/auth/device/code` request.
 * @returns A sanitized request, or a protocol error response.
 */
export async function deviceCodeRequest(request: Request): Promise<Request | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return deviceErrorResponse(
      400,
      "invalid_request",
      "Device authorization requests must use a JSON body.",
    );
  }
  const body = await requestJsonRecord(request);
  if (!body) {
    return deviceErrorResponse(400, "invalid_request", "Expected a JSON object.");
  }
  const clientId = body.client_id;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return deviceErrorResponse(400, "invalid_request", "client_id is required.");
  }
  if (clientId.trim() !== DEVICE_CLIENT_ID) {
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
  // The rebuilt body has a different length; let the runtime derive it.
  headers.delete("Content-Length");
  return new Request(request.url, {
    body: JSON.stringify(sanitized),
    headers,
    method: request.method,
    signal: request.signal,
  });
}

/**
 * Handles `GET /api/auth/device` and durably binds a claimed request to the
 * browser session that verified it.
 *
 * Better Auth claims an unclaimed pending request for the authenticated user
 * (atomic `userId` compare-and-set) and returns reviewable context only to that
 * user. It binds to the member, not the browser session, so this wrapper records
 * the first session to receive the review context. The approve/deny guard uses
 * that binding to refuse a different session of the same member.
 *
 * @param env - Worker environment bindings.
 * @param auth - Production-composed Better Auth instance.
 * @param request - Incoming verification request.
 * @returns The auth response with no-store headers.
 */
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
  // The plugin returns client context only to the member that owns the
  // claimed request. A same-member session that lost the claim race receives
  // no context, so it must not steal the binding from the session that
  // actually reviewed the request.
  let reviewable = false;
  try {
    const body: unknown = await response.clone().json();
    reviewable =
      body !== null && typeof body === "object" && "client_id" in body && typeof body.client_id === "string";
  } catch {
    // A non-JSON success is not a reviewable verification response.
  }
  if (!reviewable) return noStore(response);
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(
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

/**
 * Handles `POST /api/auth/device/approve` and `/deny`.
 *
 * The installed plugin remains the authority for expiry, status, claimed-member
 * ownership, and CSRF/origin checks. This guard adds the protocol's stricter
 * rule that only the browser session which verified the code may consent:
 * any other session of the same member is refused before the plugin decision.
 * Unclaimed or differently-owned requests pass through unchanged so the plugin
 * returns its own RFC error; a missing binding fails closed.
 *
 * @param env - Worker environment bindings.
 * @param auth - Production-composed Better Auth instance.
 * @param request - Incoming approval or denial request.
 * @returns The auth response with no-store headers.
 */
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
    const body = await requestJsonRecord(request);
    const userCode = body?.userCode;
    if (typeof userCode === "string" && userCode.trim()) {
      // Exception: pg cannot be loaded in workerd unit-test isolates.
      const { systemPoolFor } = await import("./database");
      const result = await systemPoolFor(env).query<DeviceClaimRow>(
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

/**
 * Handles `POST /api/auth/device/token`.
 *
 * Better Auth owns the polling state machine, expiry/denial/approval outcomes,
 * atomic single-use consumption, and session creation. After a successful
 * issuance, this wrapper confirms that the new CLI session belongs to an
 * active, policy-eligible member before releasing the raw session credential:
 * suspended or deleted accounts, unverified accounts when verification is
 * required, and accounts without the shared Workspace membership are denied and
 * the freshly minted session is revoked. The credential is never logged.
 *
 * @param env - Worker environment bindings.
 * @param auth - Production-composed Better Auth instance.
 * @param request - Incoming token exchange request.
 * @returns The plugin response, or a fail-closed protocol error.
 */
export async function deviceTokenRequest(
  env: ApiWorkerEnv,
  auth: BetterAuthInstance,
  request: Request,
): Promise<Response> {
  const response = await auth.handler(request);
  if (response.status !== 200) return noStore(response);

  let accessToken: string | undefined;
  try {
    const body: unknown = await response.clone().json();
    if (body !== null && typeof body === "object" && "access_token" in body) {
      const value = body.access_token;
      if (typeof value === "string" && value) accessToken = value;
    }
  } catch {
    // A 200 without a usable credential is never released.
  }
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
  return noStore(response);
}

/**
 * Confirms the freshly issued CLI session's member state against authoritative
 * account, verification, suspension, and shared-Workspace membership records.
 *
 * @param env - Worker environment bindings.
 * @param sessionToken - Raw session credential returned to the device (never logged).
 * @returns Eligibility with a non-secret denial reason.
 */
async function deviceSessionEligibility(
  env: ApiWorkerEnv,
  sessionToken: string,
): Promise<DeviceSessionEligibility> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const result = await systemPoolFor(env).query<DeviceSessionRow>(
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

/**
 * Revokes a session whose credential was minted for an ineligible member so a
 * withheld response cannot leave usable authority behind.
 *
 * @param env - Worker environment bindings.
 * @param sessionToken - Raw session credential.
 */
async function revokeSessionByToken(env: ApiWorkerEnv, sessionToken: string): Promise<void> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  await systemPoolFor(env).query(`DELETE FROM "session" WHERE token = $1`, [sessionToken]);
}
