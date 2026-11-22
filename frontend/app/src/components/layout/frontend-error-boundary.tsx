import { Component, type ReactNode } from "react";

import { Button } from "@meltiply/ui/button";

import { reportFrontendError } from "@/lib/frontend-telemetry";
import { useI18n } from "@/lib/i18n";

type FrontendErrorBoundaryProps = {
  children: ReactNode;
};

type FrontendErrorBoundaryState = {
  hasError: boolean;
};

export function FrontendErrorFallback(): React.ReactElement {
  const { t } = useI18n();

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
      <section
        role="alert"
        aria-labelledby="frontend-error-heading"
        className="w-full max-w-lg rounded-card border border-line bg-surface p-8 shadow-card sm:p-10"
      >
        <h1 id="frontend-error-heading" className="text-2xl font-semibold tracking-tight text-ink">
          {t("An error has occurred.")}
        </h1>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            variant="default"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-11 items-center justify-center rounded-control bg-ink px-5 text-sm font-medium text-surface transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t("Reload workspace")}
          </Button>
          <a
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong px-5 text-sm font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t("Return to overview")}
          </a>
        </div>
      </section>
    </main>
  );
}

export class FrontendErrorBoundary extends Component<
  FrontendErrorBoundaryProps,
  FrontendErrorBoundaryState
> {
  state: FrontendErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): FrontendErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    reportFrontendError(error, "react-render");
  }

  render(): ReactNode {
    return this.state.hasError ? <FrontendErrorFallback /> : this.props.children;
  }
}
