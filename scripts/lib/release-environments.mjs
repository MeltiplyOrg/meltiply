import { readFileSync } from "node:fs";

export const releaseEnvironments = Object.freeze(
  JSON.parse(readFileSync(new URL("./release-environments.json", import.meta.url), "utf8")),
);
