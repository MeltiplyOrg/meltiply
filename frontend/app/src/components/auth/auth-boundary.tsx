import React from "react";

import { AppAuthProvider, useMeltiplyAuth } from "./auth-provider";
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

export interface AuthBoundaryProps {
  children: React.ReactNode;
}

function AuthBoundaryContent({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isLoaded } = useMeltiplyAuth();

  if (!isLoaded) {
    return <WorkspaceLoadingSkeleton />;
  }

  return <>{children}</>;
}

export function AuthBoundary({ children }: AuthBoundaryProps): React.ReactElement {
  return (
    <AppAuthProvider>
      <AuthBoundaryContent>{children}</AuthBoundaryContent>
    </AppAuthProvider>
  );
}
