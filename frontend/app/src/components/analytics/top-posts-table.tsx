import { ArrowDown } from "lucide-react";
import { Badge } from "@meltiply/ui/badge";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meltiply/ui/table";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import {
  ANALYTICS_METRICS,
  ANALYTICS_MAX_LIMIT,
  analyticsRowMetricState,
  formatAnalyticsInteger,
  formatAnalyticsRelativeTime,
  formatAnalyticsTimestamp,
} from "./analytics-helpers";
import { analyticsMetricLabel } from "./analytics-toolbar";
import type { AnalyticsMetric, AnalyticsPostRow } from "@/types";

interface TopPostsTableProps {
  posts: readonly AnalyticsPostRow[];
  metric: AnalyticsMetric;
  limit: number;
  hasMore: boolean;
  /** True while a Load more refetch is in flight; prior rows stay visible. */
  loadingMore: boolean;
  onMetricChange: (metric: AnalyticsMetric) => void;
  onLoadMore: () => void;
}

/**
 * Row identity: the title when present, else the excerpt, else the documented
 * untitled label. The excerpt stays visible as a secondary line when both exist.
 */
function PostIdentity({ row }: { row: AnalyticsPostRow }) {
  const { t } = useI18n();
  const title = row.title.trim();
  const excerpt = row.excerpt.trim();
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-ink">{title || excerpt || t("Untitled post")}</div>
      {title && excerpt && <div className="mt-0.5 truncate text-xs text-ink-3">{excerpt}</div>}
    </div>
  );
}

/** Platform icons plus the honest destination count and, for mixed rows, Partial. */
function PlatformSummary({ row }: { row: AnalyticsPostRow }) {
  const { t } = useI18n();
  const partial = analyticsRowMetricState(row) === "partial";
  const unsupported = row.unsupported_platforms.map(platformDisplayName).join(", ");
  const awaitingSync = row.destination_count - row.synced_destination_count;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="sr-only">{row.platforms.map(platformDisplayName).join(", ")}. </span>
      {row.platforms.map((platform) => (
        <PlatformIcon key={platform} provider={platform} className="size-3.5" />
      ))}
      <span className="text-xs text-ink-3">
        {t("{count} destinations", { count: formatAnalyticsInteger(row.destination_count) })}
      </span>
      {partial && (
        <Badge variant="outline" className="px-1 py-0 text-[10px]" title={unsupported}>
          {t("Partial")}
          <span className="sr-only">{` — ${unsupported}`}</span>
        </Badge>
      )}
      {awaitingSync > 0 && (
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {t("Awaiting sync")} {formatAnalyticsInteger(awaitingSync)}/
          {formatAnalyticsInteger(row.destination_count)}
        </Badge>
      )}
    </div>
  );
}

/**
 * One metric cell or definition value. The state is decided once per row, so a
 * never-measured destination reads as unsupported or awaiting sync instead of an
 * inferred zero.
 */
function MetricValue({
  row,
  metric,
  language,
  t,
}: {
  row: AnalyticsPostRow;
  metric: AnalyticsMetric;
  language: Language;
  t: (message: string) => string;
}) {
  const state = analyticsRowMetricState(row);
  if (state === "unsupported") return <span className="text-ink-3">{t("Not supported")}</span>;
  if (state === "awaiting-sync") return <span className="text-ink-3">{t("Awaiting sync")}</span>;
  return (
    <span className="font-mono tabular-nums">{formatAnalyticsInteger(row[metric], language)}</span>
  );
}

/** Metric header button that re-ranks the table by the chosen stored metric. */
function MetricHeader({
  metric,
  activeMetric,
  onMetricChange,
}: {
  metric: AnalyticsMetric;
  activeMetric: AnalyticsMetric;
  onMetricChange: (metric: AnalyticsMetric) => void;
}) {
  const { t } = useI18n();
  const label = analyticsMetricLabel(metric, t);
  return (
    <TableHead
      aria-sort={activeMetric === metric ? "descending" : "none"}
      className="whitespace-nowrap text-right"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onMetricChange(metric)}
        aria-label={t("Sort by {metric}", { metric: label })}
        className="h-6 gap-1 whitespace-nowrap px-1 text-xs font-medium text-ink-3 hover:text-ink"
      >
        {label}
        {activeMetric === metric && <ArrowDown className="size-3" aria-hidden="true" />}
      </Button>
    </TableHead>
  );
}

/**
 * Ranked Post table with a stacked phone layout.
 *
 * The desktop table and the stacked list read the same rows and row state; only
 * their geometry differs, so no view can show a different ranking or invented
 * value. All four stored metrics stay visible; their headers re-rank in place,
 * and Load more raises the top-N window without offset paging.
 */
export function TopPostsTable({
  posts,
  metric,
  limit,
  hasMore,
  loadingMore,
  onMetricChange,
  onLoadMore,
}: TopPostsTableProps): React.ReactElement {
  const { t, language } = useI18n();
  const canLoadMore = hasMore && limit < ANALYTICS_MAX_LIMIT;
  return (
    <div className="flex flex-col gap-3">
      {posts.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-2">
          {t("No published posts in this range.")}
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <Table className="min-w-[900px]">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[17%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">{t("Post")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("Platforms")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("Published")}</TableHead>
                  {ANALYTICS_METRICS.map((key) => (
                    <MetricHeader
                      key={key}
                      metric={key}
                      activeMetric={metric}
                      onMetricChange={onMetricChange}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((row) => {
                  const exact = formatAnalyticsTimestamp(row.published_at, language);
                  return (
                    <TableRow key={row.post_id}>
                      <TableCell>
                        <PostIdentity row={row} />
                      </TableCell>
                      <TableCell>
                        <PlatformSummary row={row} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <time dateTime={row.published_at} title={exact}>
                          {formatAnalyticsRelativeTime(row.published_at, language)}
                        </time>
                      </TableCell>
                      {ANALYTICS_METRICS.map((key) => (
                        <TableCell key={key} className="whitespace-nowrap text-right">
                          <MetricValue row={row} metric={key} language={language} t={t} />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end px-4 lg:hidden">
            <SegmentedControl
              options={ANALYTICS_METRICS}
              value={metric}
              onChange={onMetricChange}
              label={t("Metric")}
              renderOption={(value) => analyticsMetricLabel(value, t)}
            />
          </div>
          <ul className="divide-y divide-line lg:hidden">
            {posts.map((row) => {
              const exact = formatAnalyticsTimestamp(row.published_at, language);
              return (
                <li key={row.post_id} className="flex flex-col gap-2 px-4 py-3">
                  <PostIdentity row={row} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <PlatformSummary row={row} />
                    <time dateTime={row.published_at} title={exact} className="text-xs text-ink-3">
                      {formatAnalyticsRelativeTime(row.published_at, language)}
                    </time>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {ANALYTICS_METRICS.map((key) => (
                      <div key={key} className="flex items-baseline justify-between gap-2">
                        <dt className="text-xs text-ink-3">{analyticsMetricLabel(key, t)}</dt>
                        <dd className="text-sm text-ink">
                          <MetricValue row={row} metric={key} language={language} t={t} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {canLoadMore && (
        <div className="flex justify-center pb-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? t("Loading…") : t("Load more")}
          </Button>
        </div>
      )}
    </div>
  );
}
