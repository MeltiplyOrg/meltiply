import { lazy } from "react";

import { AuthBoundary } from "@/components/auth/auth-boundary";
import { RequireAuth } from "@/components/auth/auth-provider";

/**
 * Lazy import for the workspace layout chunk (navigation shell, sidebar,
 * query providers, workspace context). The `lazy()` only resolves when the
 * component actually renders — which `RequireAuth` allows solely after a
 * session resolves to signed-in — so an unauthenticated visitor to a
 * protected path downloads just this auth gate plus the sign-in route,
 * never the workspace module graph.
 */
const DashboardLayout = lazy(() => import("@/app/(dashboard)/layout"));

/**
 * Route element wrapping the workspace layout in authentication gates.
 *
 * Mounts `AuthBoundary` (session provider with centered loading notice) and
 * `RequireAuth` (session gate that redirects unauthenticated visitors to
 * `/sign-in`) around the lazy `DashboardLayout`, keeping the entire
 * authenticated shell behind the session check. While the layout chunk
 * loads, the pending lazy component suspends to the route-level
 * `RouteFallback` Suspense boundary in `AppRouter`.
 *
 * @returns React element gating the workspace layout behind authentication.
 */
export function AuthenticatedShell(): React.ReactElement {
  return (
    <AuthBoundary>
      <RequireAuth>
        <DashboardLayout />
      </RequireAuth>
    </AuthBoundary>
  );
}
