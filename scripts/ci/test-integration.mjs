import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadMigrations } from "../release/release-migrate.mjs";
import {
  assertLocalTestDatabaseUrl,
  integrationDatabaseUrl,
  LOCAL_TEST_URL,
} from "../lib/integration-database.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const postgresDir = join(repositoryRoot, "scripts/cloudflare-local/postgres");

const testUrl = process.env.MELTIPLY_DATABASE_TEST_URL ?? LOCAL_TEST_URL;
const adminUrl = integrationDatabaseUrl(
  testUrl,
  "admin",
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL,
);

const positiveOffsetTimeZone = "Asia/Bangkok";
const suiteFilters = ["@meltiply/database", "@meltiply/api-worker", "@meltiply/automation-worker"];

function fail(message) {
  console.error(`test:integration: ${message}`);
  process.exit(1);
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertLocalTestDatabase(urlString, label) {
  try {
    assertLocalTestDatabaseUrl(urlString, label);
  } catch (cause) {
    fail(
      `Safety guard: ${errorMessage(cause)}. Resetting non-local or ambiguous databases is forbidden.`,
    );
  }
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function connectWhenReady(connectionString) {
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

    await admin.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      DROP SCHEMA IF EXISTS auth CASCADE;
    `);

    await admin.query(await readFile(join(postgresDir, "local-roles.sql"), "utf8"));
    await applyMigrations(admin);
    await admin.query(await readFile(join(postgresDir, "grants.sql"), "utf8"));
    await admin.query("GRANT CREATE ON SCHEMA public TO meltiply_system");
    await admin.query(await readFile(join(postgresDir, "seed.sql"), "utf8"));
  } finally {
    await admin.end().catch(() => {});
  }
}

function runSuites() {
  for (const filter of suiteFilters) {
    console.log(`running ${filter} integration suite`);
    const result = spawnSync("bun", ["run", "--filter", filter, "test:integration"], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        TZ: positiveOffsetTimeZone,
        MELTIPLY_DATABASE_TEST_URL: testUrl,
        MELTIPLY_DATABASE_TEST_ADMIN_URL: adminUrl,
      },
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
