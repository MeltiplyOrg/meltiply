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

  /** Notifies every mounted viewport after a committed notification-list change. */
  emit() {
    for (const fn of this.listeners) fn();
  },

  /** Replaces the immutable list snapshot and synchronously notifies subscribed viewports. */
  update(fn: (prev: SileoItem[]) => SileoItem[]) {
    this.toasts = fn(this.toasts);
    this.emit();
  },
};

/**
 * Subscribes a React store consumer to toast list changes.
 *
 * @param listener - Callback invoked whenever `store.toasts` updates.
 * @returns Cleanup function removing the listener.
 */
export function subscribeStore(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

/**
 * Returns the live client toast array for `useSyncExternalStore`.
 *
 * @returns Current toast array in the global Sileo store.
 */
export function getStoreSnapshot(): SileoItem[] {
  return store.toasts;
}

/**
 * Returns a stable empty array during SSR before hydration.
 *
 * @returns Empty `SileoItem` list.
 */
export function getServerStoreSnapshot(): SileoItem[] {
  return EMPTY_TOASTS;
}

/**
 * Marks a toast instance as exiting and removes it after the exit transition.
 * Matching runs on `instanceId` rather than the shared `id` so a replacement
 * emitted under the same `id` during `EXIT_DURATION` is never swept out by
 * the exiting instance's delayed removal.
 *
 * @param item - Exact `SileoItem` record to dismiss.
 */
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

/**
 * Computes expand and collapse delays for a toast's autopilot cycle, clamped
 * to the toast's total lifetime.
 *
 * @param opts - Toast options including optional autopilot overrides.
 * @param duration - Total toast visibility duration in milliseconds, or null for persistent toasts.
 * @returns Resolved `expandDelayMs` and `collapseDelayMs` values.
 */
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

/**
 * Constructs a normalized `SileoItem` record with a fresh `instanceId` so
 * repeated emissions to the same `id` trigger Sileo's morphing refresh cycle.
 *
 * @param merged - Merged global and callsite options.
 * @param id - Target toast identifier.
 * @returns Complete `SileoItem` entry ready for store insertion.
 */
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

/**
 * Creates or morphs an existing toast in the shared Sileo store.
 *
 * @param options - Toast content, state, and timing configuration.
 * @returns Object containing the resolved toast `id` and `duration`.
 */
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

/**
 * Pushes action feedback into the shared Sileo store. A headline and meaningful
 * supporting detail are required so every notification can expand and morph;
 * descriptions identify the affected object, copied value, or recovery action.
 *
 * @param title - Short outcome headline (e.g. "Post scheduled").
 * @param options.description - Supporting detail shown in the expanded body.
 * @param options.variant - Semantic state (`default` maps to `info`).
 */
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
