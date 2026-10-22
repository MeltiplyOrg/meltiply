import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, TriangleAlert } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@meltiply/ui/card";
import { Empty, EmptyDescription, EmptyIcon, EmptyTitle } from "@meltiply/ui/empty";
import { Skeleton } from "@meltiply/ui/skeleton";
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import { usePathname, useSearchParams } from "@/lib/navigation";
import { platformDisplayName } from "@/lib/platforms";
import {
  useAnalyticsPosts,
  useAnalyticsDashboard,
  useAnalyticsSummary,
  usePlatformCapabilities,
  usePlatforms,
} from "@/lib/queries";
import {
  ANALYTICS_INITIAL_LIMIT,
  formatAnalyticsSearchParams,
  formatAnalyticsTimestamp,
  isAnalyticsStale,
  nextAnalyticsLimit,
  parseAnalyticsSearchParams,
  resolveAnalyticsEmptyState,
} from "./analytics-helpers";
import { AnalyticsToolbar, analyticsRangeLabel } from "./analytics-toolbar";
import { MetricCards } from "./metric-cards";
import {
  AccumulationChart,
  BestTimeHeatmap,
  ContentFormatBreakdown,
  EngagementOverTimeChart,
  FollowerEvolutionChart,
  FrequencyScatterChart,
  MetricOverTimeChart,
  PlatformBreakdownTable,
  PostsOverTimeChart,
  PostsPerPlatformChart,
} from "./analytics-insights";
import { comparablePlatformRows, PlatformMetricChart } from "./platform-metric-chart";
import { TopPostsTable } from "./top-posts-table";
import type { Platform } from "@/types";

/** Scrollable page body shared by every resolved state, keeping the header fixed. */
function AnalyticsBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-lenis-prevent>
      <div className="flex w-full flex-col gap-3 px-4 pb-8 pt-3 sm:px-6">{children}</div>
    </div>
  );
}

/** Skeleton that preserves the KPI, chart, and table geometry while data loads. */
function AnalyticsLoadingSkeleton() {
  return (
    <AnalyticsBody>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-[68px] rounded-control" />
        ))}
      </div>
      <Skeleton className="h-3 w-80 max-w-full" />
      <Skeleton className="h-72 rounded-card" />
      <Skeleton className="h-80 rounded-card" />
    </AnalyticsBody>
  );
}

/** One cohort empty state; the no-capable-channel variant links to Channels. */
function AnalyticsEmpty({
  title,
  description,
  showChannelsLink = false,
}: {
  title: string;
  description: string;
  showChannelsLink?: boolean;
}) {
  const { t } = useI18n();
  return (
    <AnalyticsBody>
      <Empty>
        <EmptyIcon>
          <BarChart3 className="size-5" />
        </EmptyIcon>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
        {showChannelsLink && (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link to="/channels">{t("Open Channels")}</Link>
          </Button>
        )}
      </Empty>
    </AnalyticsBody>
  );
}

/**
 * Standalone Analytics route.
 *
 * Read-only and scoped by the active Brand Profile (or the All Brand Profiles
 * aggregate), it reports a published cohort rather than activity in the range:
 * each Distribution contributes its latest stored snapshot as of the range end.
 * Missing coverage is named as unsupported or awaiting sync, never rendered as
 * a measured zero.
 */
export function AnalyticsView(): React.ReactElement {
  const scope = useSessionScope();
  const { selectedBrandProfile } = useWorkspace();
  const { t, language } = useI18n();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const capabilitiesQuery = usePlatformCapabilities(scope);
  const accountsQuery = usePlatforms(scope);
  const analyticsPlatforms: readonly Platform[] = (capabilitiesQuery.data ?? [])
    .filter((capability) => capability.analytics)
    .map((capability) => capability.platform);
  const { accountId, format, range, platform, metric } = parseAnalyticsSearchParams(
    searchParams,
    analyticsPlatforms,
  );

  // A range/platform/metric/profile change starts a new top-N window without an
  // effect: the stored key that owns the limit no longer matches, so the derived
  // value falls back to the initial page until Load more sets it again.
  const limitKey = `${range}|${platform ?? ""}|${accountId ?? ""}|${format ?? ""}|${metric}|${scope.brandProfileId ?? ""}`;
  const [limitState, setLimitState] = useState({
    key: limitKey,
    limit: ANALYTICS_INITIAL_LIMIT,
  });
  const limit = limitState.key === limitKey ? limitState.limit : ANALYTICS_INITIAL_LIMIT;
  const setLimit = (nextLimit: number) => setLimitState({ key: limitKey, limit: nextLimit });

  const analyticsFilters = {
    account_id: accountId,
    format,
    platform,
    range,
  } as const;
  const summaryQuery = useAnalyticsSummary(scope, analyticsFilters);
  const dashboardQuery = useAnalyticsDashboard(scope, analyticsFilters);
  const postsQuery = useAnalyticsPosts(scope, {
    ...analyticsFilters,
    limit,
    metric,
    offset: 0,
  });

  const updateSearch = (next: {
    accountId: string | undefined;
    format: typeof format;
    metric: typeof metric;
    platform: Platform | undefined;
    range: typeof range;
  }) => {
    navigate(`${pathname}?${formatAnalyticsSearchParams(next)}`);
  };

  const connectedPlatforms = new Set(
    (accountsQuery.data ?? [])
      .filter(
        (account) =>
          account.connection_status === "connected" || account.connection_status === "expiring",
      )
      .map((account) => account.platform),
  );
  const capableConnectedPlatforms = analyticsPlatforms.filter((candidate) =>
    connectedPlatforms.has(candidate),
  );
  const referencesPending = capabilitiesQuery.isPending || accountsQuery.isPending;
  const referenceError = capabilitiesQuery.error ?? accountsQuery.error;
  const error = summaryQuery.error ?? dashboardQuery.error ?? postsQuery.error ?? referenceError;
  const refreshing =
    (summaryQuery.isFetching || dashboardQuery.isFetching || postsQuery.isFetching) &&
    !summaryQuery.isPending;
  const scopeLabel = selectedBrandProfile?.name ?? t("All Brand Profiles");
  const summary = summaryQuery.data;
  const lastSyncedAt = summary?.last_synced_at ?? null;
  const lastSyncLabel =
    lastSyncedAt === null
      ? t("Not synced yet")
      : t("Last synced {time}", {
          time: formatAnalyticsTimestamp(lastSyncedAt, language),
        });
  const stale = isAnalyticsStale(lastSyncedAt);
  const unsupportedNames = (summary?.unsupported_platforms ?? [])
    .map(platformDisplayName)
    .join(", ");
  const emptyState = summary ? resolveAnalyticsEmptyState(summary) : null;
  const comparableRowCount = summary
    ? comparablePlatformRows(summary.by_platform, summary.unsupported_platforms).length
    : 0;
  // Hide immediately when the filter narrows to one Platform; placeholder data
  // from the aggregate view must not leave the old card title on screen while
  // the filtered summary loads.
  const showComparison = platform === undefined && comparableRowCount > 1;
  const rangeLabel = analyticsRangeLabel(range, t);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["analytics"] });
  };
  const retry = () => {
    void capabilitiesQuery.refetch();
    void accountsQuery.refetch();
    void summaryQuery.refetch();
    void dashboardQuery.refetch();
    void postsQuery.refetch();
  };

  const loading =
    referencesPending || summaryQuery.isPending || dashboardQuery.isPending || postsQuery.isPending;
  const lastSyncStatus = summary ? (
    <span className="flex items-center gap-1.5 text-xs tabular-nums text-ink-3" aria-live="polite">
      {stale && <TriangleAlert className="size-3.5 text-orange" aria-hidden="true" />}
      <span className={stale ? "text-orange" : undefined}>{lastSyncLabel}</span>
      {refreshing && <span className="text-ink-3">{t("Refreshing…")}</span>}
    </span>
  ) : null;

  const description = t("{profile} · Performance for published posts across connected channels.", {
    profile: scopeLabel,
  });

  if (loading) {
    return (
      <WorkspaceSurface title={t("Analytics")} description={description} actions={lastSyncStatus}>
        <AnalyticsLoadingSkeleton />
      </WorkspaceSurface>
    );
  }

  if (!error && !capableConnectedPlatforms.length) {
    return (
      <WorkspaceSurface title={t("Analytics")} description={description} actions={lastSyncStatus}>
        <AnalyticsEmpty
          title={t("Analytics needs a connected channel that reports analytics.")}
          description={t(
            "Connect an account on a platform whose Provider reports analytics. Reconnect an existing channel if its analytics scope was not granted.",
          )}
          showChannelsLink
        />
      </WorkspaceSurface>
    );
  }

  return (
    <WorkspaceSurface title={t("Analytics")} description={description} actions={lastSyncStatus}>
      <AnalyticsToolbar
        accounts={accountsQuery.data ?? []}
        platforms={analyticsPlatforms}
        selectedAccountId={accountId}
        selectedFormat={format}
        selectedRange={range}
        selectedPlatform={platform}
        refreshing={refreshing}
        onAccountChange={(nextAccountId) => {
          const account = (accountsQuery.data ?? []).find(
            (candidate) => candidate.id === nextAccountId,
          );
          updateSearch({
            accountId: nextAccountId,
            format,
            metric,
            platform: account ? account.platform : platform,
            range,
          });
        }}
        onFormatChange={(nextFormat) =>
          updateSearch({ accountId, format: nextFormat, metric, platform, range })
        }
        onRangeChange={(nextRange) =>
          updateSearch({ accountId, format, metric, platform, range: nextRange })
        }
        onPlatformChange={(nextPlatform) => {
          const account = (accountsQuery.data ?? []).find(
            (candidate) => candidate.id === accountId,
          );
          updateSearch({
            accountId:
              account && (!nextPlatform || account.platform === nextPlatform)
                ? accountId
                : undefined,
            format,
            metric,
            platform: nextPlatform,
            range,
          });
        }}
        onRefresh={refresh}
      />
      <AnalyticsBody>
        {error ? (
          <Alert variant="destructive" className="flex-col gap-2">
            <div>
              <p className="font-medium">{t("Analytics could not be loaded")}</p>
              <p className="mt-0.5 text-xs">
                {error instanceof Error ? error.message : t("We could not load analytics.")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={retry}
            >
              {t("Retry")}
            </Button>
          </Alert>
        ) : emptyState ? (
          <AnalyticsEmpty
            title={
              emptyState === "no-posts"
                ? t("No published posts in this range.")
                : emptyState === "all-unsupported"
                  ? t("No analytics-capable published destinations in this range.")
                  : t("Metrics appear after the first provider sync.")
            }
            description={
              emptyState === "no-posts"
                ? t("Choose another range or publish a Post to build this cohort.")
                : emptyState === "all-unsupported"
                  ? t(
                      "The published destinations in this range do not report analytics yet. Publish from a platform whose Provider reports analytics, or choose another range.",
                    )
                  : t(
                      "Stored metrics will appear after the next scheduled sync. If they remain empty, reconnect the channel to grant its analytics scope.",
                    )
            }
          />
        ) : summary ? (
          <>
            {summary.partial && (
              <Alert variant="warning">
                {t("Partial data: no analytics are available for {platforms}.", {
                  platforms: unsupportedNames,
                })}
              </Alert>
            )}
            {stale && lastSyncedAt && (
              <Alert variant="warning">
                {t("Analytics may be behind: the last sync was {time}.", {
                  time: formatAnalyticsTimestamp(lastSyncedAt, language),
                })}
              </Alert>
            )}
            <MetricCards totals={summary.totals} />
            <p className="text-xs text-ink-3">
              {t("Published {range} · measured as of {end}", {
                end: formatAnalyticsTimestamp(summary.range.end, language),
                range: rangeLabel,
              })}
            </p>
            <p className="text-xs text-ink-3">
              {t(
                "Metrics are cumulative snapshots for posts published in this range, not activity during it.",
              )}
            </p>
            {showComparison && (
              <Card>
                <CardHeader className="p-4 pb-0">
                  <CardTitle className="text-sm">{t("Platform comparison")}</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <PlatformMetricChart
                    rows={summary.by_platform}
                    rangeLabel={rangeLabel}
                    unsupportedPlatforms={summary.unsupported_platforms}
                  />
                </CardContent>
              </Card>
            )}
            {dashboardQuery.data && (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <PostsPerPlatformChart dashboard={dashboardQuery.data} />
                  <MetricOverTimeChart dashboard={dashboardQuery.data} />
                  <PostsOverTimeChart dashboard={dashboardQuery.data} />
                  <EngagementOverTimeChart dashboard={dashboardQuery.data} />
                  <FollowerEvolutionChart dashboard={dashboardQuery.data} />
                  <ContentFormatBreakdown dashboard={dashboardQuery.data} />
                  <FrequencyScatterChart dashboard={dashboardQuery.data} />
                  <AccumulationChart dashboard={dashboardQuery.data} />
                </div>
                <BestTimeHeatmap dashboard={dashboardQuery.data} />
                <Card>
                  <CardHeader className="p-4 pb-0">
                    <CardTitle className="text-sm">{t("Platform breakdown")}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 pt-2">
                    <PlatformBreakdownTable dashboard={dashboardQuery.data} />
                  </CardContent>
                </Card>
              </>
            )}
            <Card>
              <CardHeader className="p-4 pb-0">
                <CardTitle className="text-sm">{t("Top posts")}</CardTitle>
              </CardHeader>
              <CardContent className="p-0 pt-2">
                <TopPostsTable
                  posts={postsQuery.data?.posts ?? []}
                  metric={metric}
                  limit={limit}
                  hasMore={postsQuery.data?.has_more ?? false}
                  loadingMore={postsQuery.isFetching && !postsQuery.isPending}
                  onMetricChange={(nextMetric) =>
                    updateSearch({ accountId, format, metric: nextMetric, platform, range })
                  }
                  onLoadMore={() => setLimit(nextAnalyticsLimit(limit))}
                />
              </CardContent>
            </Card>
          </>
        ) : null}
      </AnalyticsBody>
    </WorkspaceSurface>
  );
}
