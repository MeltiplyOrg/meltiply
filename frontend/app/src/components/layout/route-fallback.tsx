import { Skeleton } from "@meltiply/ui/skeleton";
import { useI18n } from "@/lib/i18n";

/**
 * Route-level React Suspense fallback placeholder.
 * Shown while a lazy-loaded route module chunk is downloading over the network.
 * Mirrors the general dashboard shell geometry (heading bar, 3-column grid, and main panel)
 * so that route transitions avoid jarring layout shifts or regressions to plain text spinners.
 * Includes a screen-reader accessible polite `role="status"` label.
 *
 * @returns A full-height container element structured with placeholder skeleton blocks.
 */
export function RouteFallback(): React.ReactElement {
  const { t } = useI18n();

  return (
    <div
      className="flex min-h-screen flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-6"
      role="status"
    >
      <span className="sr-only">{t("Loading Meltiply…")}</span>
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
