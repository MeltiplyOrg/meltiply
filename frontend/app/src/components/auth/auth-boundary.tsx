import React from "react";

import { AppAuthProvider, useMeltiplyAuth } from "./auth-provider";
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

export interface AuthBoundaryProps {
  children: React.ReactNode;
}

/**
 * Session-resolution gate content.
 *
 * Renders the shared `WorkspaceLoadingSkeleton` while the Better Auth session
 * initializes, so the pre-session frame is the same shape as the route Suspense
 * fallback and the shell that follows - no centered text notice standing in for
 * a workspace. The skeleton carries its own polite status label.
 *
 * @param props.children - Authenticated route content to render once session resolves.
 * @returns Children if loaded, or the boot frame.
 */
function AuthBoundaryContent({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isLoaded } = useMeltiplyAuth();

  if (!isLoaded) {
    return <WorkspaceLoadingSkeleton />;
  }

  return <>{children}</>;
}

/**
 * Route-scoped authentication boundary wrapping protected application sections.
 * Wraps children in the `AppAuthProvider` and coordinates session resolution state.
 *
 * @param props.children - Authenticated route content to render once authentication initializes.
 * @returns The wrapped auth provider hierarchy.
 */
export function AuthBoundary({ children }: AuthBoundaryProps): React.ReactElement {
  return (
    <AppAuthProvider>
      <AuthBoundaryContent>{children}</AuthBoundaryContent>
    </AppAuthProvider>
  );
}
