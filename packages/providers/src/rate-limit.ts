import type { Platform } from "@meltiply/domain";

import { MAX_RETRY_AFTER_SECONDS } from "./failures";
import type { RateLimitBudget } from "./types";
import { record } from "./values";

export type { RateLimitBudget } from "./types";

const integerHeaderPattern = /^\d{1,12}$/;
const usageCeiling = 100;
const usageMetrics = ["call_count", "total_cputime", "total_time"] as const;
const maxUsageHeaderCharacters = 8_192;
const maxRemainingCalls = 1_000_000_000;

function knownBudget(budget: RateLimitBudget): RateLimitBudget | null {
  return budget.percentUsed === null && budget.remaining === null && budget.resetsInSeconds === null
    ? null
    : budget;
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, usageCeiling)
    : null;
}

function integerHeader(value: string | null, maximum: number): number | null {
  const normalized = value?.trim();
  if (!normalized || !integerHeaderPattern.test(normalized)) return null;
  const parsed = Number(normalized);
  return parsed <= maximum ? parsed : null;
}

function usageJson(value: string | null): unknown {
  if (!value || value.length > maxUsageHeaderCharacters) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function metaUsageRecords(headers: Headers): Record<string, unknown>[] {
  const usages: Record<string, unknown>[] = [];
  const appUsage = record(usageJson(headers.get("x-app-usage")));
  if (appUsage) usages.push(appUsage);
  const businessUsage = record(usageJson(headers.get("x-business-use-case-usage")));
  for (const entries of Object.values(businessUsage ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const usage = record(entry);
      if (usage) usages.push(usage);
    }
  }
  return usages;
}

function metaBudget(headers: Headers): RateLimitBudget | null {
  let percentUsed: number | null = null;
  let exhausted = false;
  for (const usage of metaUsageRecords(headers)) {
    for (const metric of usageMetrics) {
      const value = percentage(usage[metric]);
      if (value === null) continue;
      if (value >= usageCeiling) exhausted = true;
      if (metric === "call_count") {
        percentUsed = Math.max(percentUsed ?? 0, value);
      }
    }
  }
  return knownBudget({
    percentUsed,
    remaining: exhausted ? 0 : null,
    resetsInSeconds: null,
  });
}

function standardBudget(headers: Headers): RateLimitBudget | null {
  return knownBudget({
    percentUsed: null,
    remaining: integerHeader(headers.get("x-ratelimit-remaining"), maxRemainingCalls),
    resetsInSeconds: integerHeader(headers.get("x-ratelimit-reset"), MAX_RETRY_AFTER_SECONDS),
  });
}

export function extractRateLimitBudget(
  platform: Platform,
  headers: Headers,
): RateLimitBudget | null {
  switch (platform) {
    case "facebook":
    case "instagram":
    case "threads":
      return metaBudget(headers);
    case "tiktok":
    case "youtube":
      return standardBudget(headers);
  }
}
