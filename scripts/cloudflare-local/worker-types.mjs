// Regenerates every Worker's worker-configuration.d.ts binding declarations.
//
// `wrangler types` merges every key it can see into the Env interface: the
// config's own secrets, a sibling `.dev.vars`, and (through Wrangler's startup
// .env bootstrap plus CLOUDFLARE_INCLUDE_PROCESS_ENV) process environment
// variables. A local checkout carries all three, so the old script rewrote the
// checked-in declarations with local secrets on every run while CI produced
// clean files — a permanent diff gate failure one way or the other.
//
// Generation therefore runs inside the same private session mirror that local
// `wrangler dev` sessions use (worker-config-session.mjs): configs are copied,
// sources stay symlinked to the live checkout, and each Worker directory gets
// an empty `.dev.vars` plus no `.env*`. Wrangler discovers identical config
// paths inside the mirror, so emitted headers and hashes match a clean run
// byte-for-byte. Checkout env files are never read, modified, or deleted.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createWorkerConfigSession } from "./worker-config-session.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..");

/**
 * Lists the Worker Wrangler configs `bun run --filter './workers/*'` covers.
 * Generation mirrors every Worker config it finds rather than hardcoding names
 * so a new workspace Worker is picked up with the same filter semantics.
 *
 * @param {string} root Repository or fixture root containing `workers/`.
 * @returns {string[]} Absolute `wrangler.jsonc`/`wrangler.json` paths.
 */
function workerConfigPaths(root) {
  return readdirSync(join(root, "workers"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      join(root, "workers", entry.name, "wrangler.jsonc"),
      join(root, "workers", entry.name, "wrangler.json"),
    ])
    .filter((configPath) => existsSync(configPath));
}

/**
 * Builds the child environment for the mirrored `bun run types` invocation.
 * `wrangler types` consults CLOUDFLARE_* toggles (env selection, .env loading,
 * process-env secrets) and WRANGLER_* behaviour overrides; any one of them a
 * developer exported would change the generated declarations, so they are all
 * stripped. Everything else (PATH, HOME, CI) passes through untouched.
 *
 * @param {NodeJS.ProcessEnv} source Environment to filter.
 * @returns {NodeJS.ProcessEnv} Environment without Cloudflare/Wrangler keys.
 */
function wranglerNeutralEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !name.startsWith("CLOUDFLARE_") && !name.startsWith("WRANGLER_"),
    ),
  );
}

/**
 * Regenerates the checked-in Worker binding declarations deterministically.
 * Runs the root `types` script fan-out inside a private mirror whose Worker
 * env files are empty, so output depends only on checked-in wrangler configs.
 * Wrangler normally writes through the mirror's output symlink directly into
 * the checkout; a regular mirrored file is synced back instead, covering a
 * future Wrangler that replaces rather than truncates the output path.
 *
 * @param {string} [repoRoot] Checkout root; the caller's own repository by
 *   default. Tests pass a fixture root to exercise the same isolation path.
 * @returns {Promise<void>} Resolves once every Worker's declaration is current.
 */
export async function generateWorkerTypes(repoRoot = repositoryRoot) {
  const configPaths = workerConfigPaths(repoRoot);
  const session = await createWorkerConfigSession(repoRoot, configPaths, "");
  try {
    execFileSync("bun", ["run", "--sequential", "--filter", "./workers/*", "types"], {
      cwd: session.root,
      env: wranglerNeutralEnv(process.env),
      stdio: "inherit",
    });
    for (const configPath of configPaths) {
      const declarations = join(dirname(configPath), "worker-configuration.d.ts");
      const mirrored = join(session.root, relative(repoRoot, declarations));
      if (existsSync(mirrored) && !lstatSync(mirrored).isSymbolicLink()) {
        writeFileSync(declarations, readFileSync(mirrored));
      }
    }
  } finally {
    await rm(session.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await generateWorkerTypes();
}
