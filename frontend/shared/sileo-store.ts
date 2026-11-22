import type { ReactNode } from "react";
export type SileoState = "success" | "loading" | "error" | "warning" | "info" | "action";

export interface SileoStyles {
  title?: string;
  description?: string;
  badge?: string;
  button?: string;
}

export interface SileoButton {
  title: string;
  onClick: () => void;
}

export interface SileoOptions {
  id?: string;
  title?: string;
  description?: ReactNode | string;
  type?: SileoState;
  duration?: number | null;
  icon?: ReactNode | null;
  styles?: SileoStyles;
  fill?: string;
  roundness?: number;
  autopilot?: boolean | { expand?: number; collapse?: number };
  button?: SileoButton;
}
export const DEFAULT_TOAST_DURATION = 5000;
const EXIT_DURATION = 600;
const AUTO_EXPAND_DELAY = 120;
const AUTO_COLLAPSE_DELAY = 3600;
interface InternalSileoOptions extends SileoOptions {
  id?: string;
  state?: SileoState;
}

export interface SileoItem extends InternalSileoOptions {
  id: string;
  instanceId: string;
  exiting?: boolean;
  autoExpandDelayMs?: number;
  autoCollapseDelayMs?: number;
}

const EMPTY_TOASTS: SileoItem[] = [];
let idCounter = 0;

export const store = {
  toasts: EMPTY_TOASTS as SileoItem[],
  listeners: new Set<() => void>(),
  options: undefined as Partial<SileoOptions> | undefined,

  emit() {
    for (const fn of this.listeners) fn();
  },

  update(fn: (prev: SileoItem[]) => SileoItem[]) {
    this.toasts = fn(this.toasts);
    this.emit();
  },
};

export function subscribeStore(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function getStoreSnapshot(): SileoItem[] {
  return store.toasts;
}

export function getServerStoreSnapshot(): SileoItem[] {
  return EMPTY_TOASTS;
}

export function dismissToast(item: SileoItem): void {
  const live = store.toasts.find((t) => t.instanceId === item.instanceId);
  if (!live || live.exiting) return;

  store.update((prev) =>
    prev.map((t) => (t.instanceId === item.instanceId ? { ...t, exiting: true } : t)),
  );

  setTimeout(
    () => store.update((prev) => prev.filter((t) => t.instanceId !== item.instanceId)),
    EXIT_DURATION,
  );
}

function resolveAutopilot(
  opts: InternalSileoOptions,
  duration: number | null,
): { expandDelayMs?: number; collapseDelayMs?: number } {
  if (opts.autopilot === false || !duration || duration <= 0) return {};
  const cfg = typeof opts.autopilot === "object" ? opts.autopilot : undefined;
  const clamp = (v: number) => Math.min(duration, Math.max(0, v));
  return {
    expandDelayMs: clamp(cfg?.expand ?? AUTO_EXPAND_DELAY),
    collapseDelayMs: clamp(cfg?.collapse ?? AUTO_COLLAPSE_DELAY),
  };
}

function buildSileoItem(merged: InternalSileoOptions, id: string): SileoItem {
  const duration = merged.duration === undefined ? DEFAULT_TOAST_DURATION : merged.duration;
  const auto = resolveAutopilot(merged, duration);
  return {
    ...merged,
    id,
    instanceId: `${++idCounter}-${Date.now().toString(36)}`,
    autoExpandDelayMs: auto.expandDelayMs,
    autoCollapseDelayMs: auto.collapseDelayMs,
  };
}

function createToast(options: InternalSileoOptions): {
  id: string;
  duration: number | null;
} {
  const live = store.toasts.filter((t) => !t.exiting);
  const merged: InternalSileoOptions = {
    ...store.options,
    ...options,
    styles: { ...store.options?.styles, ...options.styles },
  };

  const id = merged.id ?? "sileo-default";
  const item = buildSileoItem(merged, id);

  if (live.some((item) => item.id === id)) {
    store.update((p) => p.map((t) => (t.id === id ? item : t)));
  } else {
    store.update((p) => [...p.filter((t) => t.id !== id), item]);
  }
  return {
    id,
    duration: merged.duration === undefined ? DEFAULT_TOAST_DURATION : merged.duration,
  };
}

type ToastVariant = "default" | "success" | "error" | "warning" | "info";

export function toast(
  title: string,
  options: { description: string; variant?: ToastVariant },
): void {
  const variant = options.variant ?? "default";
  const state: SileoState = variant === "default" ? "info" : variant;
  createToast({
    title,
    description: options.description,
    state,
  });
}
