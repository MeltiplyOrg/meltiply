import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extendLock, lockViolations, unlockedMigrations } from "./migration-lock.mjs";

const first = { checksum: "a".repeat(64), name: "001_first.sql" };
const second = { checksum: "b".repeat(64), name: "002_second.sql" };
const locked = { [first.name]: first.checksum };

describe("migration lock", () => {
  it("accepts unchanged migrations", () => {
    assert.deepEqual(lockViolations(locked, [first, second]), []);
  });

  it("rejects an edited migration", () => {
    const edited = { ...first, checksum: "c".repeat(64) };
    assert.match(
      lockViolations(locked, [edited])[0],
      /001_first\.sql: applied migration was edited/,
    );
  });

  it("rejects a removed migration", () => {
    assert.match(
      lockViolations(locked, [second])[0],
      /001_first\.sql: applied migration was removed/,
    );
  });

  it("reports migrations missing from the lock", () => {
    assert.deepEqual(unlockedMigrations(locked, [first, second]), [second.name]);
  });

  it("extends the lock without rewriting recorded checksums", () => {
    const edited = { ...first, checksum: "c".repeat(64) };
    assert.deepEqual(extendLock(locked, [edited, second]), {
      [first.name]: first.checksum,
      [second.name]: second.checksum,
    });
  });
});
