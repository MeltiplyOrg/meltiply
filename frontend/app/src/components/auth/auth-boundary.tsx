import React from "react";

import { AppAuthProvider, useMeltiplyAuth } from "./auth-provider";
import { useI18n } from "@/lib/i18n";

export interface AuthBoundaryProps {
  children: React.ReactNode;
}

/**
 * Centered accessible loading placeholder rendered while session state initializes.
 * Uses the shared secondary-ink token so it remains legible in either theme.
 *
 * @returns A full-screen container with an accessible polite status message.
 */
function AuthLoadingNotice(): React.ReactElement {
  const { t } = useI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
      <div role="status" aria-live="polite" className="text-center">
        <p className="text-sm text-ink-2">{t("Loading account…")}</p>
      </div>
    </main>
  );
}

/**
 * Inner boundary content gate checking session loading readiness before rendering children.
 *
 * @param props.children - Authenticated route content to render once session resolves.
 * @returns Children if loaded, or AuthLoadingNotice placeholder.
 */
function AuthBoundaryContent({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isLoaded } = useMeltiplyAuth();

  if (!isLoaded) {
    return <AuthLoadingNotice />;
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
