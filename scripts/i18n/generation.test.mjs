import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { generateAll } from "./generate.mjs";
import { generateNamespace, PlaceholderDriftError, serializeCatalog } from "./generation.mjs";
import { withRetry } from "./retry.mjs";

const temporaryRoots = [];

/**
 * Creates a temporary locale tree and removes it after the test.
 *
 * @param {Record<string, string>} files Path relative to the fixture root → file content.
 * @returns {string} Fixture root.
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "meltiply-i18n-"));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return root;
}

/**
 * Returns a provider that serves one response per call, recording each prompt.
 * Errors are thrown instead of serialized so retry paths can be exercised.
 *
 * @param {Array<string[] | Error>} responses Responses in call order.
 * @returns {{name: string, prompts: string[], complete: (prompt: string) => Promise<string>}}
 */
function scriptedProvider(responses) {
  const prompts = [];
  return {
    name: "scripted",
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      if (responses.length === 0) throw new Error("unexpected provider call");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
  };
}

/**
 * Fails the test if generation ever calls the provider.
 *
 * @returns {{name: string, complete: () => Promise<never>}}
 */
function noProvider() {
  return {
    name: "forbidden",
    async complete() {
      throw new Error("provider must not be called");
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("reuses non-empty target values and sends only missing strings", async () => {
  const provider = scriptedProvider([["Beta español", "Gama"]]);

  const { result, stats } = await generateNamespace({
    source: { Alpha: "Alpha", Beta: "Beta", Gamma: "Gamma" },
    existing: { Alpha: "Alfa", Gamma: "" },
    provider,
    to: "es",
  });

  assert.deepEqual(result, { Alpha: "Alfa", Beta: "Beta español", Gamma: "Gama" });
  assert.deepEqual(stats, { translated: 2, reused: 1, skipped: 0, failed: 0 });
  assert.equal(provider.prompts.length, 1);
  assert.match(provider.prompts[0], /"Beta"/);
  assert.match(provider.prompts[0], /"Gamma"/);
  assert.doesNotMatch(provider.prompts[0], /"Alpha"/);
  assert.doesNotMatch(provider.prompts[0], /"Alfa"/);
});

test("dry run lists pending keys without calling the provider", async () => {
  const { result, pending, dryRun, stats } = await generateNamespace({
    source: { Alpha: "Alpha", Beta: "Beta", Count: 4 },
    existing: { Alpha: "Alfa" },
    provider: noProvider(),
    to: "es",
    dryRun: true,
  });

  assert.equal(result, null);
  assert.equal(dryRun, true);
  assert.deepEqual(pending, [{ key: "Beta", text: "Beta" }]);
  assert.deepEqual(stats, { translated: 0, reused: 1, skipped: 1, failed: 0 });
});

test("force retranslates existing values", async () => {
  const provider = scriptedProvider([["Alfa nuevo", "Beta nueva"]]);

  const { result, stats } = await generateNamespace({
    source: { Alpha: "Alpha", Beta: "Beta" },
    existing: { Alpha: "Alfa", Beta: "Beta vieja" },
    provider,
    to: "es",
    force: true,
  });

  assert.deepEqual(result, { Alpha: "Alfa nuevo", Beta: "Beta nueva" });
  assert.deepEqual(stats, { translated: 2, reused: 0, skipped: 0, failed: 0 });
});

test("aborts with placeholder drift instead of returning a partial catalog", async () => {
  const provider = scriptedProvider([["Hola"]]);

  await assert.rejects(
    generateNamespace({
      source: { "Hello {name}": "Hello {name}" },
      provider,
      to: "es",
    }),
    (error) => {
      assert.ok(error instanceof PlaceholderDriftError);
      assert.deepEqual(error.drift, [{ key: "Hello {name}", missing: ["{name}"], added: [] }]);
      return true;
    },
  );
});

test("retries transient provider failures with backoff", async () => {
  const rateLimited = Object.assign(new Error("rate limited"), { status: 429 });
  const provider = scriptedProvider([rateLimited, ["Hola"]]);
  const delays = [];

  const { result } = await generateNamespace({
    source: { Hello: "Hello" },
    provider,
    to: "es",
    retries: 2,
    baseDelayMs: 5,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.deepEqual(result, { Hello: "Hola" });
  assert.equal(provider.prompts.length, 2);
  assert.deepEqual(delays, [5]);
});

test("fails fast on authentication errors", async () => {
  const unauthorized = Object.assign(new Error("unauthorized"), {
    status: 401,
    retryable: false,
  });
  const provider = scriptedProvider([unauthorized, unauthorized, unauthorized]);

  await assert.rejects(
    generateNamespace({ source: { Hello: "Hello" }, provider, to: "es", sleep: async () => {} }),
    /unauthorized/,
  );
  assert.equal(provider.prompts.length, 1);
});

test("withRetry leaves non-retryable errors untouched", async () => {
  const provider = scriptedProvider([new Error("bad request")]);

  await assert.rejects(
    withRetry(provider, { sleep: async () => {} }).complete("prompt"),
    /bad request/,
  );
  assert.equal(provider.prompts.length, 1);
});

test("generateAll leaves committed files byte-identical when a placeholder drifts", async () => {
  const original = serializeCatalog({ "Hello {name}": "Hola {name}" });
  const root = fixture({
    "en/ui.json": serializeCatalog({ "Hello {name}": "Hello {name}" }),
    "es/ui.json": original,
  });

  await assert.rejects(
    generateAll({
      localeRoot: root,
      target: "es",
      force: true,
      provider: scriptedProvider([["Hola"]]),
    }),
    PlaceholderDriftError,
  );

  assert.equal(readFileSync(join(root, "es/ui.json"), "utf8"), original);
  assert.deepEqual(readdirSync(join(root, "es")), ["ui.json"]);
});

test("generateAll writes source order and produces byte-identical output on a repeat run", async () => {
  const root = fixture({
    "en/ui.json": serializeCatalog({
      First: "First",
      "Second {count}": "Second {count}",
      Third: "Third",
    }),
  });
  const provider = scriptedProvider([["Primero", "Segundo {count}", "Tercero"]]);

  await generateAll({ localeRoot: root, target: "es", provider });
  const first = readFileSync(join(root, "es/ui.json"), "utf8");

  assert.equal(
    first,
    serializeCatalog({ First: "Primero", "Second {count}": "Segundo {count}", Third: "Tercero" }),
  );

  const repeat = await generateAll({ localeRoot: root, target: "es", provider: noProvider() });
  assert.deepEqual(
    repeat.map(({ stats }) => stats),
    [{ translated: 0, reused: 3, skipped: 0, failed: 0 }],
  );
  assert.equal(readFileSync(join(root, "es/ui.json"), "utf8"), first);
});

test("generateAll leaves every file untouched when a later namespace fails", async () => {
  const ui = serializeCatalog({ Hello: "Hola" });
  const status = serializeCatalog({ ready: "Listo" });
  const root = fixture({
    "en/ui.json": serializeCatalog({ Hello: "Hello" }),
    "en/status.json": serializeCatalog({ ready: "Ready" }),
    "es/ui.json": ui,
    "es/status.json": status,
  });
  const failure = new Error("provider exploded");
  const provider = scriptedProvider([["Listo de nuevo"], failure]);

  await assert.rejects(
    generateAll({ localeRoot: root, target: "es", force: true, provider }),
    /provider exploded/,
  );

  assert.equal(provider.prompts.length, 2);
  assert.equal(readFileSync(join(root, "es/ui.json"), "utf8"), ui);
  assert.equal(readFileSync(join(root, "es/status.json"), "utf8"), status);
});
