import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadMigrations, migrateDatabase, planMigrations } from "./release-migrate.mjs";
import { sha256 } from "./release-guard.mjs";

function migration(number, source = "SELECT 1;\n") {
  const name = `${String(number).padStart(3, "0")}_migration.sql`;
  return { checksum: sha256(source), name, source };
}

const bootstrapSpec = {
  deployment_mode: "bootstrap",
  git_sha: "a".repeat(40),
  neon_branch_id: "branch-staging-123",
  neon_project_id: "project-staging-123",
  release_id: "staging-20260722-a1b2c3d4",
  restore_point_expires_at: "2026-08-05T12:00:00.000Z",
};

async function writeRestorePoint(outDir, spec, planDigest = "b".repeat(64)) {
  await mkdir(outDir, { recursive: true });
  const createdAt = "2026-07-22T12:00:00.000Z";
  const snapshotId = "snapshot-release-123";
  const snapshotName = `meltiply-${spec.release_id}`;
  await writeFile(
    path.join(outDir, "restore-point-evidence.json"),
    JSON.stringify({
      approvals: [],
      created_at: createdAt,
      endpoint_host_digest: sha256("ep-staging.us-east-2.aws.neon.tech"),
      endpoint_id: "ep-staging-123",
      expires_at: spec.restore_point_expires_at,
      git_sha: spec.git_sha,
      plan_digest: planDigest,
      project_id: spec.neon_project_id,
      provider: "neon",
      release_id: spec.release_id,
      schema_version: 1,
      snapshot_digest: sha256(
        [
          snapshotId,
          snapshotName,
          spec.neon_branch_id,
          createdAt,
          spec.restore_point_expires_at,
        ].join("\0"),
      ),
      snapshot_id: snapshotId,
      snapshot_name: snapshotName,
      source_branch_id: spec.neon_branch_id,
      status: "ready",
    }),
  );
}

test("migration planning rejects checksum drift and non-contiguous ledgers", () => {
  const migrations = [migration(1), migration(2)];
  assert.throws(
    () =>
      planMigrations({
        appliedRows: [{ checksum: "f".repeat(64), name: migrations[0].name }],
        migrations,
        phase: "bootstrap",
        spec: bootstrapSpec,
      }),
    /checksum drift/,
  );
  assert.throws(
    () =>
      planMigrations({
        appliedRows: [{ checksum: migrations[1].checksum, name: migrations[1].name }],
        migrations,
        phase: "bootstrap",
        spec: bootstrapSpec,
      }),
    /non-contiguous/,
  );
});

test("update releases accept only pending expand-marked migrations", () => {
  const initial = migration(1);
  const marked = migration(
    2,
    "-- meltiply-release-phase: expand\nALTER TABLE example ADD COLUMN value text;\n",
  );
  const updateSpec = { ...bootstrapSpec, deployment_mode: "update" };
  assert.deepEqual(
    planMigrations({
      appliedRows: [{ checksum: initial.checksum, name: initial.name }],
      migrations: [initial, marked],
      phase: "expand",
      spec: updateSpec,
    }).pending,
    [marked],
  );
  assert.throws(
    () =>
      planMigrations({
        appliedRows: [],
        migrations: [initial],
        phase: "expand",
        spec: updateSpec,
      }),
    /not marked expand-only/,
  );
  assert.throws(
    () =>
      planMigrations({
        appliedRows: [],
        migrations: [initial],
        phase: "bootstrap",
        spec: updateSpec,
      }),
    /must be expand/,
  );
});

test("migration loading enforces a complete numbered SQL sequence", async (context) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "release-migrations-"));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  const directory = path.join(repoRoot, "packages", "database", "migrations");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001_first.sql"), "SELECT 1;\n");
  await writeFile(path.join(directory, "002_second.sql"), "SELECT 2;\n");
  assert.deepEqual(
    (await loadMigrations(repoRoot)).map((item) => item.name),
    ["001_first.sql", "002_second.sql"],
  );
  await rm(path.join(directory, "002_second.sql"));
  await writeFile(path.join(directory, "003_third.sql"), "SELECT 3;\n");
  await assert.rejects(loadMigrations(repoRoot), /sequence is invalid/);
});

test("migrator holds one advisory lock and records each migration transactionally", async (context) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "release-migrator-"));
  const outDir = path.join(repoRoot, ".release");
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  const directory = path.join(repoRoot, "packages", "database", "migrations");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001_first.sql"), "SELECT 1;\n");
  await writeFile(path.join(directory, "002_second.sql"), "SELECT 2;\n");
  await writeRestorePoint(outDir, bootstrapSpec);
  const calls = [];
  const appliedRows = [];
  let ended = false;
  const client = {
    connect: async () => calls.push(["connect"]),
    end: async () => {
      ended = true;
    },
    query: async (text, values) => {
      calls.push([text, values]);
      if (text.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (text.startsWith("SELECT name, checksum")) {
        return { rows: [...appliedRows] };
      }
      if (text.startsWith("INSERT INTO public.schema_migrations")) {
        appliedRows.push({ checksum: values[1], name: values[0] });
      }
      return { rows: [] };
    },
  };
  const evidence = await migrateDatabase({
    approvals: [],
    clientFactory: async (url) => {
      assert.equal(
        url,
        "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
      );
      return client;
    },
    environment: {
      MELTIPLY_SYSTEM_DATABASE_URL:
        "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
    },
    now: () => Date.parse("2026-07-22T12:00:00.000Z"),
    outDir,
    phase: "bootstrap",
    planDigest: "b".repeat(64),
    repoRoot,
    spec: bootstrapSpec,
  });
  assert.equal(evidence.applied.length, 2);
  assert.equal(calls.filter(([text]) => text === "BEGIN").length, 2);
  assert.equal(calls.filter(([text]) => text === "COMMIT").length, 2);
  assert.equal(
    calls.filter(([text]) => String(text).startsWith("INSERT INTO public.schema_migrations"))
      .length,
    2,
  );
  assert.equal(ended, true);
  assert.doesNotMatch(JSON.stringify(evidence), /database\.example|secret/);
});

test("migrator rolls back a failed migration and still closes the session", async (context) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "release-migrator-fail-"));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  const directory = path.join(repoRoot, "packages", "database", "migrations");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001_first.sql"), "FAIL MIGRATION;\n");
  const outDir = path.join(repoRoot, ".release");
  await writeRestorePoint(outDir, bootstrapSpec);
  const calls = [];
  let ended = false;
  const client = {
    connect: async () => {},
    end: async () => {
      ended = true;
    },
    query: async (text) => {
      calls.push(text);
      if (text.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (text.startsWith("SELECT name, checksum")) return { rows: [] };
      if (text === "FAIL MIGRATION;\n") throw new Error("migration failed");
      return { rows: [] };
    },
  };
  await assert.rejects(
    migrateDatabase({
      approvals: [],
      clientFactory: async () => client,
      environment: {
        MELTIPLY_SYSTEM_DATABASE_URL:
          "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
      },
      now: () => Date.parse("2026-07-22T12:00:00.000Z"),
      outDir,
      phase: "bootstrap",
      planDigest: "b".repeat(64),
      repoRoot,
      spec: bootstrapSpec,
    }),
    /migration failed/,
  );
  assert.equal(calls.includes("ROLLBACK"), true);
  assert.equal(ended, true);
});

test("migrator never connects when restore-point evidence is missing", async (context) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "release-no-restore-"));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  let factoryCalled = false;
  await assert.rejects(
    migrateDatabase({
      approvals: [],
      clientFactory: async () => {
        factoryCalled = true;
      },
      environment: {
        MELTIPLY_SYSTEM_DATABASE_URL:
          "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
      },
      now: () => Date.parse("2026-07-22T12:00:00.000Z"),
      outDir: path.join(repoRoot, ".release"),
      phase: "bootstrap",
      planDigest: "b".repeat(64),
      repoRoot,
      spec: bootstrapSpec,
    }),
    /ENOENT/,
  );
  assert.equal(factoryCalled, false);
});

test("migrator never connects when the restore point has less than seven days remaining", async (context) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "release-old-restore-"));
  context.after(() => rm(repoRoot, { force: true, recursive: true }));
  const outDir = path.join(repoRoot, ".release");
  await writeRestorePoint(outDir, bootstrapSpec);
  let factoryCalled = false;
  await assert.rejects(
    migrateDatabase({
      approvals: [],
      clientFactory: async () => {
        factoryCalled = true;
      },
      environment: {
        MELTIPLY_SYSTEM_DATABASE_URL:
          "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
      },
      now: () => Date.parse("2026-07-30T12:00:00.001Z"),
      outDir,
      phase: "bootstrap",
      planDigest: "b".repeat(64),
      repoRoot,
      spec: bootstrapSpec,
    }),
    /less than seven days remaining/,
  );
  assert.equal(factoryCalled, false);
});
