import { captureAuthJwt, clearAuthJwt } from "./auth-token";
import { getApiBaseUrl } from "./env";

export interface AuthUser {
  email: string;
  emailVerified?: boolean;
  id: string;
  image?: string | null;
  name?: string | null;
  twoFactorEnabled?: boolean;
}

interface AuthSession {
  expiresAt: string | Date;
  id: string;
  token?: string;
  userId: string;
}

interface AuthSessionResult {
  session: AuthSession;
  user: AuthUser;
}

interface AuthTokenResult {
  token?: string | null;
  user?: AuthUser;
  twoFactorRedirect?: boolean;
}

interface SignInCredentials {
  email: string;
  password: string;
}

interface SignUpCredentials extends SignInCredentials {
  name: string;
  setupSecret?: string;
  invitationToken?: string;
  workspaceName?: string;
}

async function parseAuthError(response: Response): Promise<Error> {
  try {
    const data = (await response.json()) as { message?: string; error?: { message?: string } };
    const message =
      data.message ||
      data.error?.message ||
      `Authentication request failed with status ${response.status}`;
    return new Error(message);
  } catch {
    return new Error(`Authentication request failed with status ${response.status}`);
  }
}

function authFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${getApiBaseUrl()}/api/auth/${path}`, { ...init, credentials: "include" });
}

function postAuthJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return authFetch(path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) throw await parseAuthError(response);
  return response;
}

async function getSession(): Promise<AuthSessionResult | null> {
  const response = await requireOk(
    await authFetch("get-session", { headers: { Accept: "application/json" }, method: "GET" }),
  );
  captureAuthJwt(response);
  const data = (await response.json()) as AuthSessionResult | null;
  if (!data?.session || !data.user) {
    clearAuthJwt();
    return null;
  }
  return data;
}

function requestDeviceAuthorization(
  endpoint: "device" | "device/approve" | "device/code" | "device/deny",
  init: RequestInit,
  query?: URLSearchParams,
): Promise<Response> {
  const search = query?.toString();
  return authFetch(`${endpoint}${search ? `?${search}` : ""}`, init);
}

async function signInEmail(credentials: SignInCredentials): Promise<AuthTokenResult> {
  const response = await requireOk(await postAuthJson("sign-in/email", credentials));
  return (await response.json()) as AuthTokenResult;
}

async function signUpEmail({
  setupSecret,
  invitationToken,
  workspaceName,
  ...credentials
}: SignUpCredentials): Promise<AuthTokenResult> {
  const callbackURL = invitationToken
    ? `${window.location.origin}/invitations/accept?token=${encodeURIComponent(invitationToken)}`
    : `${window.location.origin}/sign-in?verified=1`;
  const response = await requireOk(
    await postAuthJson(
      "sign-up/email",
      {
        ...credentials,
        callbackURL,
        ...(workspaceName ? { workspace_name: workspaceName } : {}),
      },
      {
        ...(setupSecret ? { "X-Setup-Secret": setupSecret } : {}),
        ...(invitationToken ? { "X-Invitation-Token": invitationToken } : {}),
      },
    ),
  );
  return (await response.json()) as AuthTokenResult;
}

async function signOut(): Promise<void> {
  try {
    await postAuthJson("sign-out", {});
  } finally {
    clearAuthJwt();
  }
}

async function requestPasswordReset(params: { email: string }): Promise<void> {
  await requireOk(
    await postAuthJson("request-password-reset", {
      ...params,
      redirectTo: `${window.location.origin}/sign-in?recovery=1`,
    }),
  );
}

async function resetPassword(params: { newPassword: string; token: string }): Promise<void> {
  await requireOk(await postAuthJson("reset-password", params));
}

async function verifyEmail(params: { token: string }): Promise<void> {
  await requireOk(
    await authFetch(`verify-email?${new URLSearchParams(params)}`, { method: "GET" }),
  );
}

async function changePassword(params: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await requireOk(await postAuthJson("change-password", { ...params, revokeOtherSessions: true }));
}

async function setupStatus(): Promise<{ initialized: boolean }> {
  const response = await requireOk(await authFetch("setup-status", { cache: "no-store" }));
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("initialized" in data) ||
    typeof data.initialized !== "boolean"
  ) {
    throw new Error("Invalid installation status. Try again.");
  }
  return { initialized: data.initialized };
}

async function resendVerification(email: string): Promise<void> {
  await requireOk(
    await postAuthJson("send-verification-email", {
      email,
      callbackURL: `${window.location.origin}/sign-in?verified=1`,
    }),
  );
}

async function verifySecondFactor(code: string, backup = false): Promise<void> {
  const path = backup ? "verify-backup-code" : "verify-totp";
  await requireOk(await postAuthJson(`two-factor/${path}`, { code, trustDevice: false }));
}

async function manageTwoFactor(
  action: "enable" | "disable" | "generate-backup-codes",
  password: string,
): Promise<{ totpURI?: string; backupCodes?: string[] }> {
  const response = await requireOk(await postAuthJson(`two-factor/${action}`, { password }));
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid security response.");
  const result: { totpURI?: string; backupCodes?: string[] } = {};
  if ("totpURI" in data && typeof data.totpURI === "string") {
    const uri = new URL(data.totpURI);
    if (uri.protocol !== "otpauth:" || uri.hostname !== "totp" || !uri.searchParams.get("secret")) {
      throw new Error("Invalid authenticator enrollment.");
    }
    result.totpURI = uri.href;
  }
  if (
    "backupCodes" in data &&
    Array.isArray(data.backupCodes) &&
    data.backupCodes.length > 0 &&
    data.backupCodes.every((code: unknown): code is string => typeof code === "string")
  )
    result.backupCodes = data.backupCodes;
  if (action !== "disable" && (!result.backupCodes || (action === "enable" && !result.totpURI))) {
    throw new Error("Incomplete authenticator enrollment.");
  }
  return result;
}

export const authClient = {
  requestDeviceAuthorization,
  changePassword,
  requestPasswordReset,
  getSession,
  resetPassword,
  signInEmail,
  signOut,
  signUpEmail,
  verifyEmail,
  setupStatus,
  resendVerification,
  verifySecondFactor,
  manageTwoFactor,
};
