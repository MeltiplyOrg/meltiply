import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { translateStrings, validatePlaceholders } from "@shipi18n/core";

import { withRetry } from "./retry.mjs";

/** Target-language placeholder grammar used by every catalog namespace. */
const PLACEHOLDER_FORMAT = "brace";

/**
 * Raised when the provider returns a translation that would break interpolation.
 * The run aborts before any file is written so a half-valid catalog is impossible.
 */
export class PlaceholderDriftError extends Error {
  /**
   * @param {Array<{key: string, missing: string[], added: string[]}>} drift Per-key placeholder differences.
   */
  constructor(drift) {
    const details = drift
      .map(({ key, missing, added }) => {
        const changes = [
          missing.length ? `missing ${missing.join(", ")}` : "",
          added.length ? `added ${added.join(", ")}` : "",
        ].filter(Boolean);
        return `${JSON.stringify(key)} (${changes.join("; ")})`;
      })
      .join(", ");
    super(`placeholder drift detected; no files were written: ${details}`);
    this.name = "PlaceholderDriftError";
    this.drift = drift;
  }
}

/**
 * Generates the target values for one namespace.
 *
 * Existing non-empty target values are reused unless `force` is set, so a
 * one-string English change costs one string. Shipi18n batches the outgoing
 * texts and this module validates every returned placeholder set before
 * returning a catalog. Nothing is written here: the caller writes only after
 * every namespace in the run has succeeded.
 *
 * @param {object} params
 * @param {Record<string, unknown>} params.source Source namespace in key order.
 * @param {Record<string, unknown>} [params.existing] Committed target namespace.
 * @param {{name?: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}} params.provider Translation provider.
 * @param {string} [params.from] Source language code.
 * @param {string} params.to Target language code.
 * @param {boolean} [params.force] Retranslate every existing string.
 * @param {boolean} [params.dryRun] Return the pending keys without calling the provider.
 * @param {number} [params.batchSize] Strings per provider request.
 * @param {number} [params.retries] Transient retries per provider request.
 * @param {number} [params.baseDelayMs] First retry delay; doubles per attempt.
 * @param {(milliseconds: number) => Promise<void>} [params.sleep] Retry delay implementation.
 * @param {boolean} [params.retry] Wrap the provider with retry here. Production compositions that already retry each model pass `false`.
 * @returns {Promise<{result: Record<string, unknown> | null, pending: Array<{key: string, text: string}>, dryRun: boolean, stats: {translated: number, reused: number, skipped: number, failed: number}}>}
 * @throws {PlaceholderDriftError} When any translated value changes its placeholders.
 */
export async function generateNamespace({
  source,
  existing = {},
  provider,
  from = "en",
  to,
  force = false,
  dryRun = false,
  batchSize = 40,
  retries = 3,
  baseDelayMs = 500,
  sleep,
  retry = true,
}) {
  if (!to) throw new Error("a target language is required");

  const sourceEntries = Object.entries(source);
  const reused = [];
  const pending = [];
  let skipped = 0;
  for (const [key, value] of sourceEntries) {
    if (typeof value !== "string") {
      skipped += 1;
      continue;
    }
    const current = existing[key];
    if (!force && typeof current === "string" && current.trim() !== "") {
      reused.push([key, current]);
    } else {
      pending.push([key, value]);
    }
  }

  const reusedStats = { translated: 0, reused: reused.length, skipped, failed: 0 };
  if (dryRun) {
    return {
      result: null,
      pending: pending.map(([key, text]) => ({ key, text })),
      dryRun: true,
      stats: reusedStats,
    };
  }
  if (pending.length === 0) {
    return {
      result: assembleResult(sourceEntries, reused, new Map()),
      pending: [],
      dryRun: false,
      stats: reusedStats,
    };
  }

  if (typeof provider?.complete !== "function") {
    throw new Error("a translation provider with complete(prompt) is required");
  }

  const adapter = retry ? withRetry(provider, { retries, baseDelayMs, sleep }) : provider;
  const translations = await translateStrings(
    pending.map(([, text]) => text),
    { adapter, from, to, batchSize },
  );

  const drift = [];
  const translatedByKey = new Map();
  pending.forEach(([key, text], index) => {
    const translation = translations[index];
    const { ok, missing, added } = validatePlaceholders(text, translation, {
      format: PLACEHOLDER_FORMAT,
    });
    if (!ok || typeof translation !== "string" || translation.trim() === "") {
      drift.push({ key, missing, added });
      return;
    }
    translatedByKey.set(key, translation);
  });
  if (drift.length > 0) throw new PlaceholderDriftError(drift);

  return {
    result: assembleResult(sourceEntries, reused, translatedByKey),
    pending: pending.map(([key, text]) => ({ key, text })),
    dryRun: false,
    stats: {
      translated: pending.length,
      reused: reused.length,
      skipped,
      failed: 0,
    },
  };
}

/**
 * Rebuilds the target catalog in source key order, carrying non-string values
 * through and preferring the freshly generated translation over a reused value.
 *
 * @param {Array<[string, unknown]>} sourceEntries Source entries in insertion order.
 * @param {Array<[string, string]>} reused Prior non-empty target values.
 * @param {Map<string, string>} translatedByKey Newly generated values.
 * @returns {Record<string, unknown>} Target catalog.
 */
function assembleResult(sourceEntries, reused, translatedByKey) {
  const reusedByKey = new Map(reused);
  const result = {};
  for (const [key, value] of sourceEntries) {
    if (typeof value !== "string") result[key] = value;
    else if (translatedByKey.has(key)) result[key] = translatedByKey.get(key);
    else result[key] = reusedByKey.get(key);
  }
  return result;
}

/**
 * Serializes a catalog with stable two-space indentation and a trailing newline,
 * matching the committed locale files.
 *
 * @param {Record<string, unknown>} catalog Catalog in source key order.
 * @returns {string} JSON file content.
 */
export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/**
 * Writes a catalog atomically: serialize, write a sibling temporary file, then
 * rename over the target. A failed run leaves the committed file byte-identical.
 *
 * @param {string} path Target locale file path.
 * @param {Record<string, unknown>} catalog Catalog in source key order.
 * @returns {Promise<void>}
 */
export async function writeCatalogAtomic(path, catalog) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, serializeCatalog(catalog), "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
