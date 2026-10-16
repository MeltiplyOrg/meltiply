/**
 * Module-local holder for the short-lived Better Auth bearer JWT.
 *
 * The JWT plugin mints an access token on the `/api/auth/get-session`
 * response and delivers it through the `set-auth-jwt` response header. The
 * token is kept in module state only — never in Web Storage or cookies — so
 * it cannot persist across reloads or be read by injected scripts. No getter
 * is exported: the credential is observable solely as the `Authorization`
 * header that `applyAuthJwt` stamps onto outgoing `/api/v1` requests.
 */

const authJwtHeader = "set-auth-jwt";

let bearerJwt: string | undefined;

/**
 * Captures the `set-auth-jwt` response header from the Better Auth
 * get-session response, replacing the held bearer credential. Called by the
 * auth client only on `/api/auth/get-session` — the sole endpoint where the
 * JWT plugin emits the header — so session resolution and refreshes converge
 * on the newest minted JWT. Missing or blank headers leave the current
 * credential untouched.
 *
 * @param response Fetch response from `/api/auth/get-session`.
 */
export function captureAuthJwt(response: Response): void {
  const jwt = response.headers.get(authJwtHeader)?.trim();
  if (jwt) {
    bearerJwt = jwt;
  }
}

/**
 * Drops the held bearer credential. Called when sign-out completes — whether
 * the server acknowledged it or not — and whenever the session is known to be
 * gone, so no stale JWT is ever forwarded to `/api/v1`.
 */
export function clearAuthJwt(): void {
  bearerJwt = undefined;
}

/**
 * Stamps `Authorization: Bearer <jwt>` onto an outgoing request's headers when
 * a credential is held; a no-op otherwise. This is the only read path for the
 * token, keeping the raw value unreachable from application code.
 *
 * @param headers Mutable request headers being assembled for a `/api/v1` call.
 */
export function applyAuthJwt(headers: Headers): void {
  if (bearerJwt) {
    headers.set("Authorization", `Bearer ${bearerJwt}`);
  }
}
