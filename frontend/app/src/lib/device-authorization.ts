import { authClient } from "./auth-client";

/**
 * Verification state reported by Better Auth's device-authorization plugin.
 * `pending` still allows a decision; `approved` and `denied` are terminal.
 */
type DeviceAuthorizationStatus = "approved" | "denied" | "pending";

/**
 * Reviewable device request returned to the browser session that claimed it.
 * `client_id` and `scope` are present only for the owning session; a pending
 * response without them belongs to another account. `scope` is informational
 * and never grants capabilities: the CLI acts with the approving member's
 * current Workspace permissions.
 */
export interface DeviceAuthorizationReview {
  client_id?: string;
  scope?: string;
  status: DeviceAuthorizationStatus;
  user_code: string;
}

/** Stable device-flow error identifiers the consent surface can explain. */
export type DeviceAuthorizationErrorCode =
  | "access_denied"
  | "device_code_already_processed"
  | "expired_token"
  | "invalid_grant"
  | "invalid_request"
  | "rate_limited"
  | "unauthorized"
  | "unknown";

export interface DeviceAuthorizationErrorDetails {
  code: DeviceAuthorizationErrorCode;
  /** Plugin or Worker description; retained for diagnostics, never rendered raw. */
  description?: string;
  /** `Retry-After` hint from the distributed auth rate limiter. */
  retryAfterSeconds?: number;
  status: number;
}

/**
 * Typed failure from one device-authorization HTTP call.
 *
 * `code` distinguishes expiry, ownership, session, and throttling outcomes so
 * the consent page can name the recovery instead of showing plugin prose.
 * Successful plugin payloads never travel through this class.
 */
export class DeviceAuthorizationError extends Error {
  readonly code: DeviceAuthorizationErrorCode;
  readonly description: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;

  constructor({ code, description, retryAfterSeconds, status }: DeviceAuthorizationErrorDetails) {
    super(description ?? `Device authorization failed with status ${status}`);
    this.name = "DeviceAuthorizationError";
    this.code = code;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

const DEVICE_ERROR_CODES: Record<string, true> = {
  access_denied: true,
  device_code_already_processed: true,
  expired_token: true,
  invalid_grant: true,
  invalid_request: true,
  rate_limited: true,
  unauthorized: true,
};

/**
 * Normalizes a submitted code the same way the plugin does before lookup:
 * separators and whitespace are display affordances, not part of the secret.
 * The user code is not a credential, so normalizing it for manual entry and
 * URL retention is safe.
 *
 * @param value - Code typed by the member or read from the verification URL.
 * @returns Uppercase alphanumeric code.
 */
export function normalizeDeviceUserCode(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Reads `Retry-After` only when it is the delta-seconds form the API emits.
 *
 * @param response - Non-ok HTTP response.
 * @returns Whole seconds to wait, or undefined for absent/date-form headers.
 */
function retryAfterSecondsFor(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Parses both error envelopes used on this path: Better Auth's
 * `{ error, error_description }` and the Worker's
 * `{ error: { code, message } }` rate-limit body.
 *
 * @param response - Non-ok HTTP response from a device endpoint.
 * @returns Typed error carrying the status, code, and retry hint.
 */
async function deviceAuthorizationError(response: Response): Promise<DeviceAuthorizationError> {
  let errorCode: unknown;
  let description: unknown;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
      if (typeof body.error === "string") {
        errorCode = body.error;
        if ("error_description" in body) description = body.error_description;
      } else if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
        if ("code" in body.error) errorCode = body.error.code;
        if ("message" in body.error) description = body.error.message;
      }
    }
  } catch {
    // A non-JSON failure still carries the HTTP status the UI maps to recovery.
  }
  const retryAfterSeconds = retryAfterSecondsFor(response);
  return new DeviceAuthorizationError({
    code:
      typeof errorCode === "string" && Object.hasOwn(DEVICE_ERROR_CODES, errorCode)
        ? (errorCode as DeviceAuthorizationErrorCode)
        : "unknown",
    ...(typeof description === "string" && description.trim() ? { description } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    status: response.status,
  });
}

/**
 * Verifies a user code through the authenticated auth HTTP interface. The
 * plugin claims an unclaimed pending request for this browser session, which
 * is what makes later approval same-session-owned; it never approves.
 *
 * @param userCode - Normalized user-facing matching code.
 * @returns The request status and, for the owning session, client context.
 * @throws {DeviceAuthorizationError} For invalid, expired, throttled, or
 *   malformed responses.
 */
export async function verifyDeviceAuthorization(
  userCode: string,
): Promise<DeviceAuthorizationReview> {
  const query = new URLSearchParams({ user_code: userCode });
  const response = await authClient.requestDeviceAuthorization(
    "device",
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
      method: "GET",
    },
    query,
  );
  if (!response.ok) throw await deviceAuthorizationError(response);

  const body: unknown = await response.json().catch(() => null);
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "user_code" in body &&
    typeof body.user_code === "string" &&
    "status" in body &&
    (body.status === "pending" || body.status === "approved" || body.status === "denied")
  ) {
    return {
      status: body.status,
      user_code: body.user_code,
      ...("client_id" in body && typeof body.client_id === "string" && body.client_id
        ? { client_id: body.client_id }
        : {}),
      ...("scope" in body && typeof body.scope === "string" ? { scope: body.scope } : {}),
    };
  }
  throw new DeviceAuthorizationError({ code: "unknown", status: response.status });
}

/**
 * Submits one explicit consent decision for the signed-in browser session.
 *
 * @param decision - Plugin endpoint decision.
 * @param userCode - Matching code the member reviewed.
 * @throws {DeviceAuthorizationError} When the request is unauthenticated,
 *   expired, already processed, not owned by this session, or throttled.
 */
async function decideDeviceAuthorization(
  decision: "approve" | "deny",
  userCode: string,
): Promise<void> {
  const endpoint = decision === "approve" ? "device/approve" : "device/deny";
  const response = await authClient.requestDeviceAuthorization(endpoint, {
    body: JSON.stringify({ userCode }),
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await deviceAuthorizationError(response);

  const body: unknown = await response.json().catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("success" in body) ||
    body.success !== true
  ) {
    throw new DeviceAuthorizationError({ code: "unknown", status: response.status });
  }
}

/**
 * Explicitly approves the reviewed request for the CLI client.
 *
 * @param userCode - Matching code the member confirmed.
 */
export function approveDeviceAuthorization(userCode: string): Promise<void> {
  return decideDeviceAuthorization("approve", userCode);
}

/**
 * Explicitly denies the reviewed request without creating a CLI session.
 *
 * @param userCode - Matching code the member rejected.
 */
export function denyDeviceAuthorization(userCode: string): Promise<void> {
  return decideDeviceAuthorization("deny", userCode);
}
