import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function shipi18nBin() {
  return join(dirname(require.resolve("@shipi18n/cli/package.json")), "bin/shipi18n.js");
}
