import type { Platform } from "@meltiply/domain";

import { record } from "./meta-common";

/** Meta usage headers are percentages; at the ceiling the caller is throttled. */
const usageCeiling = 100;
const usageMetrics = ["call_count", "total_cputime", "total_time"] as const;
/** Bound untrusted header JSON before parsing it. */
const maxUsageHeaderCharacters = 8_192;
const maxRemainingCalls = 1_000_000_000;
const maxResetSeconds = 86_400;

export interface RateLimitBudget {
  /** Percentage of budget used (0-100, null if unknown) */
  percentUsed: number | null;
  /** Remaining calls in this window (null if unknown) */
  remaining: number | null;
  /** Seconds until the budget resets (null if unknown) */
  resetsInSeconds: number | null;
}

/**
 * Drops empty budget descriptors that carry no usable rate limit telemetry.
 * If all metrics (percentUsed, remaining, resetsInSeconds) are null, collapses to null.
 * Returns the budget if any metric is known, or null otherwise.
 */
function knownBudget(budget: RateLimitBudget): RateLimitBudget | null {
  return budget.percentUsed === null && budget.remaining === null && budget.resetsInSeconds === null
    ? null
    : budget;
}

/**
 * Clamps a provider-reported rate limit usage percentage into the valid [0, 100] range.
 * Rejects negative, non-numeric, or non-finite inputs.
 * Returns clamped numeric percentage between 0 and 100, or null if invalid.
 */
function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, usageCeiling)
    : null;
}

/**
 * Parses a non-negative integer header value bounded by a maximum ceiling.
 * Rejects empty, non-digit, signed, floating-point, or out-of-range values.
 * Returns parsed integer up to maximum, or null if absent or invalid.
 */
function integerHeader(value: string | null, maximum: number): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d{1,12}$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return parsed <= maximum ? parsed : null;
}

/**
 * Parses a rate-limit header JSON string with strict length bounding (8 KiB).
 * Prevents JSON parsing denial-of-service from oversized untrusted headers.
 * Returns parsed JSON structure, or undefined if missing, oversized, or malformed.
 */
function usageJson(value: string | null): unknown {
  if (!value || value.length > maxUsageHeaderCharacters) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Extracts and aggregates Meta Graph API rate limit usage objects from response headers.
 * Combines app-level scope (`x-app-usage`) and all business asset entries (`x-business-use-case-usage`).
 * Returns array of usage record objects.
 */
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

/**
 * Computes a standardized RateLimitBudget from Meta Graph API percentage usage headers.
 * Evaluates `call_count`, `total_cputime`, and `total_time` against the 100% ceiling;
 * marks remaining as 0 if exhausted, and derives percentUsed from max `call_count`.
 * Returns RateLimitBudget or null if no usage headers are present.
 */
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

/**
 * Parses standard rate limit headers (`x-ratelimit-remaining` and `x-ratelimit-reset`).
 * Used for providers adhering to RFC rate limit conventions such as TikTok and YouTube.
 * Returns RateLimitBudget with remaining call count and seconds-to-reset, or null if unannounced.
 */
function standardBudget(headers: Headers): RateLimitBudget | null {
  return knownBudget({
    percentUsed: null,
    remaining: integerHeader(headers.get("x-ratelimit-remaining"), maxRemainingCalls),
    resetsInSeconds: integerHeader(headers.get("x-ratelimit-reset"), maxResetSeconds),
  });
}

/**
 * Extracts and normalizes provider-specific rate limit telemetry from HTTP response headers.
 * Routes Meta platforms (Facebook, Instagram, Threads) to percentage parsers,
 * and standard platforms (TikTok, YouTube) to header count/reset parsers.
 * Returns RateLimitBudget or null when no rate limit signals are present.
 */
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
