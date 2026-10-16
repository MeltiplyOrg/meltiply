import assert from "node:assert/strict";
import { mkdir, symlink, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generateWorkerTypes } from "./worker-types.mjs";

/**
 * Builds a disposable workspace using installed Wrangler, with local secrets
 * and root dotenv toggles that would pollute generated consumer binding types.
 * Its checked-in var must survive while no secret key enters declarations.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "worker-types-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", workspaces: ["workers/*"] }),
  );
  const workerDir = join(root, "workers", "api");
  await mkdir(workerDir, { recursive: true });
  await symlink(
    fileURLToPath(new URL("../../node_modules/", import.meta.url)),
    join(root, "node_modules"),
    "dir",
  );
  await writeFile(
    join(workerDir, "package.json"),
    JSON.stringify({ name: "api", scripts: { types: "wrangler types" } }),
  );
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    JSON.stringify({
      name: "fixture-api",
      compatibility_date: "2026-07-30",
      vars: { FIXTURE_BINDING: "known" },
    }),
  );
  // Local secrets that must never reach the generated declarations.
  await writeFile(join(workerDir, ".dev.vars"), "LOCAL_DEV_SECRET=abc123\n");
  await writeFile(join(workerDir, ".env"), "LOCAL_ENV_SECRET=def456\n");
  await writeFile(
    join(root, ".env"),
    "CLOUDFLARE_INCLUDE_PROCESS_ENV=true\nLOCAL_ROOT_SECRET=private\n",
  );
  return {
    root,
    workerDir,
    output: join(workerDir, "worker-configuration.d.ts"),
  };
}

/** Env files must be masked inside the session mirror, not read or removed. */
test("worker type generation ignores checkout env files and Cloudflare env", async (t) => {
  const { root, workerDir, output } = await fixture(t);
  process.env.CLOUDFLARE_ACCOUNT_ID = "leaked-account";
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
  t.after(() => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
  });

  await generateWorkerTypes(root);

  const generated = await readFile(output, "utf8");
  assert.match(generated, /FIXTURE_BINDING:\s*"known"/);
  assert.doesNotMatch(
    generated,
    /LOCAL_DEV_SECRET|LOCAL_ENV_SECRET|LOCAL_ROOT_SECRET|leaked-account/,
  );
  assert.equal(await readFile(join(workerDir, ".dev.vars"), "utf8"), "LOCAL_DEV_SECRET=abc123\n");
  assert.equal(await readFile(join(workerDir, ".env"), "utf8"), "LOCAL_ENV_SECRET=def456\n");
  assert.equal(
    await readFile(join(root, ".env"), "utf8"),
    "CLOUDFLARE_INCLUDE_PROCESS_ENV=true\nLOCAL_ROOT_SECRET=private\n",
  );
});
