import { useReducedMotion } from "motion/react";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { analyticsMetricLabel } from "./analytics-toolbar";
import { formatAnalyticsInteger } from "./analytics-helpers";
import type { PlatformMetrics } from "@/types";

/** The three comparable engagement counters, stacked into one part-to-whole bar. */
const ENGAGEMENT_METRICS = ["likes", "comments", "shares"] as const;

type EngagementMetric = (typeof ENGAGEMENT_METRICS)[number];

const ENGAGEMENT_COLORS: Record<EngagementMetric, string> = {
  likes: "var(--green)",
  comments: "var(--orange)",
  shares: "var(--teal)",
};

interface PlatformChartDatum extends Record<string, unknown> {
  comments: number;
  destinations: number;
  label: string;
  likes: number;
  platform: PlatformMetrics["platform"];
  shares: number;
  total: number;
  views: number;
}

interface PlatformTooltipItem {
  payload?: PlatformChartDatum;
}

interface PlatformEngagementChartProps {
  /** Per-platform sums for the current cohort. */
  rows: readonly PlatformMetrics[];
  /** Human-readable range label used in the chart's accessible summary. */
  rangeLabel: string;
  /** Platforms in scope that cannot report analytics; they never become bars. */
  unsupportedPlatforms: readonly PlatformMetrics["platform"][];
}

/** Supported platforms with at least one stored snapshot in this cohort. */
export function comparablePlatformRows(
  rows: readonly PlatformMetrics[],
  unsupportedPlatforms: readonly PlatformMetrics["platform"][],
): PlatformMetrics[] {
  return rows.filter(
    (row) => !unsupportedPlatforms.includes(row.platform) && row.last_synced_at !== null,
  );
}

/**
 * One tooltip for the whole stack: the platform, each engagement counter, the
 * total, and the context (published destinations and views) that the stacked
 * length cannot carry. Keeping the extra values here is what lets one chart
 * replace four per-metric panels without hiding the comparison.
 */
function PlatformEngagementTooltip({
  active,
  payload,
  language,
}: {
  active?: boolean;
  payload?: readonly PlatformTooltipItem[];
  language: Language;
}) {
  const { t } = useI18n();
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return <span className="p-4" />;
  return (
    <div className="grid min-w-48 gap-1.5 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-raised">
      <div className="font-medium text-ink">{datum.label}</div>
      {ENGAGEMENT_METRICS.map((metric) => (
        <div key={metric} className="flex items-baseline justify-between gap-4">
          <span className="text-ink-2">{analyticsMetricLabel(metric, t)}</span>
          <span className="font-mono font-medium tabular-nums text-ink">
            {formatAnalyticsInteger(datum[metric], language)}
          </span>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1">
        <span className="text-ink-2">{t("Total engagement")}</span>
        <span className="font-mono font-medium tabular-nums text-ink">
          {formatAnalyticsInteger(datum.total, language)}
        </span>
      </div>
      <div className="text-ink-3">
        {t("{count} posts", { count: formatAnalyticsInteger(datum.destinations, language) })} ·{" "}
        {t("Views")}: {formatAnalyticsInteger(datum.views, language)}
      </div>
    </div>
  );
}

/**
 * EvilCharts Recharts stacked comparison of likes, comments, and shares.
 *
 * One bar per supported platform holds all three engagement counters, so the
 * chart answers both "who gets the most engagement" and "what kind" in a single
 * plot. Views and published destinations stay in the tooltip and the hidden
 * table because their magnitude would flatten the engagement segments. Only
 * supported platforms with at least one snapshot become bars; unsupported
 * platforms and destinations awaiting their first sync are named in text rather
 * than plotted as zero. The OS reduced-motion preference disables the intro
 * animation.
 */
export function PlatformEngagementChart({
  rows,
  rangeLabel,
  unsupportedPlatforms,
}: PlatformEngagementChartProps): React.ReactElement {
  const { t, language } = useI18n();
  const reduceMotion = useReducedMotion() ?? false;
  const supportedRows = rows.filter((row) => !unsupportedPlatforms.includes(row.platform));
  const chartRows = comparablePlatformRows(rows, unsupportedPlatforms);
  const awaiting = supportedRows.filter((row) => row.last_synced_at === null);
  const data: PlatformChartDatum[] = chartRows
    .map((row) => ({
      comments: row.comments,
      destinations: row.post_count,
      label: platformDisplayName(row.platform),
      likes: row.likes,
      platform: row.platform,
      shares: row.shares,
      total: row.likes + row.comments + row.shares,
      views: row.views,
    }))
    .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label));
  const config = {
    likes: {
      colors: { dark: [ENGAGEMENT_COLORS.likes], light: [ENGAGEMENT_COLORS.likes] },
      label: analyticsMetricLabel("likes", t),
    },
    comments: {
      colors: { dark: [ENGAGEMENT_COLORS.comments], light: [ENGAGEMENT_COLORS.comments] },
      label: analyticsMetricLabel("comments", t),
    },
    shares: {
      colors: { dark: [ENGAGEMENT_COLORS.shares], light: [ENGAGEMENT_COLORS.shares] },
      label: analyticsMetricLabel("shares", t),
    },
  } satisfies ChartConfig;

  if (data.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-sm text-ink-2">{t("No platform metrics recorded in this range yet.")}</p>
        {awaiting.length > 0 && (
          <p className="text-xs text-ink-3">
            {t("Awaiting first sync: {platforms}", {
              platforms: awaiting.map((row) => platformDisplayName(row.platform)).join(", "),
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        role="img"
        aria-label={t("Likes, comments, and shares by platform for {range}", { range: rangeLabel })}
        className="flex min-h-48 flex-1 flex-col"
      >
        <EvilBarChart
          config={config}
          data={data}
          layout="horizontal"
          stackType="stacked"
          animationType={reduceMotion ? "none" : "left-to-right"}
          barRadius={0}
          barCategoryGap={10}
          chartProps={{ margin: { bottom: 0, left: 0, right: 12, top: 8 } }}
          className="aspect-auto flex-1"
        >
          <EvilBarChart.Grid horizontal={false} vertical />
          <EvilBarChart.XAxis
            type="number"
            allowDecimals={false}
            tickFormatter={(value: number) => formatAnalyticsInteger(value, language)}
          />
          <EvilBarChart.YAxis type="category" dataKey="label" width={96} interval={0} />
          <EvilBarChart.Legend align="right" verticalAlign="top" />
          <ChartTooltip
            cursor={false}
            content={<PlatformEngagementTooltip language={language} />}
          />
          {ENGAGEMENT_METRICS.map((metric) => (
            <EvilBarChart.Bar key={metric} dataKey={metric} radius={0} barProps={{ barSize: 22 }} />
          ))}
        </EvilBarChart>
      </div>
      {/* The hidden table needs a block wrapper: table layout ignores sr-only's
          1px sizing, leaving its caption visually exposed in some browsers. */}
      <div className="sr-only">
        <table>
          <caption>{t("Engagement by platform")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Platform")}</th>
              {ENGAGEMENT_METRICS.map((metric) => (
                <th key={metric} scope="col">
                  {analyticsMetricLabel(metric, t)}
                </th>
              ))}
              <th scope="col">{t("Total engagement")}</th>
              <th scope="col">{t("Published destinations")}</th>
              <th scope="col">{t("Views")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.platform}>
                <th scope="row">{row.label}</th>
                {ENGAGEMENT_METRICS.map((metric) => (
                  <td key={metric}>{formatAnalyticsInteger(row[metric], language)}</td>
                ))}
                <td>{formatAnalyticsInteger(row.total, language)}</td>
                <td>{formatAnalyticsInteger(row.destinations, language)}</td>
                <td>{formatAnalyticsInteger(row.views, language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {awaiting.length > 0 && (
        <p className="text-xs text-ink-3">
          {t("Awaiting first sync: {platforms}", {
            platforms: awaiting.map((row) => platformDisplayName(row.platform)).join(", "),
          })}
        </p>
      )}
    </div>
  );
}
