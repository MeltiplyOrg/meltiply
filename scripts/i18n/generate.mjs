#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt, GlossaryError, loadGlossary } from "./glossary.mjs";
import { generateNamespace, PlaceholderDriftError, writeCatalogAtomic } from "./generation.mjs";
import { withRetry } from "./retry.mjs";
import { createWorkersAiProvider, withFallback } from "./workers-ai.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultLocaleRoot = join(repositoryRoot, "frontend/app/src/locales");

const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const DEFAULT_FALLBACK_MODEL = "@cf/google/gemma-3-12b-it";
const DEFAULT_SEED = 20261019;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Parses a positive integer environment override, falling back when unset.
 *
 * @param {string | undefined} value Raw environment value.
 * @param {number} fallback Default when the value is unset or empty.
 * @param {string} name Variable name for the error message.
 * @returns {number} Parsed positive integer.
 * @throws {Error} When the value is not a positive integer.
 */
function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Parses generation flags. `--dry-run`, `--force`, `--target`, and `--model`
 * are the supported developer options; `--locales` exists for tests and
 * alternate checkouts.
 *
 * @param {string[]} argv Process arguments after the script name.
 * @returns {{localeRoot: string, target: string, dryRun: boolean, force: boolean, model?: string}}
 */
function parseArguments(argv) {
  const options = {
    localeRoot: defaultLocaleRoot,
    target: undefined,
    dryRun: false,
    force: false,
    model: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      options.target = argv[index + 1];
      index += 1;
    } else if (argument === "--model") {
      options.model = argv[index + 1];
      index += 1;
    } else if (argument === "--locales") {
      options.localeRoot = argv[index + 1];
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (!options.target) throw new Error("--target <language> is required");
  if (!options.localeRoot) throw new Error("--locales requires a path");
  if (options.model !== undefined && !options.model) throw new Error("--model requires a value");
  return options;
}

/**
 * Reads a JSON catalog, surfacing parse errors instead of overwriting a corrupt
 * target file.
 *
 * @param {string} path Catalog path.
 * @returns {Record<string, unknown>} Parsed catalog.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Creates the production provider from environment configuration. The token is
 * read only from the environment and is never printed. Each model gets its own
 * bounded retries and the fallback model runs only after the primary exhausts
 * them, so a transient primary failure does not switch models prematurely.
 *
 * @param {{model?: string, systemPrompt: string, fetchImpl?: typeof fetch, retryOptions?: {retries?: number, baseDelayMs?: number, sleep?: (milliseconds: number) => Promise<void>}}} options
 * @returns {{complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}}
 */
export function createProvider({ model, systemPrompt, fetchImpl, retryOptions = {} }) {
  const accountId = process.env.WORKERS_AI_ACCOUNT_ID;
  const apiToken = process.env.WORKERS_AI_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "generation requires WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN; see .env.example",
    );
  }
  const primaryModel = model ?? process.env.I18N_MODEL ?? DEFAULT_MODEL;
  const fallbackModel = process.env.I18N_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
  const seed = parsePositiveInteger(process.env.I18N_SEED, DEFAULT_SEED, "I18N_SEED");
  const timeoutMs = parsePositiveInteger(
    process.env.I18N_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "I18N_TIMEOUT_MS",
  );
  const retry = { retries: 3, baseDelayMs: 500, ...retryOptions };
  const primary = withRetry(
    createWorkersAiProvider({
      accountId,
      apiToken,
      model: primaryModel,
      systemPrompt,
      seed,
      timeoutMs,
      fetchImpl,
    }),
    retry,
  );
  if (!fallbackModel || fallbackModel === primaryModel) return primary;
  return withFallback(
    primary,
    withRetry(
      createWorkersAiProvider({
        accountId,
        apiToken,
        model: fallbackModel,
        systemPrompt,
        seed,
        timeoutMs,
        fetchImpl,
      }),
      retry,
    ),
  );
}

/**
 * Reads every source namespace, generates target values, and only after all
 * namespaces succeed writes the target files atomically. A placeholder failure
 * in any namespace leaves every committed file byte-identical.
 *
 * @param {object} options
 * @param {string} [options.localeRoot] Locale tree root containing `<lang>/<namespace>.json`.
 * @param {string} options.target Target language code.
 * @param {{name?: string, complete: (...args: any[]) => Promise<string>}} [options.provider] Required unless `dryRun`.
 * @param {boolean} [options.force] Retranslate every existing string.
 * @param {boolean} [options.dryRun] Report pending keys without provider calls or writes.
 * @param {boolean} [options.retry] Wrap the provider with retry here; production providers already retry per model.
 * @returns {Promise<Array<{namespace: string, targetPath: string, result: Record<string, unknown> | null, pending: Array<{key: string, text: string}>, dryRun: boolean, stats: {translated: number, reused: number, skipped: number, failed: number}}>>}
 * @throws {PlaceholderDriftError} When a generated value changes placeholders.
 */
export async function generateAll({
  localeRoot = defaultLocaleRoot,
  target,
  provider,
  force = false,
  dryRun = false,
  retry = true,
}) {
  const sourceRoot = join(localeRoot, "en");
  const targetRoot = join(localeRoot, target);
  const namespaces = readdirSync(sourceRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (namespaces.length === 0) {
    throw new Error(`no source namespaces found in ${sourceRoot}`);
  }

  const run = [];
  for (const file of namespaces) {
    const namespace = file.slice(0, -".json".length);
    const source = readJson(join(sourceRoot, file));
    const targetPath = join(targetRoot, file);
    let existing = {};
    try {
      existing = readJson(targetPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const generated = await generateNamespace({
      source,
      existing,
      provider,
      to: target,
      force,
      dryRun,
      retry,
    });
    run.push({ namespace, targetPath, ...generated });
  }

  if (!dryRun) {
    for (const { targetPath, result } of run) await writeCatalogAtomic(targetPath, result);
  }
  return run;
}

/**
 * Runs the configured production provider and reports per-namespace counts.
 * Exit code 0 means every namespace was generated and written (or previewed),
 * 1 means a provider/placeholder failure with no partial write, and 2 means
 * invalid configuration or arguments.
 *
 * @param {{localeRoot: string, target: string, dryRun: boolean, force: boolean, model?: string}} options
 * @returns {Promise<number>} Process exit code.
 */
export async function main(options) {
  let glossary;
  try {
    glossary = loadGlossary(join(options.localeRoot, "glossary.json"));
  } catch (error) {
    if (error instanceof GlossaryError) {
      console.error(`i18n:generate: ${error.message}`);
      return 2;
    }
    throw error;
  }

  let provider;
  if (!options.dryRun) {
    try {
      provider = createProvider({
        model: options.model,
        systemPrompt: buildSystemPrompt(glossary, options.target),
      });
    } catch (error) {
      console.error(`i18n:generate: ${error.message}`);
      return 2;
    }
  }

  let run;
  try {
    run = await generateAll({ ...options, provider, retry: false });
  } catch (error) {
    if (error instanceof PlaceholderDriftError) {
      console.error(`i18n:generate: ${error.message}`);
      return 1;
    }
    console.error(`i18n:generate: ${error.message}`);
    return 1;
  }

  if (options.dryRun) {
    for (const { namespace, pending, stats } of run) {
      console.log(
        `${namespace}: ${pending.length} string(s) would be sent, ${stats.reused} reused, ${stats.skipped} skipped`,
      );
      for (const { key } of pending) console.log(`  ${JSON.stringify(key)}`);
    }
    console.log("dry run: no files written and no provider calls made");
    return 0;
  }

  for (const { namespace, targetPath, stats } of run) {
    console.log(
      `${namespace}: translated ${stats.translated}, reused ${stats.reused}, skipped ${stats.skipped}, failed ${stats.failed} → ${targetPath}`,
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`i18n:generate: ${error.message}`);
    process.exitCode = 2;
  }
}
