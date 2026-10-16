import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Mirrors selected Worker config directories in a private temporary repo layout.
 * Configs are copied; source/dependency paths remain links to the live checkout.
 * Env files are hidden throughout the mirrored ancestor directories; supplied
 * session secrets replace them only at selected configs. This also prevents
 * Bun's root dotenv bootstrap from reintroducing checkout secrets or toggles.
 * Cleanup removes only this owned tree, including on failed preparation.
 */
export async function createWorkerConfigSession(repoRoot, configPaths, envText) {
  const root = resolve(repoRoot);
  const configs = configPaths.map((path) => relative(root, resolve(path)));
  for (const path of configs) {
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
      throw new Error("Local Worker configs must be inside the checkout");
    }
  }
  const configFiles = new Set(configs);
  const configDirs = new Set(configs.map(dirname));
  const ancestors = new Set(["."]);
  for (const directory of configDirs) {
    let current = directory;
    while (current !== ".") {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  const sessionRoot = await mkdtemp(join(tmpdir(), "meltiply-worker-session-"));

  /** Preserves relative config paths while isolating env lookup at selected dirs. */
  async function mirror(directory) {
    const target = resolve(sessionRoot, directory);
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(resolve(root, directory), {
      withFileTypes: true,
    })) {
      if (
        entry.name.startsWith(".dev.vars") ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      ) {
        continue;
      }
      const path = directory === "." ? entry.name : join(directory, entry.name);
      const source = resolve(root, path);
      const destination = resolve(sessionRoot, path);
      if (ancestors.has(path)) {
        await mirror(path);
      } else if (configFiles.has(path)) {
        await copyFile(source, destination);
      } else {
        await symlink(source, destination);
      }
    }
    if (configDirs.has(directory)) {
      await writeFile(join(target, ".dev.vars"), envText, {
        mode: 0o600,
        flag: "wx",
      });
    }
  }

  try {
    await mirror(".");
  } catch (error) {
    await rm(sessionRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    root: sessionRoot,
    configs: configs.map((path) => resolve(sessionRoot, path)),
  };
}
