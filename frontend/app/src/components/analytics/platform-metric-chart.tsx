import { useReducedMotion } from "motion/react";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { analyticsMetricLabel } from "./analytics-toolbar";
import { formatAnalyticsInteger } from "./analytics-helpers";
import type { AnalyticsMetric, PlatformMetrics } from "@/types";

/** The four stored counters compared side by side, each on its own scale. */
const COMPARISON_METRICS: readonly AnalyticsMetric[] = ["views", "likes", "comments", "shares"];

type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

interface PlatformChartDatum extends Record<string, unknown>, Record<ComparisonMetric, number> {
  destinations: number;
  label: string;
  platform: PlatformMetrics["platform"];
}

interface PlatformTooltipItem {
  payload?: PlatformChartDatum;
}

interface PlatformMetricChartProps {
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
 * Renders one tooltip row: the platform plus every stored counter, so hovering
 * any of the four small charts still answers the whole comparison without
 * switching scales or opening another view.
 */
function PlatformMetricTooltipContent({
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
    <div className="grid min-w-44 gap-1.5 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-raised">
      <div className="font-medium text-ink">{datum.label}</div>
      {COMPARISON_METRICS.map((metric) => (
        <div key={metric} className="flex items-baseline justify-between gap-4">
          <span className="text-ink-2">{analyticsMetricLabel(metric, t)}</span>
          <span className="font-mono font-medium tabular-nums text-ink">
            {formatAnalyticsInteger(datum[metric], language)}
          </span>
        </div>
      ))}
      <div className="text-ink-3">
        {t("{count} published destinations", {
          count: formatAnalyticsInteger(datum.destinations, language),
        })}
      </div>
    </div>
  );
}

/** Compact horizontal bars for one metric; the caller owns the small-multiple grid. */
function PlatformMetricBars({
  data,
  language,
  metric,
  rangeLabel,
  reduceMotion,
}: {
  data: readonly PlatformChartDatum[];
  language: Language;
  metric: ComparisonMetric;
  rangeLabel: string;
  reduceMotion: boolean;
}) {
  const { t } = useI18n();
  const metricLabel = analyticsMetricLabel(metric, t);
  const accent = { dark: ["var(--accent)"], light: ["var(--accent)"] };
  // Literal keys keep EvilCharts' config-to-data key check satisfiable while
  // still letting the caller pick one metric per small multiple.
  const configs = {
    views: { views: { colors: accent, label: analyticsMetricLabel("views", t) } },
    likes: { likes: { colors: accent, label: analyticsMetricLabel("likes", t) } },
    comments: { comments: { colors: accent, label: analyticsMetricLabel("comments", t) } },
    shares: { shares: { colors: accent, label: analyticsMetricLabel("shares", t) } },
  } satisfies Record<ComparisonMetric, ChartConfig>;
  const config = configs[metric];
  // Reserve room for the exact-value labels at the right edge of each bar.
  const labelMargin = Math.max(
    40,
    12 + Math.max(...data.map((row) => formatAnalyticsInteger(row[metric], language).length)) * 7,
  );
  const chartHeight =
    data.length <= 2 ? "h-24" : data.length === 3 ? "h-28" : data.length === 4 ? "h-32" : "h-36";
  return (
    <div
      role="img"
      aria-label={t("{metric} by platform for {range}", { metric: metricLabel, range: rangeLabel })}
      className="min-w-0"
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{metricLabel}</span>
        <span className="font-mono text-xs tabular-nums text-ink-3">
          {formatAnalyticsInteger(
            data.reduce((sum, row) => sum + row[metric], 0),
            language,
          )}
        </span>
      </div>
      <EvilBarChart
        config={config}
        data={[...data]}
        layout="horizontal"
        animationType={reduceMotion ? "none" : "left-to-right"}
        barRadius={3}
        barCategoryGap={6}
        chartProps={{ margin: { bottom: 0, left: 0, right: labelMargin, top: 0 } }}
        className={`aspect-auto ${chartHeight}`}
      >
        <EvilBarChart.Grid horizontal={false} vertical />
        <EvilBarChart.XAxis
          type="number"
          allowDecimals={false}
          tickFormatter={(value: number) => formatAnalyticsInteger(value, language)}
        />
        <EvilBarChart.YAxis type="category" dataKey="label" width={92} interval={0} />
        <ChartTooltip
          cursor={false}
          content={<PlatformMetricTooltipContent language={language} />}
        />
        <EvilBarChart.Bar
          dataKey={metric}
          radius={3}
          barProps={{
            label: {
              fill: "var(--ink-2)",
              fontSize: 11,
              formatter: (value: unknown) =>
                typeof value === "number" ? formatAnalyticsInteger(value, language) : "",
              position: "right",
            },
            maxBarSize: 22,
          }}
        />
      </EvilBarChart>
    </div>
  );
}

/**
 * EvilCharts Recharts comparison of every stored metric, one small multiple per
 * metric so views never flatten likes or comments into invisible bars.
 *
 * Only supported platforms with at least one snapshot become bars; unsupported
 * platforms and destinations awaiting their first sync are named in text rather
 * than plotted as zero. A visually hidden table carries the same values, and the
 * OS reduced-motion preference disables the intro animation.
 */
export function PlatformMetricChart({
  rows,
  rangeLabel,
  unsupportedPlatforms,
}: PlatformMetricChartProps): React.ReactElement {
  const { t, language } = useI18n();
  const reduceMotion = useReducedMotion() ?? false;
  const supportedRows = rows.filter((row) => !unsupportedPlatforms.includes(row.platform));
  const chartRows = comparablePlatformRows(rows, unsupportedPlatforms);
  const awaiting = supportedRows.filter((row) => row.last_synced_at === null);
  // One platform order across all four small charts keeps rows visually aligned.
  const data: PlatformChartDatum[] = chartRows
    .map((row) => ({
      comments: row.comments,
      destinations: row.post_count,
      label: platformDisplayName(row.platform),
      likes: row.likes,
      platform: row.platform,
      shares: row.shares,
      views: row.views,
    }))
    .sort((left, right) => right.views - left.views || left.label.localeCompare(right.label));

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
    <div className="flex flex-col gap-3">
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {COMPARISON_METRICS.map((metric) => (
          <PlatformMetricBars
            key={metric}
            data={data}
            language={language}
            metric={metric}
            rangeLabel={rangeLabel}
            reduceMotion={reduceMotion}
          />
        ))}
      </div>
      {/* The hidden table needs a block wrapper: table layout ignores sr-only's
          1px sizing, leaving its caption visually exposed in some browsers. */}
      <div className="sr-only">
        <table>
          <caption>{t("Platform comparison")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Platform")}</th>
              {COMPARISON_METRICS.map((metric) => (
                <th key={metric} scope="col">
                  {analyticsMetricLabel(metric, t)}
                </th>
              ))}
              <th scope="col">{t("Published destinations")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.platform}>
                <th scope="row">{row.label}</th>
                {COMPARISON_METRICS.map((metric) => (
                  <td key={metric}>{formatAnalyticsInteger(row[metric], language)}</td>
                ))}
                <td>{formatAnalyticsInteger(row.destinations, language)}</td>
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
