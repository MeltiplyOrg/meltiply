/**
 * Optional UI state for the DevBox dock.
 *
 * Functional consent enables a single versioned localStorage record for dock
 * position, collapsed/hidden state, active tab, and network latency selection.
 * Every field is validated on read so stale or hand-edited data cannot crash
 * the dock; without consent, the same controls remain session-local.
 */

import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

export type DevBoxTab = "skeletons" | "benchmark" | "trace" | "helpers" | "preview";

export const devBoxTabs: readonly DevBoxTab[] = [
  "skeletons",
  "benchmark",
  "trace",
  "helpers",
  "preview",
];

/**
 * Artificial network latency applied to every `fetch` while DevBox is mounted.
 * `"infinite"` holds requests forever (used to keep skeletons pinned); finite
 * values delay each request by that many milliseconds.
 */
export type DevBoxLatency = 0 | 300 | 1500 | "infinite";

const devBoxLatencies: readonly DevBoxLatency[] = [0, 300, 1500, "infinite"];

export interface DevBoxPosition {
  x: number;
  y: number;
}

export interface DevBoxSize {
  width: number;
  height: number;
}

export interface DevBoxViewport {
  width: number;
  height: number;
}

/**
 * Clamps a dock position so its measured box stays fully inside the viewport.
 * When the dock is larger than the viewport, the result pins it to the top-left
 * corner instead of producing a negative offset.
 *
 * @param position Persisted or pointer-derived top-left position.
 * @param size Measured dock dimensions, including borders.
 * @param viewport Current viewport dimensions.
 * @returns A finite position whose dock box cannot extend past any edge.
 */
export function clampDevBoxPosition(
  position: DevBoxPosition,
  size: DevBoxSize,
  viewport: DevBoxViewport,
): DevBoxPosition {
  return {
    x: Math.min(Math.max(0, position.x), Math.max(0, viewport.width - size.width)),
    y: Math.min(Math.max(0, position.y), Math.max(0, viewport.height - size.height)),
  };
}

/**
 * Validates a persisted position, rejecting non-finite numbers so malformed
 * storage cannot produce an unclampable `left`/`top`.
 */
function readPosition(value: unknown): DevBoxPosition | null {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as Partial<DevBoxPosition>;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : null;
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
    const position = readPosition(parsed.position);
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
