import type { QueryClient } from "@tanstack/react-query";

/**
 * Registry bridging the app-scoped TanStack `QueryClient` to the DevBox dock.
 *
 * The dock mounts at the application root (outside the dashboard layout that
 * owns `QueryClientProvider`), so it cannot reach the client through React
 * context. `ScopedAppProviders` registers each per-workspace client here via
 * `DevBoxClientBridge`; DevBox tools (skeleton forcing, cache inspector) resolve
 * the current client through `getDevBoxQueryClient`.
 *
 * A subscription channel lets the dock re-render when a workspace switch swaps
 * the registered client.
 */

let currentClient: QueryClient | null = null;
const listeners = new Set<() => void>();

/**
 * Registers the active query client. Called by `DevBoxClientBridge` on mount;
 * pass `null` on unmount. Notifies subscribers so the dock reflects the swap.
 */
export function registerDevBoxQueryClient(client: QueryClient | null): void {
  if (currentClient === client) return;
  currentClient = client;
  for (const listener of listeners) listener();
}

/**
 * Returns the currently registered query client, or `null` when the dashboard
 * provider tree is not mounted (e.g. sign-in routes).
 */
export function getDevBoxQueryClient(): QueryClient | null {
  return currentClient;
}

/**
 * Subscribes to client registration changes; returns an unsubscribe function.
 * Used with `useSyncExternalStore` so the dock tracks workspace switches.
 */
export function subscribeDevBoxQueryClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
