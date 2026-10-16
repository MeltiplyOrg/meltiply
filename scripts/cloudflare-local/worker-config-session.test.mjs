import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createWorkerConfigSession } from "./worker-config-session.mjs";

/** Creates a disposable checkout with real relative Worker/source dependencies. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "meltiply-session-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workers", "automation", "src"), { recursive: true });
  await mkdir(join(root, "packages", "domain"), { recursive: true });
  const config = join(root, "workers", "automation", "wrangler.jsonc");
  await writeFile(config, '{"main":"src/index.js"}');
  await writeFile(join(dirname(config), "src", "index.js"), "original source");
  await writeFile(join(root, "packages", "domain", "value.js"), "shared source");
  return { root, config };
}

/** Existing local secrets stay intact while sessions use independently owned envs. */
test("existing Worker env files survive concurrent session creation and cleanup", async (t) => {
  const { root, config } = await fixture(t);
  const localEnv = join(dirname(config), ".dev.vars");
  const localDotEnv = join(dirname(config), ".env.local");
  await writeFile(localEnv, "SECRET=developer\n");
  await writeFile(localDotEnv, "SECRET=local-override\n");
  const original = await stat(localEnv);
  const sessions = await Promise.all([
    createWorkerConfigSession(root, [config], "SECRET=first-session\n"),
    createWorkerConfigSession(root, [config], "SECRET=second-session\n"),
  ]);
  t.after(() =>
    Promise.all(sessions.map((session) => rm(session.root, { recursive: true, force: true }))),
  );
  assert.notEqual(sessions[0].root, sessions[1].root);
  for (const session of sessions) {
    const envStat = await stat(join(dirname(session.configs[0]), ".dev.vars"));
    assert.equal(envStat.mode & 0o777, 0o600);
    assert.equal((await stat(session.root)).mode & 0o777, 0o700);
    await assert.rejects(stat(join(dirname(session.configs[0]), ".env.local")), { code: "ENOENT" });
  }
  await rm(sessions[0].root, { recursive: true });
  assert.equal(
    await readFile(join(dirname(sessions[1].configs[0]), ".dev.vars"), "utf8"),
    "SECRET=second-session\n",
  );
  assert.equal(await readFile(localEnv, "utf8"), "SECRET=developer\n");
  assert.equal(await readFile(localDotEnv, "utf8"), "SECRET=local-override\n");
  assert.equal((await stat(localEnv)).ino, original.ino);
});

/** Config-relative imports resolve and source edits remain visible without copying code. */
test("isolated configs preserve relative source and shared-package paths", async (t) => {
  const { root, config } = await fixture(t);
  const session = await createWorkerConfigSession(root, [config], "SECRET=session\n");
  t.after(() => rm(session.root, { recursive: true, force: true }));
  const directory = dirname(session.configs[0]);
  assert.equal(
    await readFile(join(directory, "../../packages/domain/value.js"), "utf8"),
    "shared source",
  );
  await writeFile(join(dirname(config), "src", "index.js"), "edited source");
  assert.equal(await readFile(join(directory, "src/index.js"), "utf8"), "edited source");
  await writeFile(session.configs[0], '{"main":"different.js"}');
  assert.equal(await readFile(config, "utf8"), '{"main":"src/index.js"}');
});

/** External configs cannot escape the owned mirror or expose unrelated env directories. */
test("rejects a config outside the checkout", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    createWorkerConfigSession(root, [join(root, "..", "foreign.jsonc")], ""),
    /inside the checkout/,
  );
});
