import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { assertDatabaseRoles, createDatabaseClient } from "../lib/database-roles.mjs";
import { sha256, writeEvidence } from "./release-guard.mjs";
import { validateDatabaseEnvironment } from "./release-lib.mjs";
import { requireRestorePoint } from "./release-restore.mjs";

const lineBreakPattern = /\r?\n/;

const migrationNamePattern = /^(\d{3})_[a-z0-9_]+\.sql$/;
const checksumPattern = /^[0-9a-f]{64}$/;
const expandMarker = "-- meltiply-release-phase: expand";
const ledgerLockName = "meltiply-release-schema-migrations-v1";
const maximumMigrationBytes = 2 * 1024 * 1024;

function exactPhase(phase, spec) {
  const expected = spec.deployment_mode === "bootstrap" ? "bootstrap" : "expand";
  if (phase !== expected) {
    throw new TypeError(
      `migration phase must be ${expected} for deployment_mode ${spec.deployment_mode}`,
    );
  }
  return phase;
}

function validateMigrationSequence(migrations) {
  if (migrations.length === 0) throw new TypeError("no database migrations found");
  migrations.forEach((migration, index) => {
    const match = migrationNamePattern.exec(migration.name);
    if (!match || Number(match[1]) !== index + 1) {
      throw new TypeError(`database migration sequence is invalid at ${migration.name}`);
    }
    if (!checksumPattern.test(migration.checksum)) {
      throw new TypeError(`database migration checksum is invalid: ${migration.name}`);
    }
  });
}

export async function loadMigrations(repoRoot) {
  const migrationDir = path.join(repoRoot, "packages", "database", "migrations");
  const entries = await readdir(migrationDir, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.name.endsWith(".sql"));
  if (sqlEntries.some((entry) => !entry.isFile())) {
    throw new TypeError("database migration directory contains a non-file SQL entry");
  }
  const migrations = await Promise.all(
    sqlEntries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const source = await readFile(path.join(migrationDir, entry.name), "utf8");
        const size = Buffer.byteLength(source);
        if (size === 0 || size > maximumMigrationBytes) {
          throw new TypeError(
            `database migration must be non-empty and at most ${maximumMigrationBytes} bytes: ${entry.name}`,
          );
        }
        return { checksum: sha256(source), name: entry.name, source };
      }),
  );
  validateMigrationSequence(migrations);
  return migrations;
}

function ledgerRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("migration ledger must be an array");
  return rows.map((row, index) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !migrationNamePattern.test(row.name) ||
      !checksumPattern.test(row.checksum)
    ) {
      throw new TypeError(`migration ledger row ${index + 1} is invalid`);
    }
    return { checksum: row.checksum, name: row.name };
  });
}

export function planMigrations({ appliedRows, migrations, phase, spec }) {
  exactPhase(phase, spec);
  validateMigrationSequence(migrations);
  const applied = ledgerRows(appliedRows);
  if (new Set(applied.map((row) => row.name)).size !== applied.length) {
    throw new TypeError("migration ledger contains duplicate names");
  }
  if (applied.length > migrations.length) {
    throw new TypeError("migration ledger is ahead of the reviewed checkout");
  }
  for (let index = 0; index < applied.length; index += 1) {
    const recorded = applied[index];
    const reviewed = migrations[index];
    if (recorded.name !== reviewed.name) {
      throw new TypeError(`migration ledger is non-contiguous at ${recorded.name}`);
    }
    if (recorded.checksum !== reviewed.checksum) {
      throw new TypeError(`migration checksum drift: ${recorded.name}`);
    }
  }
  const pending = migrations.slice(applied.length);
  if (phase === "expand") {
    const incompatible = pending.find(
      (migration) => migration.source.split(lineBreakPattern, 1)[0] !== expandMarker,
    );
    if (incompatible) {
      throw new TypeError(
        `pending update migration is not marked expand-only: ${incompatible.name}`,
      );
    }
  }
  return { alreadyApplied: applied, pending };
}

async function transaction(client, operation) {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function assertRlsInstallation(client) {
  const result = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'auth') AS auth_schema,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'jwt' AND p.pronargs = 0
          AND p.prorettype = 'jsonb'::regtype AND p.prokind = 'f'
      ) AS claims_accessor,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_roles r ON r.oid = ANY(p.polroles)
        WHERE n.nspname = 'public' AND c.relrowsecurity AND r.rolname = 'meltiply_rls'
      ) AS policies
  `);
  const installed = result.rows?.[0];
  for (const [key, description] of [
    ["auth_schema", "authentication schema auth"],
    ["claims_accessor", "claims accessor auth.jwt()"],
    ["policies", "enabled row-level-security policies for meltiply_rls"],
  ]) {
    if (installed?.[key] !== true) {
      throw new Error(
        `migration verification failed: missing ${description}; do not reuse a branch with skipped RLS migrations`,
      );
    }
  }
}

export async function migrateDatabase({
  approvals,
  clientFactory = createDatabaseClient,
  environment,
  now,
  outDir,
  phase,
  planDigest,
  repoRoot,
  spec,
}) {
  exactPhase(phase, spec);
  const restorePoint = await requireRestorePoint({
    approvals,
    environment,
    now,
    outDir,
    planDigest,
    spec,
  });
  const migrations = await loadMigrations(repoRoot);
  const systemUrl = validateDatabaseEnvironment(environment);
  let client;
  let locked = false;
  try {
    try {
      client = await clientFactory(systemUrl);
      await client.connect();
    } catch {
      throw new Error(
        "MELTIPLY_SYSTEM_DATABASE_URL: unable to connect as database role meltiply_system; check its protected credentials and database access",
      );
    }
    await assertDatabaseRoles({ clientFactory, environment, systemClient: client });
    await client.query("SET statement_timeout = '15min'");
    await client.query("SET lock_timeout = '30s'");
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [ledgerLockName],
    );
    if (lock.rows?.length !== 1 || lock.rows[0].acquired !== true) {
      throw new Error("another release migrator holds the database lock");
    }
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ledger = await client.query(
      "SELECT name, checksum FROM public.schema_migrations ORDER BY name",
    );
    const plan = planMigrations({
      appliedRows: ledger.rows,
      migrations,
      phase,
      spec,
    });
    const applied = [];
    for (const migration of plan.pending) {
      await transaction(client, async () => {
        await client.query(migration.source);
        await client.query(
          "INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
      });
      applied.push({ checksum: migration.checksum, name: migration.name });
    }
    const finalLedger = await client.query(
      "SELECT name, checksum FROM public.schema_migrations ORDER BY name",
    );
    const parity = planMigrations({
      appliedRows: finalLedger.rows,
      migrations,
      phase,
      spec,
    });
    if (parity.pending.length !== 0) {
      throw new Error("migration ledger does not match the reviewed migration set");
    }
    await assertRlsInstallation(client);
    const evidence = {
      already_applied: plan.alreadyApplied,
      applied,
      approvals,
      git_sha: spec.git_sha,
      migration_set_digest: sha256(
        migrations.map((migration) => `${migration.name}\0${migration.checksum}`).join("\n"),
      ),
      restore_point: {
        expires_at: restorePoint.expires_at,
        snapshot_digest: restorePoint.snapshot_digest,
        snapshot_id: restorePoint.snapshot_id,
      },
      phase,
      plan_digest: planDigest,
      release_id: spec.release_id,
      schema_version: 1,
      status: "applied",
    };
    await writeEvidence(outDir, "migration-evidence.json", evidence);
    return evidence;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ledgerLockName]);
      } catch {
        // PostgreSQL releases session advisory locks when the session closes.
      }
    }
    if (client) await client.end().catch(() => {});
  }
}
