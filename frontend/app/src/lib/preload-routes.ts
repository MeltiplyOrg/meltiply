import type { WorkspaceView } from "@/lib/navigation";

const dashboardRouteImports: Record<WorkspaceView, () => Promise<unknown>> = {
  posts: () => import("@/app/(dashboard)/posts/page"),
  analytics: () => import("@/app/(dashboard)/analytics/page"),
  channels: () => import("@/app/(dashboard)/channels/page"),
  queues: () => import("@/app/(dashboard)/queues/page"),
  settings: () => import("@/components/layout/workspace-settings"),
};

export function preloadDashboardRoute(view: WorkspaceView): void {
  void dashboardRouteImports[view]().catch(() => undefined);
}
