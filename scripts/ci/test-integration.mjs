// PostgreSQL-backed integration gate.
//
// Prepares the containerized test database (safely resets the dedicated test
// schema, creates roles, applies checked-in migrations, and seeds deterministic
// fixtures) and then runs the @meltiply/database tenant-isolation suite plus
// the API and Automation Worker integration suites serially. A reachable
// PostgreSQL is a hard prerequisite: an unavailable database fails the gate
// instead of skipping the suites.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadMigrations } from "../release/release-migrate.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const seedSqlPath = join(repositoryRoot, "scripts/cloudflare-local/postgres/seed.sql");

// Defaults match the PostgreSQL service provisioned by `bun run db:start`
// (docker-compose.cloudflare.yml plus scripts/cloudflare-local/postgres);
// the optional observability profile is not needed for integration tests.
const defaultTestUrl =
  "postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply?sslmode=disable";
const defaultAdminUrl =
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";

const testUrl = process.env.MELTIPLY_DATABASE_TEST_URL ?? defaultTestUrl;
const adminUrl = process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ?? defaultAdminUrl;

// Serial order matches package.json's historical suite list: tenant isolation
// first, then each Worker's integration suite.
const suiteFilters = ["@meltiply/database", "@meltiply/api-worker", "@meltiply/automation-worker"];

/**
 * Logs an error message prefixed with 'test:integration' and terminates the process with exit code 1.
 *
 * @param {string} message - Error description
 * @returns {never}
 */
function fail(message) {
  console.error(`test:integration: ${message}`);
  process.exit(1);
}

/**
 * Extracts a readable error message from an Error instance or converts a thrown value to string.
 *
 * @param {unknown} cause - Thrown error or object
 * @returns {string} Normalized error message
 */
function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Validates that a database URL points strictly to loopback (127.0.0.1 or localhost) and the dedicated 'meltiply' database.
 * Safety guard to prevent resetting staging, production, or non-test databases.
 *
 * @param {string} urlString - PostgreSQL connection string to inspect
 * @param {string} label - Environment variable or config name for error reporting
 * @throws {Error} If URL is not valid, not on loopback, or targets a database other than 'meltiply'
 */
function assertLocalTestDatabase(urlString, label) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    fail(`${label} is not a valid URL: ${urlString}`);
  }
  const isLocalHost =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  const dbName = parsed.pathname.replace(/^\//, "");
  const isDedicatedTestDb = dbName === "meltiply";
  if (!isLocalHost || !isDedicatedTestDb) {
    fail(
      `Safety guard: ${label} must target the local dedicated test database ` +
        `'meltiply' on loopback (127.0.0.1 or localhost), got host '${parsed.hostname}' ` +
        `and database '${dbName}'. Resetting non-local or ambiguous databases is forbidden.`,
    );
  }
}

/**
 * Asynchronously pauses execution for a specified number of milliseconds.
 *
 * @param {number} milliseconds - Delay duration in milliseconds
 * @returns {Promise<void>}
 */
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

/**
 * Attempts to connect to PostgreSQL, retrying every second up to a 45-second deadline.
 * Handles cold database startup; on exhaustion fails closed with the Bun database-start command.
 *
 * @param {string} connectionString - PostgreSQL connection URI
 * @returns {Promise<import("pg").Client>} Connected pg Client instance
 * @throws {Error} If connection cannot be established before deadline
 */
async function connectWhenReady(connectionString) {
  // The containerized database may still be starting (cold volume, CI service
  // container); once the window elapses the gate fails closed.
  const deadlineMs = 45_000;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (cause) {
      await client.end().catch(() => {});
      if (Date.now() >= deadline) {
        fail(
          `PostgreSQL test database is unreachable (${errorMessage(cause)}). ` +
            "Start the containerized database with `bun run db:start`; " +
            "integration suites are never skipped when it is absent.",
        );
      }
      await sleep(1_000);
    }
  }
}

/**
 * Applies checked-in migrations in order, validating existing checksums against public.schema_migrations.
 *
 * @param {import("pg").Client} admin - Connected PostgreSQL admin client
 * @returns {Promise<void>}
 * @throws {Error} If migration checksum drift is detected or migration execution fails
 */
async function applyMigrations(admin) {
  await admin.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const ledger = await admin.query("SELECT name, checksum FROM public.schema_migrations");
  const applied = new Map(ledger.rows.map((row) => [row.name, row.checksum]));
  const migrations = await loadMigrations(repositoryRoot);

  for (const { checksum, name, source } of migrations) {
    const recorded = applied.get(name);
    if (recorded !== undefined) {
      if (recorded !== checksum) {
        fail(`migration checksum drift: ${name}`);
      }
      continue;
    }
    console.log(`applying migration ${name}`);
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
      fail(`migration ${name} failed: ${errorMessage(cause)}`);
    }
  }
}

/**
 * Resets schemas, configures database roles, applies migrations, and seeds deterministic fixtures.
 * Establishes an idempotent, isolated environment on the local test PostgreSQL container (port 5433).
 *
 * @returns {Promise<void>}
 * @throws {Error} If connected database is not 'meltiply', role creation fails, or seed execution errors
 */
async function prepareTestDatabase() {
  assertLocalTestDatabase(adminUrl, "MELTIPLY_DATABASE_TEST_ADMIN_URL");
  assertLocalTestDatabase(testUrl, "MELTIPLY_DATABASE_TEST_URL");

  const admin = await connectWhenReady(adminUrl);
  try {
    const dbResult = await admin.query("SELECT current_database() AS db");
    const currentDb = dbResult.rows[0]?.db;
    if (currentDb !== "meltiply") {
      fail(
        `Safety guard: connected database is '${currentDb}', expected 'meltiply'. ` +
          "Refusing to reset an unexpected database.",
      );
    }

    // Safely reset the dedicated test schema to guarantee full-suite determinism
    // on a reused local containerized database without leftover rows from prior runs.
    await admin.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      DROP SCHEMA IF EXISTS auth CASCADE;
    `);

    // Same roles and grants as scripts/cloudflare-local/postgres/migrate.sh.
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
          CREATE ROLE meltiply_system
            LOGIN
            PASSWORD 'meltiply-system-local'
            BYPASSRLS;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
          CREATE ROLE meltiply_rls
            LOGIN
            PASSWORD 'meltiply-authenticated-local'
            NOBYPASSRLS;
        END IF;
      END;
      $$;
    `);
    await applyMigrations(admin);
    await admin.query(`
      GRANT CONNECT ON DATABASE meltiply TO meltiply_system, meltiply_rls;
      GRANT USAGE, CREATE ON SCHEMA public TO meltiply_system;
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO meltiply_system;
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO meltiply_system;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO meltiply_system;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL PRIVILEGES ON TABLES TO meltiply_system;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL PRIVILEGES ON SEQUENCES TO meltiply_system;
      ALTER ROLE meltiply_rls NOBYPASSRLS;
    `);
    // Idempotent deterministic fixtures shared with the local stack seed.
    await admin.query(await readFile(seedSqlPath, "utf8"));
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Runs the existing Node/Vitest integration suites serially through Bun workspace filtering.
 * Exits with the first failing suite's exit code.
 *
 * @returns {void}
 */
function runSuites() {
  for (const filter of suiteFilters) {
    console.log(`running ${filter} integration suite`);
    const result = spawnSync("bun", ["run", "--filter", filter, "test:integration"], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: { ...process.env, MELTIPLY_DATABASE_TEST_URL: testUrl },
    });
    if (result.error) {
      fail(`could not run ${filter} integration suite: ${result.error}`);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

try {
  await prepareTestDatabase();
} catch (cause) {
  fail(`failed to prepare the PostgreSQL test database: ${errorMessage(cause)}`);
}
runSuites();
