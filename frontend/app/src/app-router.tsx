import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";

import { AuthenticatedShell } from "@/app/authenticated-shell";
import { RouteFallback } from "@/components/layout/route-fallback";

const ChannelsPage = lazy(() => import("@/app/(dashboard)/channels/page"));
const PostsPage = lazy(() => import("@/app/(dashboard)/posts/page"));
const SignInRoute = lazy(() => import("@/app/sign-in-route"));
const SignUpRoute = lazy(() => import("@/app/sign-up-route"));

/**
 * Root routing component for the authenticated React application.
 *
 * The marketing site is served independently by the Astro landing project.
 * Protected workspace routes mount through `AuthenticatedShell`, which
 * resolves the session and redirects unauthenticated visitors to `/sign-in`
 * before the lazy dashboard layout chunk ever loads; unknown paths take the
 * same route.
 *
 * @returns React element rendering the active application route hierarchy.
 */
export function AppRouter(): React.ReactElement {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/posts" replace />} />
        <Route path="/sign-in/*" element={<SignInRoute />} />
        <Route path="/sign-up/*" element={<SignUpRoute />} />
        <Route element={<AuthenticatedShell />}>
          <Route path="/posts" element={<PostsPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/posts" replace />} />
      </Routes>
    </Suspense>
  );
}
