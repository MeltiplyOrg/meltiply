import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolves the installed Shipi18n CLI entry point through Node's module search
 * paths, which also covers Bun's isolated workspace layout.
 *
 * @returns {string} Absolute path to the CLI executable script.
 */
export function shipi18nBin() {
  return join(dirname(require.resolve("@shipi18n/cli/package.json")), "bin/shipi18n.js");
}
