import { useCallback } from "react";
import { Outlet, useNavigate } from "react-router";

import { NavigationShell } from "@/components/layout/navigation-shell";
import {
  resolveWorkspaceView,
  usePathname,
  workspaceViewPath,
  type WorkspaceView,
} from "@/lib/navigation";
import { WorkspaceProvider } from "@/context/workspace.context";

import { AppProviders } from "../providers";

type DashboardLayoutProps = Readonly<{
  children?: React.ReactNode;
}>;

/**
 * Inner presentation shell for the authenticated workspace.
 *
 * Mounts the `NavigationShell` (collapsible sidebar, mobile header and Dialog
 * drawer) around the routed view, translating between React Router locations
 * and the `WorkspaceView`/`onNavigate` contract via the canonical
 * `WORKSPACE_NAV_ITEMS` descriptor. The routed view renders through the
 * standard nested-route `<Outlet />` fallback inside the shell's persistent
 * main content column, so navigation swaps the routed child directly.
 * Destination chunks warm only on navigation intent rather than downloading
 * every workspace tool when the shell mounts.
 *
 * @param props.children - Optional explicit children; when omitted, the
 *   nested-route `<Outlet />` is rendered.
 * @returns React element rendering the workspace layout structure.
 */
function WorkspaceShell({ children }: DashboardLayoutProps): React.ReactElement {
  const pathname = usePathname();
  const navigate = useNavigate();
  const currentView = resolveWorkspaceView(pathname);

  const handleNavigate = useCallback(
    (view: WorkspaceView, options?: { search?: string }) => {
      const query = options?.search
        ? options.search.startsWith("?")
          ? options.search
          : `?${options.search}`
        : "";
      navigate(`${workspaceViewPath(view)}${query}`);
    },
    [navigate],
  );

  return (
    <NavigationShell currentView={currentView} onNavigate={handleNavigate}>
      {children ?? <Outlet />}
    </NavigationShell>
  );
}

/**
 * Layout wrapper providing the workspace-scoped provider context for all workspace routes.
 *
 * The `AuthenticatedShell` route element mounts this layout as a lazy chunk only
 * after the session resolves to signed-in (`AuthBoundary` + `RequireAuth` live in
 * `app/authenticated-shell.tsx`), so the navigation shell, sidebar, and query
 * providers never download for unauthenticated visitors. Chains `AppProviders`
 * (per-workspace query cache) and `WorkspaceProvider` (workspace context over the
 * Better Auth session and Meltiply data) before rendering the navigation shell.
 *
 * @param props.children - Optional explicit children; defaults to the nested
 *   route `Outlet`.
 * @returns React element rendering the authenticated workspace layout.
 */
export default function DashboardLayout({ children }: DashboardLayoutProps): React.ReactElement {
  return (
    <AppProviders>
      <WorkspaceProvider>
        <WorkspaceShell>{children}</WorkspaceShell>
      </WorkspaceProvider>
    </AppProviders>
  );
}
