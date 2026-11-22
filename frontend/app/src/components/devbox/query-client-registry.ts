import type { QueryClient } from "@tanstack/react-query";

let currentClient: QueryClient | null = null;
const listeners = new Set<() => void>();

export function registerDevBoxQueryClient(client: QueryClient | null): void {
  if (currentClient === client) return;
  currentClient = client;
  for (const listener of listeners) listener();
}

export function getDevBoxQueryClient(): QueryClient | null {
  return currentClient;
}

export function subscribeDevBoxQueryClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
