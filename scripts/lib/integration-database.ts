/**
 * Derives a privileged integration connection from the authenticated test target.
 * Preserves its loopback host, port, database and session options; only the local
 * fixture role/password change. An explicit privileged URL may override credentials
 * but must select the same database. Missing or mismatched targets fail before I/O.
 */
export function integrationDatabaseUrl(
  authenticatedUrl: string | undefined,
  role: "admin" | "system",
  privilegedUrl?: string,
): string {
  if (!authenticatedUrl) throw new TypeError("MELTIPLY_DATABASE_TEST_URL is required");
  const url = new URL(authenticatedUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/meltiply"
  ) {
    throw new TypeError("Integration connections must target the local meltiply test database");
  }
  if (privilegedUrl) {
    const privileged = new URL(privilegedUrl);
    if (
      !["postgres:", "postgresql:"].includes(privileged.protocol) ||
      privileged.hostname !== url.hostname ||
      (privileged.port || "5432") !== (url.port || "5432") ||
      privileged.pathname !== url.pathname
    ) {
      throw new TypeError(
        "Privileged integration connections must select the authenticated test database",
      );
    }
    return privileged.href;
  }
  url.username = role === "admin" ? "postgres" : "meltiply_system";
  url.password = role === "admin" ? "meltiply-admin-local" : "meltiply-system-local";
  return url.href;
}
