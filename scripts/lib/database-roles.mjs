const requiredRoles = [
  { name: "meltiply_system", variable: "MELTIPLY_SYSTEM_DATABASE_URL", bypass: true },
  { name: "meltiply_rls", variable: "MELTIPLY_AUTHENTICATED_DATABASE_URL", bypass: false },
];

/** Creates a dedicated TLS-configured pg client from the caller's protected URL; does not connect. */
export async function createDatabaseClient(connectionString) {
  const { Client } = await import("pg");
  return new Client({
    application_name: "meltiply-release-database",
    connectionString,
    connectionTimeoutMillis: 15_000,
  });
}

/**
 * Reads both required role definitions through each protected login and verifies the actual
 * session/current identity, BYPASSRLS split, and non-superuser authenticated role. Performs
 * SELECTs only, before callers acquire locks or mutate the database. An optional connected
 * systemClient stays caller-owned; all other clients are closed, including on failure.
 * Connection/catalog failures discard driver errors so credentials never enter diagnostics.
 */
export async function assertDatabaseRoles({
  environment,
  clientFactory = createDatabaseClient,
  systemClient,
}) {
  for (const role of requiredRoles) {
    if (!environment[role.variable]?.trim()) {
      throw new Error(`${role.variable} is required for database role ${role.name}`);
    }
  }
  for (const connection of requiredRoles) {
    const owned = connection.name !== "meltiply_system" || !systemClient;
    let client;
    try {
      let result;
      try {
        client = owned ? await clientFactory(environment[connection.variable]) : systemClient;
        if (owned) await client.connect();
        result = await client.query(
          `SELECT current_user AS current_user, session_user AS session_user,
                  rolname, rolbypassrls, rolsuper
           FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`,
          [requiredRoles.map((role) => role.name)],
        );
      } catch {
        throw new Error(
          `${connection.variable}: unable to verify database role ${connection.name}; check its protected credentials and database access`,
        );
      }
      for (const expected of requiredRoles) {
        const row = result.rows?.find((candidate) => candidate.rolname === expected.name);
        if (!row) {
          throw new Error(
            `database role ${expected.name} is missing; provision it for ${expected.variable} (checked via ${connection.variable})`,
          );
        }
        if (row.rolbypassrls !== expected.bypass || (!expected.bypass && row.rolsuper !== false)) {
          throw new Error(
            `database role ${expected.name} requires ${expected.bypass ? "BYPASSRLS" : "NOBYPASSRLS and NOSUPERUSER"}; check ${expected.variable} (checked via ${connection.variable})`,
          );
        }
        if (row.current_user !== connection.name || row.session_user !== connection.name) {
          throw new Error(
            `${connection.variable} must connect as database role ${connection.name} without an assumed role`,
          );
        }
      }
    } finally {
      if (owned && client) await client.end().catch(() => {});
    }
  }
  return { status: "verified" };
}
