import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLocalTestDatabaseUrl,
  integrationDatabaseUrl,
  LOCAL_ADMIN_URL,
  LOCAL_SYSTEM_URL,
  LOCAL_TEST_URL,
} from "../lib/integration-database.ts";

test("privileged roles retain the authenticated test database destination and session options", () => {
  const selected = new URL(
    "postgres://meltiply_rls:fixture@127.0.0.1:55483/meltiply?sslmode=disable&options=-c%20search_path%3Dfixture%2Cpublic",
  );
  for (const role of ["system", "admin"]) {
    const privileged = new URL(integrationDatabaseUrl(selected.href, role));
    assert.equal(privileged.hostname, selected.hostname);
    assert.equal(privileged.port, "55483");
    assert.equal(privileged.pathname, selected.pathname);
    assert.equal(privileged.search, selected.search);
    assert.equal(privileged.username, role === "admin" ? "postgres" : "meltiply_system");
    assert.notEqual(privileged.password, selected.password);
  }
});

test("missing or unsafe test destinations fail instead of selecting a default database", () => {
  for (const selected of [
    undefined,
    "postgres://fixture@remote.example:55483/meltiply",
    "postgres://fixture@127.0.0.1:55483/production",
    "https://127.0.0.1:55483/meltiply",
  ])
    assert.throws(() => integrationDatabaseUrl(selected, "system"), TypeError);
});

test("explicit privileged credentials cannot redirect fixture writes to another local database", () => {
  const selected = "postgres://fixture@127.0.0.1:55483/meltiply?sslmode=disable";
  const explicit = "postgres://custom:secret@127.0.0.1:55483/meltiply?sslmode=disable";
  assert.equal(integrationDatabaseUrl(selected, "admin", explicit), explicit);
  assert.throws(
    () =>
      integrationDatabaseUrl(
        selected,
        "admin",
        "postgres://custom:secret@127.0.0.1:5433/meltiply?sslmode=disable",
      ),
    TypeError,
  );
});

test("assertLocalTestDatabaseUrl accepts exported local defaults and rejects malformed or remote URLs", () => {
  for (const url of [LOCAL_TEST_URL, LOCAL_SYSTEM_URL, LOCAL_ADMIN_URL]) {
    assert.equal(assertLocalTestDatabaseUrl(url).pathname, "/meltiply");
  }
  assert.throws(
    () => assertLocalTestDatabaseUrl("not-a-url", "TEST_URL"),
    /TEST_URL is not a valid URL/,
  );
  assert.throws(
    () => assertLocalTestDatabaseUrl("postgres://user@db.example.com/meltiply", "TEST_URL"),
    /TEST_URL: integration connections must target the local meltiply test database/,
  );
});
