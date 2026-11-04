import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const root = new URL("../", import.meta.url);

/** Regenerates the runtime version from the canonical OpenAPI document; rejects missing versions. */
export async function generateContractVersion() {
  const document = YAML.parse(await readFile(new URL("openapi.yaml", root), "utf8"));
  const version = document?.info?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("OpenAPI info.version must be a semantic version");
  }
  await writeFile(
    new URL("src/generated/version.ts", root),
    `// Generated from openapi.yaml by contract:generate; do not edit.\n/** Contract implemented by this build, independent of the application release. */\nexport const CONTRACT_VERSION = ${JSON.stringify(version)};\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateContractVersion();
}
