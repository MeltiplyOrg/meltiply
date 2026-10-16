/**
 * Optional UI state for the DevBox dock.
 *
 * Functional consent enables a single versioned localStorage record for dock
 * position, collapsed/hidden state, active tab, and network latency selection.
 * Every field is validated on read so stale or hand-edited data cannot crash
 * the dock; without consent, the same controls remain session-local.
 */

import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

export type DevBoxTab = "skeletons" | "benchmark" | "trace" | "helpers";

export const devBoxTabs: readonly DevBoxTab[] = ["skeletons", "benchmark", "trace", "helpers"];

/**
 * Artificial network latency applied to every `fetch` while DevBox is mounted.
 * `"infinite"` holds requests forever (used to keep skeletons pinned); finite
 * values delay each request by that many milliseconds.
 */
export type DevBoxLatency = 0 | 300 | 1500 | "infinite";

const devBoxLatencies: readonly DevBoxLatency[] = [0, 300, 1500, "infinite"];

interface DevBoxPosition {
  x: number;
  y: number;
}

export interface DevBoxState {
  /** Dock fully hidden (revealed again via the keyboard shortcut). */
  hidden: boolean;
  /** Dock collapsed to the compact pill. */
  collapsed: boolean;
  /** Active tab while expanded. */
  tab: DevBoxTab;
  /** Bottom-left anchored dock position in viewport pixels, or null for the default slot. */
  position: DevBoxPosition | null;
  /** Selected artificial latency. */
  latency: DevBoxLatency;
  /** Whether the Agentation feedback toolbar is mounted. */
  agentation: boolean;
}

export const devBoxStorageKey = "meltiply.devbox";

const defaultDevBoxState: DevBoxState = {
  hidden: false,
  collapsed: true,
  tab: "skeletons",
  position: null,
  latency: 0,
  agentation: false,
};

/**
 * Reads the dock state only after functional consent, falling back field-by-field
 * to defaults when the record is missing, malformed, or from an older shape.
 *
 * @returns Validated `DevBoxState`; never throws on bad input.
 */
export function readDevBoxState(): DevBoxState {
  const raw = readFunctionalStorage(devBoxStorageKey);
  if (!raw) return defaultDevBoxState;
  try {
    const parsed = JSON.parse(raw) as Partial<DevBoxState> | null;
    if (!parsed || typeof parsed !== "object") return defaultDevBoxState;
    const position =
      parsed.position &&
      typeof parsed.position.x === "number" &&
      typeof parsed.position.y === "number"
        ? { x: parsed.position.x, y: parsed.position.y }
        : null;
    return {
      hidden: parsed.hidden === true,
      collapsed: parsed.collapsed !== false,
      tab: devBoxTabs.includes(parsed.tab as DevBoxTab)
        ? (parsed.tab as DevBoxTab)
        : defaultDevBoxState.tab,
      position,
      latency: devBoxLatencies.includes(parsed.latency as DevBoxLatency)
        ? (parsed.latency as DevBoxLatency)
        : defaultDevBoxState.latency,
      agentation: parsed.agentation === true,
    };
  } catch {
    // Malformed JSON falls back to defaults; the storage helper handles denied storage.
    return defaultDevBoxState;
  }
}

/**
 * Persists the dock state only after functional consent. Denied or unavailable
 * storage is non-fatal, so the dock remains usable for this session.
 */
export function writeDevBoxState(state: DevBoxState): void {
  writeFunctionalStorage(devBoxStorageKey, JSON.stringify(state));
}
