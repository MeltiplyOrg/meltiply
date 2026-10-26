// Bounded Worker-local retention for successful analytics summaries.
//
// The API owns one cache per service instance. Entries carry an absolute
// expiration, so a read never extends freshness, and the cache retains only
// serializable summary data: never HTTP responses, transactions, request
// contexts, or mutable objects shared with callers. Restarts and eviction only
// cause canonical recomputation.

import type { Exit } from "effect";
import type { components } from "@meltiply/contracts/schema";

import type { CoreServiceError } from "./core-types";

type AnalyticsSummary = components["schemas"]["AnalyticsSummary"];
type AnalyticsSummaryExit = Exit.Exit<AnalyticsSummary, CoreServiceError>;

/** Absolute lifetime of a retained successful analytics summary. */
const ANALYTICS_SUMMARY_TTL_MS = 30_000;

/** Maximum completed summaries retained in one configuration namespace. */
const ANALYTICS_SUMMARY_MAX_ENTRIES = 64;

/** Maximum UTF-8 JSON size of one admitted analytics summary. */
const ANALYTICS_SUMMARY_MAX_BYTES = 16 * 1024;

/** Maximum distinct pending summary computations retained per namespace. */
const ANALYTICS_SUMMARY_MAX_PENDING = 32;

const textEncoder = new TextEncoder();

interface RetainedAnalyticsSummary {
  expiresAt: number;
  value: AnalyticsSummary;
}

interface PendingAnalyticsSummary {
  readonly promise: Promise<AnalyticsSummaryExit>;
  readonly settle: (exit: AnalyticsSummaryExit) => void;
}

/** A leader settles one cold summary computation; authorized peers may join it. */
export interface AnalyticsSummaryFlight extends PendingAnalyticsSummary {
  readonly leader: boolean;
  readonly release: () => void;
}

/**
 * Bounded completed-result cache and pending-computation registry for one
 * Analytics configuration namespace.
 *
 * Admission accepts only summaries whose canonical JSON representation fits
 * 16 KiB, expiration is absolute from successful computation, and storage is
 * capped at 64 entries per namespace. Pending computations are capped at 32
 * distinct keys; equivalent requests may join at capacity. Reads and writes
 * clone values so callers cannot mutate retained data or later responses.
 */
export class AnalyticsSummaryCache {
  private readonly entries = new Map<string, RetainedAnalyticsSummary>();
  private readonly pending = new Map<string, PendingAnalyticsSummary>();
  private currentNamespace: string | undefined;

  /**
   * Selects the deployment/data-source and capability configuration namespace.
   *
   * Changing namespace clears completed and pending indexes, so configuration
   * replacement never accumulates independent caches. Existing waiters retain
   * their flight handle until its leader settles.
   *
   * @param namespace - Configuration scope for all subsequent reads and writes.
   */
  useNamespace(namespace: string): void {
    if (this.currentNamespace === namespace) return;
    this.entries.clear();
    this.pending.clear();
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
   * Joins an equivalent pending computation, starts one, or declines when
   * pending-key capacity is exhausted.
   *
   * Existing keys join even at capacity. New keys beyond 32 bypass coalescing
   * and perform the normal canonical read. Releasing a flight removes only its
   * own entry, so namespace changes cannot delete a newer operation.
   *
   * @param key - Canonical request identity within the active namespace.
   * @returns A leader/joiner handle, or undefined when the caller should bypass.
   */
  acquire(key: string): AnalyticsSummaryFlight | undefined {
    const existing = this.pending.get(key);
    if (existing) return { ...existing, leader: false, release: () => undefined };
    if (this.pending.size >= ANALYTICS_SUMMARY_MAX_PENDING) return undefined;

    let settle!: PendingAnalyticsSummary["settle"];
    const promise = new Promise<AnalyticsSummaryExit>((resolve) => {
      settle = resolve;
    });
    const pending: PendingAnalyticsSummary = { promise, settle };
    this.pending.set(key, pending);
    return {
      ...pending,
      leader: true,
      release: () => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      },
    };
  }

  /**
   * Retains an isolated copy of a successful summary for at most 30 seconds.
   *
   * Oversized, uncloneable, or obsolete-namespace values are not retained, and
   * a cache failure never escapes to the caller. Insertion drops expired
   * entries first, then evicts least-recently-used entries until the 64-entry
   * namespace bound has room.
   *
   * @param key - Canonical request identity within the active namespace.
   * @param summary - Successful canonical summary to retain.
   * @param nowMs - Successful computation instant in epoch milliseconds.
   * @param namespace - Namespace observed when the computation was authorized.
   */
  set(key: string, summary: AnalyticsSummary, nowMs: number, namespace: string): void {
    if (this.currentNamespace !== namespace) return;
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
