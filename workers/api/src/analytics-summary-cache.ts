// Bounded Worker-local retention for successful analytics summaries.
//
// The API owns one cache per service instance. Entries carry an absolute
// expiration, so a read never extends freshness, and the cache retains only
// serializable summary data: never HTTP responses, transactions, request
// contexts, or mutable objects shared with callers. Restarts and eviction only
// cause canonical recomputation.

import type { components } from "@meltiply/contracts/schema";

type AnalyticsSummary = components["schemas"]["AnalyticsSummary"];

/** Absolute lifetime of a retained successful analytics summary. */
const ANALYTICS_SUMMARY_TTL_MS = 30_000;

/** Maximum completed summaries retained in one configuration namespace. */
const ANALYTICS_SUMMARY_MAX_ENTRIES = 64;

/** Maximum UTF-8 JSON size of one admitted analytics summary. */
const ANALYTICS_SUMMARY_MAX_BYTES = 16 * 1024;

const textEncoder = new TextEncoder();

interface RetainedAnalyticsSummary {
  expiresAt: number;
  value: AnalyticsSummary;
}

/**
 * Bounded completed-result cache for one analytics configuration namespace.
 *
 * Admission accepts only summaries whose canonical JSON representation fits
 * 16 KiB, expiration is absolute from successful computation, and storage is
 * capped at 64 entries per namespace. When a slot is needed, expired entries
 * are dropped first and then the least-recently-used entry. Reads and writes
 * clone values so callers cannot mutate retained data or later responses.
 */
export class AnalyticsSummaryCache {
  private readonly entries = new Map<string, RetainedAnalyticsSummary>();
  private currentNamespace: string | undefined;

  /**
   * Selects the deployment/data-source and capability configuration namespace.
   *
   * Changing namespace clears every retained summary, so a configuration
   * change replaces the owned cache instead of accumulating independent
   * namespaces. Namespace cardinality therefore stays at most one.
   *
   * @param namespace - Configuration scope for all subsequent reads and writes.
   */
  useNamespace(namespace: string): void {
    if (this.currentNamespace === namespace) return;
    this.entries.clear();
    this.currentNamespace = namespace;
  }

  /**
   * Returns an isolated summary for `key` while its absolute TTL is unexpired.
   *
   * A hit refreshes least-recently-used order without moving `expiresAt`.
   * Missing, expired, or uncloneable entries resolve `undefined`, which makes
   * the caller take the canonical read path.
   *
   * @param key - Canonical request identity within the active namespace.
   * @param nowMs - Current epoch milliseconds from the caller's clock.
   * @returns Deep-cloned successful summary, or undefined on a miss.
   */
  get(key: string, nowMs: number): AnalyticsSummary | undefined {
    const retained = this.entries.get(key);
    if (retained === undefined) return undefined;
    if (retained.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, retained);
    try {
      return structuredClone(retained.value);
    } catch {
      this.entries.delete(key);
      return undefined;
    }
  }

  /**
   * Retains an isolated copy of a successful summary for at most 30 seconds.
   *
   * Oversized or uncloneable values are not retained, and a cache failure never
   * escapes to the caller: the canonical response is still returned. Insertion
   * drops expired entries first, then evicts least-recently-used entries until
   * the 64-entry namespace bound has room.
   *
   * @param key - Canonical request identity within the active namespace.
   * @param summary - Successful canonical summary to retain.
   * @param nowMs - Successful computation instant in epoch milliseconds.
   */
  set(key: string, summary: AnalyticsSummary, nowMs: number): void {
    try {
      const serialized = JSON.stringify(summary);
      if (serialized === undefined) return;
      if (textEncoder.encode(serialized).byteLength > ANALYTICS_SUMMARY_MAX_BYTES) return;
      const value = structuredClone(summary);
      for (const [retainedKey, retained] of this.entries) {
        if (retained.expiresAt <= nowMs) this.entries.delete(retainedKey);
      }
      this.entries.delete(key);
      while (this.entries.size >= ANALYTICS_SUMMARY_MAX_ENTRIES) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
      this.entries.set(key, {
        expiresAt: nowMs + ANALYTICS_SUMMARY_TTL_MS,
        value,
      });
    } catch {
      // A cache mechanism failure must fall back to canonical computation.
      this.entries.delete(key);
    }
  }
}
