import type { Exit } from "effect";
import type { components } from "@meltiply/contracts/schema";

import type { CoreServiceError } from "./core-types";
import { SingleFlightGroup, type SingleFlight } from "./single-flight";

type AnalyticsSummary = components["schemas"]["AnalyticsSummary"];
type AnalyticsSummaryExit = Exit.Exit<AnalyticsSummary, CoreServiceError>;

const ANALYTICS_SUMMARY_TTL_MS = 30_000;
const ANALYTICS_SUMMARY_MAX_ENTRIES = 64;
const ANALYTICS_SUMMARY_MAX_BYTES = 16 * 1024;
const ANALYTICS_SUMMARY_MAX_PENDING = 32;

const textEncoder = new TextEncoder();

interface RetainedAnalyticsSummary {
  expiresAt: number;
  value: AnalyticsSummary;
}

export type AnalyticsSummaryFlight = SingleFlight<AnalyticsSummaryExit>;

export class AnalyticsSummaryCache {
  private readonly entries = new Map<string, RetainedAnalyticsSummary>();
  private readonly flights = new SingleFlightGroup<AnalyticsSummaryExit>(
    ANALYTICS_SUMMARY_MAX_PENDING,
  );
  private currentNamespace: string | undefined;

  useNamespace(namespace: string): void {
    if (this.currentNamespace === namespace) return;
    this.entries.clear();
    this.flights.clear();
    this.currentNamespace = namespace;
  }

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

  acquire(key: string): AnalyticsSummaryFlight | undefined {
    return this.flights.acquire(key);
  }

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
      this.entries.delete(key);
    }
  }
}
