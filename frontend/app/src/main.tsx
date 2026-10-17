import { CookieNotice } from "@meltiply/ui/cookie-notice";

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { FrontendErrorBoundary } from "@/components/layout/frontend-error-boundary";
import { SmoothScroll } from "@/components/layout/smooth-scroll";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { isDevMode } from "@/lib/env";
import { installFrontendErrorLogging } from "@/lib/frontend-telemetry";
import { AppRouter } from "@/app-router";
import favicon from "@meltiply/ui/favicon.svg?url";

const DevBox = isDevMode()
  ? lazy(async () => {
      const { DevBox } = await import("@/components/devbox/dev-box");
      return { default: DevBox };
    })
  : null;

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
          <CookieNotice policyUrl="https://meltiply.com/docs/cookies" />
          <BrowserRouter>
            <AppRouter />
          </BrowserRouter>
          {DevBox && (
            <Suspense fallback={null}>
              <DevBox />
            </Suspense>
          )}
        </FrontendErrorBoundary>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
