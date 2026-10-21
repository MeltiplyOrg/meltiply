#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shipi18nBin } from "./shipi18n.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localeRoot = join(repositoryRoot, "frontend/app/src/locales");
const locksPath = join(repositoryRoot, ".shipi18n/locks.json");

const result = spawnSync(
  process.execPath,
  [
    shipi18nBin(),
    "lock",
    localeRoot,
    "--source",
    "en",
    "--locks",
    locksPath,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`i18n:lock: ${result.error.message}`);
  process.exitCode = 2;
} else {
  process.exitCode = result.status ?? 1;
}
