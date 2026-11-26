#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt, GlossaryError, loadGlossary } from "./glossary.mjs";
import { generateNamespace, PlaceholderDriftError, writeCatalogAtomic } from "./generation.mjs";
import { createOllamaProvider, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from "./ollama.mjs";
import { DEFAULT_TIMEOUT_MS } from "./provider.mjs";
import { withRetry } from "./retry.mjs";
import { createWorkersAiProvider, withFallback } from "./workers-ai.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultLocaleRoot = join(repositoryRoot, "frontend/app/src/locales");

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
// Both defaults are reasoning models. Thinking is analysis text that would be
// billed as output and discarded; translation needs the JSON answer only.
const DISABLE_REASONING = { chat_template_kwargs: { enable_thinking: false } };
const DEFAULT_SEED = 20261019;
const PROVIDER_MODES = new Set(["auto", "workers-ai", "ollama"]);

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return { value, index: index + 1 };
}

function parseArguments(argv) {
  const options = {
    localeRoot: defaultLocaleRoot,
    target: undefined,
    dryRun: false,
    force: false,
    model: undefined,
    provider: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const parsed = optionValue(argv, index, argument);
      options.target = parsed.value;
      index = parsed.index;
    } else if (argument === "--model") {
      const parsed = optionValue(argv, index, argument);
      options.model = parsed.value;
      index = parsed.index;
    } else if (argument === "--provider") {
      const parsed = optionValue(argv, index, argument);
      options.provider = parsed.value;
      index = parsed.index;
    } else if (argument === "--locales") {
      const parsed = optionValue(argv, index, argument);
      options.localeRoot = parsed.value;
      index = parsed.index;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (!options.target) throw new Error("--target <language> is required");
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveProviderMode(provider) {
  const mode = provider ?? process.env.I18N_PROVIDER ?? "auto";
  if (!PROVIDER_MODES.has(mode)) {
    throw new Error(
      `provider must be auto, workers-ai, or ollama; received ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

export function createProvider({ model, provider, systemPrompt, fetchImpl, retryOptions = {} }) {
  const mode = resolveProviderMode(provider);
  const accountId = process.env.WORKERS_AI_ACCOUNT_ID;
  const apiToken = process.env.WORKERS_AI_API_TOKEN;
  if ((accountId && !apiToken) || (!accountId && apiToken)) {
    throw new Error(
      "set both WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN, or neither to use local Ollama; see .env.example",
    );
  }
  const hasWorkersAi = Boolean(accountId && apiToken);
  const seed = parsePositiveInteger(process.env.I18N_SEED, DEFAULT_SEED, "I18N_SEED");
  const timeoutMs = parsePositiveInteger(
    process.env.I18N_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "I18N_TIMEOUT_MS",
  );
  const retry = { retries: 3, baseDelayMs: 500, ...retryOptions };

  if (mode === "ollama" || (mode === "auto" && !hasWorkersAi)) {
    return withRetry(
      createOllamaProvider({
        url: process.env.I18N_OLLAMA_URL || DEFAULT_OLLAMA_URL,
        model: model ?? process.env.I18N_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
        systemPrompt,
        seed,
        timeoutMs,
        fetchImpl,
      }),
      retry,
    );
  }
  if (!hasWorkersAi) {
    throw new Error(
      "I18N_PROVIDER=workers-ai requires WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN; omit I18N_PROVIDER or set it to ollama for credential-free local generation",
    );
  }

  const primaryModel = model ?? process.env.I18N_MODEL ?? DEFAULT_MODEL;
  const fallbackModel = process.env.I18N_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
  const primary = withRetry(
    createWorkersAiProvider({
      accountId,
      apiToken,
      model: primaryModel,
      systemPrompt,
      seed,
      timeoutMs,
      requestOptions: DISABLE_REASONING,
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
        requestOptions: DISABLE_REASONING,
        fetchImpl,
      }),
      retry,
    ),
  );
}

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
        provider: options.provider,
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
