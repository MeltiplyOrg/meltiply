import type { WorkspaceView } from "@/components/primitives/sidebar-nav";

/** Route loaders share the router's import targets and the browser's module cache. */
const dashboardRouteImports: Record<WorkspaceView, () => Promise<unknown>> = {
  posts: () => import("@/app/(dashboard)/posts/page"),
  channels: () => import("@/app/(dashboard)/channels/page"),
  settings: () => import("@/app/(dashboard)/settings/page"),
};

/**
 * Warms only the destination a user hovers, focuses, or presses, avoiding downloads
 * of unrelated workspace tools. Repeated calls reuse the browser's module cache.
 * Speculative failures are ignored; actual navigation retains the router's error path.
 */
export function preloadDashboardRoute(view: WorkspaceView): void {
  void dashboardRouteImports[view]().catch(() => undefined);
}
