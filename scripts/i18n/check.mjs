#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GlossaryError, identicalTerms, loadGlossary } from "./glossary.mjs";
import { shipi18nBin } from "./shipi18n.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultLocaleRoot = join(repositoryRoot, "frontend/app/src/locales");
const locksPath = join(repositoryRoot, ".shipi18n/locks.json");

/**
 * Runs Shipi18n's deterministic check over the committed locale tree.
 * Intentionally identical terms come from the shared glossary, so the catalog
 * test, generation prompt, and CI gate cannot drift apart. Structural rules the
 * product requires (unexpected placeholders, missing or collapsed plurals,
 * untranslated values) are escalated because Shipi18n treats them as advisory
 * by default.
 *
 * @param {{localeRoot?: string}} [options] Locale tree override for process tests.
 * @returns {number} Shipi18n's exit code (0 pass, 1 findings, 2 usage/config).
 */
export function runCheck({ localeRoot = defaultLocaleRoot } = {}) {
  const root = resolve(localeRoot);
  let ignoreKeys;
  try {
    const glossary = loadGlossary(join(root, "glossary.json"));
    ignoreKeys = identicalTerms(glossary);
  } catch (error) {
    if (error instanceof GlossaryError) {
      console.error(`i18n:check: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const result = spawnSync(
    process.execPath,
    [
      shipi18nBin(),
      "check",
      root,
      "--source",
      "en",
      "--format",
      "brace",
      "--fail-on",
      "error",
      "--severity",
      "untranslated=error,placeholder-added=error,plural-forms=error,plural-category=error",
      "--min-coverage",
      "100",
      "--ignore-keys",
      ignoreKeys.join(","),
      "--locks",
      locksPath,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Parses the wrapper's small argument surface: an optional locale root used by
 * the process-level smoke test.
 *
 * @param {string[]} argv Process arguments after the script name.
 * @returns {{localeRoot: string}}
 */
function parseArguments(argv) {
  let localeRoot = defaultLocaleRoot;
  for (const argument of argv) {
    if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    localeRoot = argument;
  }
  return { localeRoot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCheck(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`i18n:check: ${error.message}`);
    process.exitCode = 2;
  }
}
