import { captureAuthJwt, clearAuthJwt } from "./auth-token";
import { getApiBaseUrl } from "./env";

export interface AuthUser {
  email: string;
  emailVerified?: boolean;
  id: string;
  image?: string | null;
  name?: string | null;
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

interface SignInCredentials {
  email: string;
  password: string;
}

interface SignUpCredentials extends SignInCredentials {
  name: string;
}

/**
 * Normalizes an error response from the Better Auth API into an Error with a readable message.
 *
 * @param response Non-ok fetch Response.
 * @returns An Error instance describing the failure.
 */
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

/**
 * Retrieves the current user session from Better Auth via the session cookie.
 * Calls `GET /api/auth/get-session` with credentials included — the only
 * transport where the HttpOnly session cookie is sent — and captures the
 * `set-auth-jwt` response header, which the JWT plugin emits only on this
 * endpoint, as the in-memory bearer credential used for `/api/v1` requests.
 * A definitive empty session drops the held JWT so no stale credential is
 * forwarded; transport or server failures leave it untouched because the
 * session may still be valid.
 *
 * @returns The active session result, or null if unauthenticated or expired.
 */
async function getSession(): Promise<AuthSessionResult | null> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/get-session`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
    method: "GET",
  });

  if (!response.ok) {
    return null;
  }

  captureAuthJwt(response);
  const data = (await response.json()) as AuthSessionResult | null;
  if (!data?.session || !data.user) {
    clearAuthJwt();
    return null;
  }
  return data;
}

/**
 * Authenticates a user using email and password via Better Auth.
 * Issues `POST /api/auth/sign-in/email`, which establishes the internal
 * `/api/auth` session through the HttpOnly cookie on success. The JWT plugin
 * emits `set-auth-jwt` only on get-session, so the bearer credential is
 * minted by the auth provider's `getSession` call after sign-in navigation.
 *
 * @param credentials User email and password.
 * @returns The authenticated session and user details.
 * @throws {Error} When authentication fails or credentials are invalid.
 */
async function signInEmail(credentials: SignInCredentials): Promise<AuthSessionResult> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    body: JSON.stringify(credentials),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw await parseAuthError(response);
  }

  return (await response.json()) as AuthSessionResult;
}

/**
 * Registers a new creator account using name, email, and password via Better Auth.
 * Issues `POST /api/auth/sign-up/email`, which creates the user and
 * establishes the internal `/api/auth` session through the HttpOnly cookie
 * on success. The JWT plugin emits `set-auth-jwt` only on get-session, so
 * the bearer credential is minted by the auth provider's `getSession` call
 * after sign-up navigation.
 *
 * @param credentials New user registration details.
 * @returns The created user and initial session details.
 * @throws {Error} When registration fails or inputs are rejected.
 */
async function signUpEmail(credentials: SignUpCredentials): Promise<AuthSessionResult> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    body: JSON.stringify(credentials),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw await parseAuthError(response);
  }

  return (await response.json()) as AuthSessionResult;
}

/**
 * Revokes the active session and clears the authentication cookie.
 * Issues `POST /api/auth/sign-out` to terminate the session server-side, then
 * always drops the in-memory bearer JWT — even when the request fails or
 * rejects — so no stale credential is forwarded to `/api/v1` afterwards.
 */
async function signOut(): Promise<void> {
  const baseUrl = getApiBaseUrl();
  try {
    await fetch(`${baseUrl}/api/auth/sign-out`, {
      body: JSON.stringify({}),
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } finally {
    clearAuthJwt();
  }
}

/**
 * Requests a password reset email via Better Auth.
 * Issues `POST /api/auth/forget-password`; the JWT plugin emits
 * `set-auth-jwt` only on get-session, so no bearer credential is captured
 * here.
 *
 * @param params User email address.
 */
async function forgetPassword(params: { email: string }): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/forget-password`, {
    body: JSON.stringify(params),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await parseAuthError(response);
  }
}

/**
 * Resets user password using a verified recovery token.
 * Issues `POST /api/auth/reset-password`; the JWT plugin emits
 * `set-auth-jwt` only on get-session, so no bearer credential is captured
 * here.
 *
 * @param params New password and recovery token.
 */
async function resetPassword(params: { newPassword: string; token: string }): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/reset-password`, {
    body: JSON.stringify(params),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await parseAuthError(response);
  }
}

/**
 * Verifies email address using an email verification token.
 * Issues `POST /api/auth/verify-email`; the JWT plugin emits `set-auth-jwt`
 * only on get-session, so no bearer credential is captured here.
 *
 * @param params Verification token.
 */
async function verifyEmail(params: { token: string }): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/verify-email`, {
    body: JSON.stringify(params),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await parseAuthError(response);
  }
}

/**
 * Changes user password within an authenticated session.
 * Issues `POST /api/auth/change-password`; the JWT plugin emits
 * `set-auth-jwt` only on get-session, so no bearer credential is captured
 * here.
 *
 * @param params Current password and new password.
 */
async function changePassword(params: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/api/auth/change-password`, {
    body: JSON.stringify(params),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw await parseAuthError(response);
  }
}

export const authClient = {
  changePassword,
  forgetPassword,
  getSession,
  resetPassword,
  signInEmail,
  signOut,
  signUpEmail,
  verifyEmail,
};
