const authJwtHeader = "set-auth-jwt";

let bearerJwt: string | undefined;

export function captureAuthJwt(response: Response): void {
  const jwt = response.headers.get(authJwtHeader)?.trim();
  if (jwt) {
    bearerJwt = jwt;
  }
}

export function clearAuthJwt(): void {
  bearerJwt = undefined;
}

export function applyAuthJwt(headers: Headers): void {
  if (bearerJwt) {
    headers.set("Authorization", `Bearer ${bearerJwt}`);
  }
}
