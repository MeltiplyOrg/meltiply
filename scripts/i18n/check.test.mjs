import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const checkScript = fileURLToPath(new URL("./check.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots = [];

/**
 * Writes a minimal locale tree. `glossary` overrides the default empty shared
 * glossary so tests can exercise ignore-key derivation.
 */
function fixture({ en, es, glossary }) {
  const root = mkdtempSync(join(tmpdir(), "meltiply-i18n-check-"));
  temporaryRoots.push(root);
  const files = {
    "glossary.json": JSON.stringify(
      glossary ?? {
        version: 1,
        style: {},
        keepVerbatim: {},
        preferredTranslations: {},
        intentionallyIdentical: [],
      },
    ),
    "en/ui.json": JSON.stringify(en),
    "es/ui.json": JSON.stringify(es),
  };
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return root;
}

/**
 * Runs the wrapper against a fixture locale root in a child process.
 *
 * @param {string} root Fixture locale tree.
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runCheck(root) {
  return spawnSync(process.execPath, [checkScript, root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("passes on a clean, fully translated locale tree", () => {
  const root = fixture({
    en: { Hello: "Hello", Welcome: "Welcome" },
    es: { Hello: "Hola", Welcome: "Bienvenido" },
  });

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /coverage 100\.0%/u);
});

test("fails when a target drops a source placeholder", () => {
  const root = fixture({
    en: { "Hello {name}": "Hello {name}" },
    es: { "Hello {name}": "Hola" },
  });

  const result = runCheck(root);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /placeholder|\{name\}/u);
});

test("fails when a target invents a placeholder", () => {
  const root = fixture({
    en: { Hello: "Hello" },
    es: { Hello: "Hola {name}" },
  });

  const result = runCheck(root);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /unexpected|\{name\}/u);
});

test("fails when a source key is missing from the target", () => {
  const root = fixture({
    en: { Hello: "Hello", Welcome: "Welcome" },
    es: { Hello: "Hola" },
  });

  const result = runCheck(root);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /missing-key|missing in es/u);
});

test("allows intentionally identical values declared in the glossary", () => {
  const root = fixture({
    en: { "ID: {id}": "ID: {id}" },
    es: { "ID: {id}": "ID: {id}" },
    glossary: {
      version: 1,
      style: {},
      keepVerbatim: { "ID: {id}": "Identifier label" },
      preferredTranslations: {},
      intentionallyIdentical: [],
    },
  });

  const result = runCheck(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("rejects a glossary term the ignore-key list cannot represent", () => {
  const root = fixture({
    en: { Hello: "Hello" },
    es: { Hello: "Hola" },
    glossary: {
      version: 1,
      style: {},
      keepVerbatim: { "Hello, world": "Contains a comma" },
      preferredTranslations: {},
      intentionallyIdentical: [],
    },
  });

  const result = runCheck(root);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not contain a comma/u);
});
