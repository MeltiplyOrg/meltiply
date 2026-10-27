import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import {
  FrontendErrorBoundary,
  FrontendErrorFallback,
} from "@/components/layout/frontend-error-boundary";
import { SmoothScroll } from "@/components/layout/smooth-scroll";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { isDevMode, isUiPreview } from "@/lib/env";
import { installFrontendErrorLogging } from "@/lib/frontend-telemetry";
import { AppRouter } from "@/app-router";
import favicon from "@meltiply/ui/favicon.svg?url";
import { startPreview } from "./preview/browser";
import { PreviewControls } from "./preview/controls";

// Consent defaults are applied by the inline bootstrap before React. Load the
// interactive notice separately so its toast animation dependencies do not block
// the workspace/authentication first paint; a missing chunk never grants consent.
const CookieNotice = lazy(async () => {
  const { CookieNotice } = await import("@meltiply/ui/cookie-notice");
  return { default: CookieNotice };
});

const DevBox = isDevMode()
  ? lazy(async () => {
      const { DevBox } = await import("@/components/devbox/dev-box");
      return { default: DevBox };
    })
  : null;

/** Starts preview interception before any router/session work; production statically excludes the preview module. */
async function bootstrap(): Promise<void> {
  if (isUiPreview()) await startPreview();
  /** A data router lets security enrollment block SPA departures, including browser history. */
  const router = createBrowserRouter([
    { path: "*", element: <AppRouter />, errorElement: <FrontendErrorFallback /> },
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("Meltiply root element is missing.");

  installFrontendErrorLogging();

  createRoot(root).render(
    <StrictMode>
      <link rel="icon" type="image/svg+xml" href={favicon} />
      <ThemeProvider>
        <I18nProvider>
          <FrontendErrorBoundary>
            <SmoothScroll />
            <Suspense fallback={null}>
              <CookieNotice policyUrl="https://meltiply.com/docs/cookies" />
            </Suspense>
            <RouterProvider router={router} />
            {DevBox && (
              <Suspense fallback={null}>
                <DevBox previewControls={isUiPreview() ? <PreviewControls /> : undefined} />
              </Suspense>
            )}
          </FrontendErrorBoundary>
        </I18nProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("Frontend bootstrap failed", error);
  const root = document.getElementById("root");
  if (root) root.textContent = "The application could not start. Reload to try again.";
});
