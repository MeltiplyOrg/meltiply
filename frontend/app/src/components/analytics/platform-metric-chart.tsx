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

interface PlatformChartDatum extends Record<string, unknown> {
  destinations: number;
  label: string;
  metric: number;
  platform: PlatformMetrics["platform"];
}

interface PlatformTooltipItem {
  payload?: PlatformChartDatum;
}

interface PlatformMetricChartProps {
  /** Per-platform sums for the current cohort. */
  rows: readonly PlatformMetrics[];
  metric: AnalyticsMetric;
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
 * Renders one tooltip row: the platform, the selected metric's exact value, and
 * how many published destinations produced it.
 */
function PlatformMetricTooltipContent({
  active,
  payload,
  language,
  metricLabel,
}: {
  active?: boolean;
  payload?: readonly PlatformTooltipItem[];
  language: Language;
  metricLabel: string;
}) {
  const { t } = useI18n();
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return <span className="p-4" />;
  return (
    <div className="grid min-w-40 gap-1.5 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-raised">
      <div className="font-medium text-ink">{datum.label}</div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-ink-2">{metricLabel}</span>
        <span className="font-mono font-medium tabular-nums text-ink">
          {formatAnalyticsInteger(datum.metric, language)}
        </span>
      </div>
      <div className="text-ink-3">
        {t("{count} published destinations", {
          count: formatAnalyticsInteger(datum.destinations, language),
        })}
      </div>
    </div>
  );
}

/**
 * EvilCharts Recharts horizontal bar comparison of one stored metric.
 *
 * Only supported platforms with at least one snapshot become bars; unsupported
 * platforms and destinations awaiting their first sync are named in text rather
 * than plotted as zero. A visually hidden table carries the same values, and the
 * OS reduced-motion preference disables the intro animation.
 */
export function PlatformMetricChart({
  rows,
  metric,
  rangeLabel,
  unsupportedPlatforms,
}: PlatformMetricChartProps): React.ReactElement {
  const { t, language } = useI18n();
  const reduceMotion = useReducedMotion();
  const metricLabel = analyticsMetricLabel(metric, t);
  const supportedRows = rows.filter((row) => !unsupportedPlatforms.includes(row.platform));
  const chartRows = comparablePlatformRows(rows, unsupportedPlatforms);
  const awaiting = supportedRows.filter((row) => row.last_synced_at === null);
  const data: PlatformChartDatum[] = chartRows
    .map((row) => ({
      destinations: row.post_count,
      label: platformDisplayName(row.platform),
      metric: row[metric],
      platform: row.platform,
    }))
    .sort((left, right) => right.metric - left.metric || left.label.localeCompare(right.label));
  const config = {
    metric: {
      colors: { dark: ["var(--accent)"], light: ["var(--accent)"] },
      label: metricLabel,
    },
  } satisfies ChartConfig;

  // A single Platform has nothing to compare against. The page omits this card
  // in that case, but keep the component itself honest and compact if reused.
  const chartHeight =
    data.length <= 2 ? "h-28" : data.length === 3 ? "h-36" : data.length === 4 ? "h-44" : "h-52";

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

  // Reserve room for the exact-value labels at the right edge of each bar.
  const labelMargin = Math.max(
    48,
    16 + Math.max(...data.map((row) => formatAnalyticsInteger(row.metric, language).length)) * 7,
  );

  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={t("{metric} by platform for {range}", {
          metric: metricLabel,
          range: rangeLabel,
        })}
        className="min-h-0"
      >
        <EvilBarChart
          config={config}
          data={data}
          layout="horizontal"
          animationType={reduceMotion ? "none" : "left-to-right"}
          barRadius={3}
          barCategoryGap={8}
          chartProps={{ margin: { bottom: 0, left: 0, right: labelMargin, top: 0 } }}
          className={`aspect-auto ${chartHeight}`}
        >
          <EvilBarChart.Grid horizontal={false} vertical />
          <EvilBarChart.XAxis
            type="number"
            allowDecimals={false}
            tickFormatter={(value: number) => formatAnalyticsInteger(value, language)}
          />
          <EvilBarChart.YAxis type="category" dataKey="label" width={96} />
          <ChartTooltip
            cursor={false}
            content={<PlatformMetricTooltipContent language={language} metricLabel={metricLabel} />}
          />
          <EvilBarChart.Bar
            dataKey="metric"
            radius={3}
            barProps={{
              label: {
                fill: "var(--ink-2)",
                fontSize: 11,
                formatter: (value: unknown) =>
                  typeof value === "number" ? formatAnalyticsInteger(value, language) : "",
                position: "right",
              },
              maxBarSize: 28,
            }}
          />
        </EvilBarChart>
      </div>
      {/* The hidden table needs a block wrapper: table layout ignores sr-only's
          1px sizing, leaving its caption visually exposed in some browsers. */}
      <div className="sr-only">
        <table>
          <caption>{t("Platform comparison")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Platform")}</th>
              <th scope="col">{metricLabel}</th>
              <th scope="col">{t("Published destinations")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.platform}>
                <th scope="row">{row.label}</th>
                <td>{formatAnalyticsInteger(row.metric, language)}</td>
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
