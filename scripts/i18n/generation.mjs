import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { translateStrings, validatePlaceholders } from "@shipi18n/core";

import { withRetry } from "./retry.mjs";

const PLACEHOLDER_FORMAT = "brace";

export class PlaceholderDriftError extends Error {
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

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

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
