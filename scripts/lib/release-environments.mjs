import { readFileSync } from "node:fs";

// Shared with the OpenTofu root: adding an environment is one deliberate configuration change.
export const releaseEnvironments = Object.freeze(
  JSON.parse(readFileSync(new URL("./release-environments.json", import.meta.url), "utf8")),
);
