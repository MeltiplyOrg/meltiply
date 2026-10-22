// Recreates the dedicated benchmark database from the migrations checked out
// in this revision, then prints non-secret connection metadata.
//
// The benchmark deliberately owns a separate database from the integration
// suite so baseline and candidate revisions can each apply their own schema to
// their own database inside one GitHub-hosted job. Nothing here reads or writes
// application data outside that database.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import pg from "pg";

import { loadMigrations } from "../../release/release-migrate.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const defaultAdminUrl =
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/postgres?sslmode=disable";
const adminUrl = process.env.BENCHMARK_DATABASE_ADMIN_URL ?? defaultAdminUrl;
const databaseName = process.env.BENCHMARK_DATABASE_NAME ?? "meltiply_benchmark";

/** Rejects a database name outside the dedicated benchmark prefix. */
function assertDatabaseName(value) {
  if (!/^meltiply_bench[a-z0-9_]{0,49}$/.test(value)) {
    throw new TypeError(
      "BENCHMARK_DATABASE_NAME must start with 'meltiply_bench' and contain at most " +
        "63 lowercase PostgreSQL identifier characters",
    );
  }
}

/**
 * Rejects non-loopback administrator hosts before any connection or database
 * operation unless BENCHMARK_ALLOW_REMOTE_DATABASE is exactly "1".
 * Matches pg's last query-string host override, falling back to the decoded
 * URL hostname; an empty host cannot fall through to a remote PGHOST.
 * Error messages never include the credential-bearing connection URL.
 */
function assertAdminHost(url) {
  const host = (
    url.searchParams.getAll("host").at(-1) || decodeURIComponent(url.hostname)
  ).toLowerCase();
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) &&
    process.env.BENCHMARK_ALLOW_REMOTE_DATABASE !== "1"
  ) {
    throw new TypeError(
      "BENCHMARK_DATABASE_ADMIN_URL must target localhost, 127.0.0.1, or ::1; " +
        "set BENCHMARK_ALLOW_REMOTE_DATABASE=1 to allow a remote benchmark server",
    );
  }
}

/** Connects once, retrying while the service container is still starting. */
async function connectWhenReady(connectionString) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (cause) {
      await client.end().catch(() => {});
      if (Date.now() >= deadline) {
        throw new Error(`PostgreSQL benchmark database is unreachable: ${cause.message}`);
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
    }
  }
}

/** Applies every migration in filename order, recording checksums in the ledger. */
async function applyMigrations(admin) {
  await admin.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const { checksum, name, source } of await loadMigrations(repositoryRoot)) {
    await admin.query("BEGIN");
    try {
      await admin.query(source);
      await admin.query("INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
      await admin.query("COMMIT");
    } catch (cause) {
      await admin.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${name} failed: ${cause.message}`);
    }
  }
}

assertDatabaseName(databaseName);

const target = new URL(adminUrl);
assertAdminHost(target);
target.pathname = `/${databaseName}`;

const admin = await connectWhenReady(adminUrl);
try {
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    databaseName,
  ]);
  if (existing.rowCount > 0) {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE "${databaseName}"`);
  }
  await admin.query(`CREATE DATABASE "${databaseName}"`);

  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
        CREATE ROLE meltiply_system LOGIN PASSWORD 'meltiply-system-local' BYPASSRLS;
      ELSE
        ALTER ROLE meltiply_system LOGIN PASSWORD 'meltiply-system-local' BYPASSRLS;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
        CREATE ROLE meltiply_rls LOGIN PASSWORD 'meltiply-authenticated-local' NOBYPASSRLS;
      ELSE
        ALTER ROLE meltiply_rls LOGIN PASSWORD 'meltiply-authenticated-local' NOBYPASSRLS;
      END IF;
    END;
    $$;
  `);
} finally {
  await admin.end().catch(() => {});
}

const schema = await connectWhenReady(target.toString());
try {
  await applyMigrations(schema);
  await schema.query(`
    GRANT CONNECT ON DATABASE "${databaseName}" TO meltiply_system, meltiply_rls;
    GRANT USAGE, CREATE ON SCHEMA public TO meltiply_system;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO meltiply_system;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO meltiply_system;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO meltiply_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL PRIVILEGES ON TABLES TO meltiply_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL PRIVILEGES ON SEQUENCES TO meltiply_system;
  `);
} finally {
  await schema.end().catch(() => {});
}

// Report only non-secret connection metadata: the administrator URL may carry
// a credential that must never reach captured logs.
process.stdout.write(
  `${JSON.stringify({
    database: databaseName,
    host: target.hostname,
    port: target.port,
    schema_ready: true,
  })}\n`,
);
