import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMigrations } from "../release/release-migrate.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockPath = join(repositoryRoot, "packages/database/migrations.lock.json");

export function lockViolations(locked, migrations) {
  const current = new Map(migrations.map(({ checksum, name }) => [name, checksum]));
  const violations = [];
  for (const [name, checksum] of Object.entries(locked)) {
    if (!current.has(name)) violations.push(`${name}: applied migration was removed`);
    else if (current.get(name) !== checksum) {
      violations.push(`${name}: applied migration was edited; add a new migration instead`);
    }
  }
  return violations;
}

export function unlockedMigrations(locked, migrations) {
  return migrations.map(({ name }) => name).filter((name) => !Object.hasOwn(locked, name));
}

export function extendLock(locked, migrations) {
  const additions = migrations.filter(({ name }) => !Object.hasOwn(locked, name));
  return {
    ...locked,
    ...Object.fromEntries(additions.map(({ checksum, name }) => [name, checksum])),
  };
}

async function readLock() {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch (cause) {
    if (cause?.code === "ENOENT") return {};
    throw cause;
  }
}

async function main() {
  const [locked, migrations] = await Promise.all([readLock(), loadMigrations(repositoryRoot)]);
  const violations = lockViolations(locked, migrations);
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    await writeFile(lockPath, `${JSON.stringify(extendLock(locked, migrations), null, 2)}\n`);
    return;
  }
  const unlocked = unlockedMigrations(locked, migrations);
  if (unlocked.length > 0) {
    console.error(`${unlocked.join(", ")}: run \`bun run db:lock\` to record new migrations`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
