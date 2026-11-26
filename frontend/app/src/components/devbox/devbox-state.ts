import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

export type DevBoxTab = "skeletons" | "trace" | "helpers" | "routes" | "preview";

export const devBoxTabs: readonly DevBoxTab[] = [
  "skeletons",
  "trace",
  "helpers",
  "routes",
  "preview",
];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevBoxTab(value: unknown): value is DevBoxTab {
  return typeof value === "string" && devBoxTabs.some((tab) => tab === value);
}

function isDevBoxLatency(value: unknown): value is DevBoxLatency {
  return devBoxLatencies.some((item) => item === value);
}

function readPosition(value: unknown): DevBoxPosition | null {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : null;
}

export interface DevBoxState {
  hidden: boolean;
  collapsed: boolean;
  tab: DevBoxTab;
  position: DevBoxPosition | null;
  latency: DevBoxLatency;
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

export function readDevBoxState(): DevBoxState {
  const raw = readFunctionalStorage(devBoxStorageKey);
  if (!raw) return defaultDevBoxState;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultDevBoxState;
    const position = readPosition(parsed.position);
    return {
      hidden: parsed.hidden === true,
      collapsed: parsed.collapsed !== false,
      tab: isDevBoxTab(parsed.tab) ? parsed.tab : defaultDevBoxState.tab,
      position,
      latency: isDevBoxLatency(parsed.latency) ? parsed.latency : defaultDevBoxState.latency,
      agentation: parsed.agentation === true,
    };
  } catch {
    return defaultDevBoxState;
  }
}

export function writeDevBoxState(state: DevBoxState): void {
  writeFunctionalStorage(devBoxStorageKey, JSON.stringify(state));
}
