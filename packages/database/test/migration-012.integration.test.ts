import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vite-plus/test";

const adminUrl =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const databaseName = `meltiply_migration_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

/**
 * Replaces the database path in an administrative connection URL.
 *
 * @param url - PostgreSQL connection URL.
 * @param database - Target database name.
 * @returns Connection URL for the target database.
 */
function databaseUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Reads checked-in migrations in filename order.
 *
 * @returns Migration file names and SQL sources.
 */
async function loadMigrations(): Promise<{ name: string; source: string }[]> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(migrationsDirectory, name), "utf8"),
    })),
  );
}

const maintenance = new Client({ connectionString: databaseUrl(adminUrl, "postgres") });
const migrationClient = new Client({
  connectionString: databaseUrl(adminUrl, databaseName),
});

afterAll(async () => {
  await migrationClient.end().catch(() => undefined);
  await maintenance
    .query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
    .catch(() => undefined);
  await maintenance.end().catch(() => undefined);
});

describe("multi-user role migration", () => {
  it("preserves the existing personal Workspace and its data as the shared Workspace", async () => {
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${databaseName}`);
    await migrationClient.connect();

    const migrations = await loadMigrations();
    for (const migration of migrations.filter(({ name }) => name < "012_")) {
      await migrationClient.query(migration.source);
    }

    const authUserId = "migration-auth-owner";
    const userId = "10000000-0000-4000-8000-000000000101";
    const organizationId = "20000000-0000-4000-8000-000000000101";
    const brandProfileId = "30000000-0000-4000-8000-000000000101";
    await migrationClient.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "installationOwner")
         VALUES ($1, 'Legacy Owner', 'legacy-owner@meltiply.local', TRUE, TRUE)`,
      [authUserId],
    );
    await migrationClient.query(
      `INSERT INTO users (id, auth_user_id, email, display_name)
         VALUES ($1, $2, 'legacy-owner@meltiply.local', 'Legacy Owner')`,
      [userId, authUserId],
    );
    await migrationClient.query(
      `INSERT INTO organizations (id, name, slug, personal_user_id)
         VALUES ($1, 'Legacy Workspace', 'legacy-workspace', $2)`,
      [organizationId, userId],
    );
    await migrationClient.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [organizationId, userId],
    );
    await migrationClient.query(
      `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Legacy Brand', '#1d4ed8')`,
      [brandProfileId, organizationId],
    );

    const migration = migrations.find(({ name }) => name.startsWith("012_"));
    expect(migration).toBeDefined();
    await migrationClient.query(migration!.source);

    const workspace = await migrationClient.query<{
      id: string;
      is_shared: boolean;
    }>("SELECT id, is_shared FROM organizations WHERE id = $1", [organizationId]);
    expect(workspace.rows[0]).toEqual({ id: organizationId, is_shared: true });

    const owner = await migrationClient.query<{
      installation_owner: boolean;
    }>("SELECT installation_owner FROM users WHERE id = $1", [userId]);
    expect(owner.rows[0]?.installation_owner).toBe(true);

    const membership = await migrationClient.query<{ role: string }>(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    expect(membership.rows[0]?.role).toBe("admin");

    const profile = await migrationClient.query<{ name: string }>(
      "SELECT name FROM brand_profiles WHERE id = $1 AND org_id = $2",
      [brandProfileId, organizationId],
    );
    expect(profile.rows[0]?.name).toBe("Legacy Brand");

    const retiredColumns = await migrationClient.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name = 'organizations' AND column_name = 'personal_user_id')
             OR (table_name = 'user' AND column_name = 'installationOwner'))`,
    );
    expect(retiredColumns.rows).toEqual([]);
  }, 120_000);
});
