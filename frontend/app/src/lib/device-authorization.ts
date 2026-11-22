import { authClient } from "./auth-client";

const nonAlphanumericPattern = /[^a-zA-Z0-9]/g;
const integerPattern = /^\d+$/;

type DeviceAuthorizationStatus = "approved" | "denied" | "pending";

export interface DeviceAuthorizationReview {
  client_id?: string;
  scope?: string;
  status: DeviceAuthorizationStatus;
  user_code: string;
}

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
  description?: string;
  retryAfterSeconds?: number;
  status: number;
}

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

export function normalizeDeviceUserCode(value: string): string {
  return value.replace(nonAlphanumericPattern, "").toUpperCase();
}

function retryAfterSecondsFor(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value || !integerPattern.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

async function deviceAuthorizationError(response: Response): Promise<DeviceAuthorizationError> {
  let errorCode: unknown;
  let description: unknown;
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
    if (typeof body.error === "string") {
      errorCode = body.error;
      if ("error_description" in body) description = body.error_description;
    } else if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
      if ("code" in body.error) errorCode = body.error.code;
      if ("message" in body.error) description = body.error.message;
    }
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

export function approveDeviceAuthorization(userCode: string): Promise<void> {
  return decideDeviceAuthorization("approve", userCode);
}

export function denyDeviceAuthorization(userCode: string): Promise<void> {
  return decideDeviceAuthorization("deny", userCode);
}
