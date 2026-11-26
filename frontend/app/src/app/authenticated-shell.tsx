import { lazy } from "react";

import { AuthBoundary } from "@/components/auth/auth-boundary";
import { RequireAuth } from "@/components/auth/auth-provider";

const DashboardLayout = lazy(() => import("@/app/(dashboard)/layout"));

export function AuthenticatedShell(): React.ReactElement {
  return (
    <AuthBoundary>
      <RequireAuth>
        <DashboardLayout />
      </RequireAuth>
    </AuthBoundary>
  );
}
