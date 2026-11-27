export interface AuthenticatedClaims {
  org_id?: string;
  org_role?: string;
  sub: string;
}

const defaultStatementTimeoutMilliseconds = 10_000;

/** JSON for `request.jwt.claims`; throws `TypeError` for a blank subject and omits blank optional claims. */
export function serializeAuthenticatedClaims(claims: AuthenticatedClaims): string {
  const subject = claims.sub.trim();
  const organizationId = claims.org_id?.trim();
  const organizationRole = claims.org_role?.trim();
  if (!subject) {
    throw new TypeError("authenticated database claims require sub");
  }
  return JSON.stringify({
    ...(organizationId ? { org_id: organizationId } : {}),
    ...(organizationRole ? { org_role: organizationRole } : {}),
    sub: subject,
  });
}

export function statementTimeoutMilliseconds(requested: number | undefined): number | undefined {
  const timeout = requested ?? defaultStatementTimeoutMilliseconds;
  return Number.isSafeInteger(timeout) && timeout >= 1 ? timeout : undefined;
}
