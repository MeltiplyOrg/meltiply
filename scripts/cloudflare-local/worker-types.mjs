import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createWorkerConfigSession } from "./worker-config-session.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..");

function workerConfigPaths(root) {
  return readdirSync(join(root, "workers"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      join(root, "workers", entry.name, "wrangler.jsonc"),
      join(root, "workers", entry.name, "wrangler.json"),
    ])
    .filter((configPath) => existsSync(configPath));
}

function wranglerNeutralEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !name.startsWith("CLOUDFLARE_") && !name.startsWith("WRANGLER_"),
    ),
  );
}

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
