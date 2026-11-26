export const LOCAL_TEST_URL =
  "postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply?sslmode=disable";
export const LOCAL_SYSTEM_URL =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
export const LOCAL_ADMIN_URL =
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";

const LOCAL_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function assertLocalTestDatabaseUrl(
  urlString: string | undefined,
  label = "MELTIPLY_DATABASE_TEST_URL",
): URL {
  if (!urlString) throw new TypeError(`${label} is required`);
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new TypeError(`${label} is not a valid URL`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !LOCAL_LOOPBACK_HOSTS.has(url.hostname) ||
    url.pathname !== "/meltiply"
  ) {
    throw new TypeError(
      `${label}: integration connections must target the local meltiply test database on loopback`,
    );
  }
  return url;
}

export function integrationDatabaseUrl(
  authenticatedUrl: string | undefined,
  role: "admin" | "system",
  privilegedUrl?: string,
): string {
  const url = assertLocalTestDatabaseUrl(authenticatedUrl, "MELTIPLY_DATABASE_TEST_URL");
  if (privilegedUrl) {
    const privileged = assertLocalTestDatabaseUrl(
      privilegedUrl,
      "Privileged integration database URL",
    );
    if (
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
