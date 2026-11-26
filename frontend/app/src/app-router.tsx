import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";

import { AuthenticatedShell } from "@/app/authenticated-shell";
import { AuthBoundary } from "@/components/auth/auth-boundary";
import { RequireAuth } from "@/components/auth/auth-provider";
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

const AnalyticsPage = lazy(() => import("@/app/(dashboard)/analytics/page"));
const ChannelsPage = lazy(() => import("@/app/(dashboard)/channels/page"));
const ChannelConnectPage = lazy(() => import("@/app/channel-connect-route"));
const DeviceConsentRoute = lazy(() => import("@/app/device-consent-route"));
const PostsPage = lazy(() => import("@/app/(dashboard)/posts/page"));
const QueuesPage = lazy(() => import("@/app/(dashboard)/queues/page"));
const SettingsPage = lazy(() => import("@/components/layout/workspace-settings"));
const InvitationAcceptRoute = lazy(() => import("@/app/invitation-accept-route"));
const SignInRoute = lazy(() => import("@/app/sign-in-route"));

export function AppRouter(): React.ReactElement {
  return (
    <Suspense fallback={<WorkspaceLoadingSkeleton />}>
      <Routes>
        <Route path="/" element={<Navigate to="/posts" replace />} />
        <Route path="/sign-in/*" element={<SignInRoute />} />
        <Route
          path="/channels/connect"
          element={
            <AuthBoundary>
              <RequireAuth>
                <ChannelConnectPage />
              </RequireAuth>
            </AuthBoundary>
          }
        />
        <Route path="/invitations/accept" element={<InvitationAcceptRoute />} />
        <Route path="/device" element={<DeviceConsentRoute />} />
        <Route element={<AuthenticatedShell />}>
          <Route path="/posts" element={<PostsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/posts" replace />} />
      </Routes>
    </Suspense>
  );
}
