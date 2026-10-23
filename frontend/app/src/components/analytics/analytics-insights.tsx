import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@meltiply/ui/badge";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Card, CardContent, CardHeader, CardTitle } from "@meltiply/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meltiply/ui/table";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { ANALYTICS_METRICS, formatAnalyticsInteger } from "./analytics-helpers";
import { analyticsFormatLabel, analyticsMetricLabel } from "./analytics-toolbar";
import type {
  AnalyticsBestTime,
  AnalyticsDashboard,
  AnalyticsDaySeries,
  AnalyticsMetric,
  AnalyticsPlatformBreakdown,
  Platform,
} from "@/types";

const GROUPINGS = ["day", "week", "month"] as const;

type Grouping = (typeof GROUPINGS)[number];

/**
 * View-change timing for chart marks. One chart stays mounted while the
 * previously displayed shape is sampled onto the destination's buckets and
 * eased into place; this is the shared length for every chart that offers a
 * view mode. Reduced motion renders the destination immediately instead.
 */
const CHART_MORPH_MS = 360;

const PLATFORM_COLORS: Record<Platform, string> = {
  facebook: "var(--platform-facebook)",
  instagram: "var(--platform-instagram)",
  threads: "var(--ink)",
  tiktok: "var(--ink-2)",
  youtube: "var(--platform-youtube)",
};

const PLATFORMS: readonly Platform[] = ["facebook", "instagram", "threads", "tiktok", "youtube"];

interface TooltipEntry {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  payload?: Record<string, unknown>;
  value?: number | string;
}

interface TooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
}

function ChartTooltip({ active, label, payload }: TooltipProps) {
  const { t, language } = useI18n();
  if (!active || !payload?.length) return null;
  return (
    <div className="grid min-w-44 gap-1 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-raised">
      <div className="font-medium text-ink">{label}</div>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} className="flex items-baseline justify-between gap-4">
          <span className="text-ink-2">{String(entry.name)}</span>
          <span className="font-mono tabular-nums text-ink">
            {typeof entry.value === "number"
              ? formatAnalyticsInteger(entry.value, language)
              : String(entry.value ?? t("Not measured"))}
          </span>
        </div>
      ))}
    </div>
  );
}

function InsightCard({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="gap-1 p-4 pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <p className="text-xs text-ink-3">{description}</p>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col p-4">{children}</CardContent>
    </Card>
  );
}

function EmptyInsight({ message }: { message: string }) {
  return <p className="py-10 text-center text-sm text-ink-2">{message}</p>;
}

function formatAverage(value: number, language: Language): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
}

function bucketStart(date: string, grouping: Grouping): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (grouping === "month") {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
  }
  if (grouping === "week") {
    const day = value.getUTCDay();
    const offset = day === 0 ? -6 : 1 - day;
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  }
  return date;
}

function bucketLabel(date: string, grouping: Grouping, language: Language): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (grouping === "month") {
    return new Intl.DateTimeFormat(language, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(value);
  }
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(value);
}

function groupingLabel(grouping: Grouping, t: (message: string) => string): string {
  return t(grouping === "day" ? "Day" : grouping === "week" ? "Week" : "Month");
}

/** Day/week/month granularity, shared by the time-series cards. */
function GroupingControl({
  grouping,
  onChange,
}: {
  grouping: Grouping;
  onChange: (grouping: Grouping) => void;
}) {
  const { t } = useI18n();
  return (
    <SegmentedControl
      options={GROUPINGS}
      value={grouping}
      onChange={onChange}
      label={t("Group by")}
      renderOption={(value) => groupingLabel(value, t)}
    />
  );
}

/** Analytics-capable platforms in the cohort, in the shared display order. */
function platformRows(dashboard: AnalyticsDashboard) {
  return dashboard.platforms.filter((row) => PLATFORMS.includes(row.platform));
}

/** One flat chart row: a category label plus numeric series fields. */
type ChartRow = Record<string, number | string | null>;

/**
 * Reads a numeric series field at a normalized position across a row set,
 * linearly between neighbouring buckets. This is how a coarser or finer
 * grouping supplies the shape a morph starts from.
 */
function sampleRowField(rows: readonly ChartRow[], field: string, position: number): number {
  if (rows.length === 0) return 0;
  if (rows.length === 1) return Number(rows[0]?.[field] ?? 0);
  const scaled = position * (rows.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(rows.length - 1, lower + 1);
  const from = Number(rows[lower]?.[field] ?? 0);
  const to = Number(rows[upper]?.[field] ?? 0);
  return from + (to - from) * (scaled - lower);
}

/**
 * Builds the first frame of a view change: the target rows, but with every
 * numeric series sampled from the previously displayed shape. Labels are the
 * target's, so the axis describes the destination while the marks travel.
 */
function morphStart(previous: readonly ChartRow[], target: readonly ChartRow[]): ChartRow[] {
  return target.map((row, index) => {
    const position = target.length > 1 ? index / (target.length - 1) : 0;
    const start: ChartRow = {};
    for (const [field, value] of Object.entries(row)) {
      start[field] = typeof value === "number" ? sampleRowField(previous, field, position) : value;
    }
    return start;
  });
}

/** Linear blend from `start` to `target`; non-numeric fields switch immediately. */
function blendRows(
  start: readonly ChartRow[],
  target: readonly ChartRow[],
  progress: number,
): ChartRow[] {
  return target.map((row, index) => {
    const blended: ChartRow = {};
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== "number") {
        blended[field] = value;
        continue;
      }
      const from = Number(start[index]?.[field] ?? value);
      blended[field] = from + (value - from) * progress;
    }
    return blended;
  });
}

/**
 * Morphs chart rows between view modes instead of swapping them.
 *
 * Recharts renders one mounted chart; this hook supplies the intermediate
 * geometry, sampling the previous shape onto the new bucket positions and
 * easing the values across {@link CHART_MORPH_MS}. A change that is not a view
 * change (range, filters) renders immediately, an interrupted change continues
 * from what is on screen, and reduced motion skips the interpolation.
 */
function useMorphedRows(target: readonly ChartRow[], view: Grouping, enabled: boolean): ChartRow[] {
  const [rows, setRows] = useState<ChartRow[]>(() => [...target]);
  const displayedRef = useRef<ChartRow[]>([...target]);
  const viewRef = useRef(view);

  useEffect(() => {
    const changedView = viewRef.current !== view;
    viewRef.current = view;
    const previous = displayedRef.current;
    displayedRef.current = [...target];
    if (!changedView || !enabled || previous.length === 0) {
      setRows([...target]);
      return;
    }
    const start = morphStart(previous, target);
    const begin = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - begin) / CHART_MORPH_MS);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const next = progress >= 1 ? [...target] : blendRows(start, target, eased);
      displayedRef.current = next;
      setRows(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, view, enabled]);

  return rows;
}

/** Sum of the stacked series on one row, for a stable value-axis ceiling. */
function stackedTotal(row: ChartRow, fields: readonly string[]): number {
  return fields.reduce((sum, field) => sum + Number(row[field] ?? 0), 0);
}

/** Stacked publication counts per time bucket and Platform, morphing on grouping changes. */
export function PostsOverTimeChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [grouping, setGrouping] = useState<Grouping>("week");
  const reduceMotion = useReducedMotion() ?? false;
  const platforms = PLATFORMS.filter((platform) =>
    dashboard.series.some((row) => row.platform === platform && row.posts > 0),
  );
  const buckets = useMemo(
    () => groupSeries(dashboard.series, grouping, language),
    [dashboard.series, grouping, language],
  );
  const rows = useMorphedRows(buckets, grouping, !reduceMotion);
  // The value axis must cover both ends of the morph: the previous grouping's
  // buckets supply the sampled start, so a coarse-to-fine change cannot clip the
  // taller starting bars while they shrink into the new scale.
  const previousGroupingRef = useRef(grouping);
  const startBuckets = useMemo(
    () => groupSeries(dashboard.series, previousGroupingRef.current, language),
    [dashboard.series, language, grouping],
  );
  useEffect(() => {
    previousGroupingRef.current = grouping;
  }, [grouping]);
  const postsMax = Math.max(
    1,
    ...buckets.map((row) => stackedTotal(row, platforms)),
    ...startBuckets.map((row) => stackedTotal(row, platforms)),
  );
  if (buckets.length === 0)
    return <EmptyInsight message={t("No published posts in this range.")} />;
  return (
    <InsightCard
      title={t("Posts over time")}
      description={t("Publishing consistency by platform.")}
    >
      <div className="mb-2 flex justify-end">
        <GroupingControl grouping={grouping} onChange={setGrouping} />
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ bottom: 0, left: 0, right: 0, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={32}
              domain={[0, postsMax]}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--hover)" }} />
            <Legend />
            {platforms.map((platform) => (
              <Bar
                key={platform}
                dataKey={platform}
                stackId="posts"
                name={platformDisplayName(platform)}
                fill={PLATFORM_COLORS[platform]}
                maxBarSize={42}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

function groupSeries(
  series: readonly AnalyticsDaySeries[],
  grouping: Grouping,
  language: Language,
) {
  const map = new Map<
    string,
    { label: string } & Record<
      Platform,
      { comments: number; likes: number; posts: number; shares: number; views: number }
    >
  >();
  for (const row of series) {
    const key = bucketStart(row.date, grouping);
    const bucket =
      map.get(key) ??
      ({
        label: bucketLabel(key, grouping, language),
      } as { label: string } & Record<
        Platform,
        { comments: number; likes: number; posts: number; shares: number; views: number }
      >);
    const platform = bucket[row.platform] ?? {
      comments: 0,
      likes: 0,
      posts: 0,
      shares: 0,
      views: 0,
    };
    bucket[row.platform] = {
      comments: platform.comments + row.comments,
      likes: platform.likes + row.likes,
      posts: platform.posts + row.posts,
      shares: platform.shares + row.shares,
      views: platform.views + row.views,
    };
    map.set(key, bucket);
  }
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bucket]) => {
      const flat: Record<string, number | string> = { label: bucket.label };
      for (const platform of PLATFORMS) {
        const value = bucket[platform] ?? { comments: 0, likes: 0, posts: 0, shares: 0, views: 0 };
        flat[platform] = value.posts;
        flat[`${platform}_likes`] = value.likes;
        flat[`${platform}_comments`] = value.comments;
        flat[`${platform}_shares`] = value.shares;
        flat[`${platform}_views`] = value.views;
      }
      return flat;
    });
}

const TREND_COLORS: Record<AnalyticsMetric, string> = {
  views: "var(--accent)",
  likes: "var(--green)",
  comments: "var(--orange)",
  shares: "var(--teal)",
};

/** Dash patterns keep overlapping indexed lines distinguishable without more charts. */
const TREND_DASHES: Record<AnalyticsMetric, string | undefined> = {
  views: undefined,
  likes: "6 4",
  comments: "2 4",
  shares: "10 4",
};

/** Index values stay whole numbers; the absolute value is in the tooltip. */
function formatIndex(value: number, language: Language): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

/**
 * Cumulative measured change per metric, rebased to 100 at the first period
 * where that metric was measured. Indexing is the documented alternative to a
 * second y-axis: four metrics with different magnitudes share one honest scale,
 * and the tooltip restores the absolute cumulative value.
 */
function trendSeries(dashboard: AnalyticsDashboard, grouping: Grouping, language: Language) {
  const buckets = groupSeries(dashboard.series, grouping, language);
  const cumulative: Record<AnalyticsMetric, number> = {
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
  };
  const totals = buckets.map((bucket) => {
    const row: Record<string, number | string> = { label: bucket.label };
    for (const metric of ANALYTICS_METRICS) {
      cumulative[metric] += PLATFORMS.reduce(
        (sum, platform) => sum + Number(bucket[`${platform}_${metric}`] ?? 0),
        0,
      );
      row[metric] = cumulative[metric];
    }
    return row;
  });
  const bases = {} as Record<AnalyticsMetric, number>;
  for (const metric of ANALYTICS_METRICS) {
    const first = totals.find((row) => Number(row[metric]) > 0);
    bases[metric] = first ? Number(first[metric]) : 0;
  }
  const metrics = ANALYTICS_METRICS.filter((metric) => bases[metric] > 0);
  const data = totals.map((row) => {
    const indexed: Record<string, number | string | null> = { label: row.label };
    for (const metric of ANALYTICS_METRICS) {
      indexed[metric] = row[metric];
      indexed[`${metric}_index`] =
        bases[metric] > 0 ? (Number(row[metric]) / bases[metric]) * 100 : null;
    }
    return indexed;
  });
  return { data, metrics };
}

/** Tooltip for the indexed chart: index plus the absolute cumulative value. */
function TrendTooltip({ active, label, payload }: TooltipProps) {
  const { t, language } = useI18n();
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="grid min-w-56 gap-1 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-raised">
      <div className="font-medium text-ink">{label}</div>
      {ANALYTICS_METRICS.map((metric) => {
        const index = row[`${metric}_index`];
        if (typeof index !== "number") return null;
        return (
          <div key={metric} className="flex items-baseline justify-between gap-4">
            <span className="text-ink-2">{analyticsMetricLabel(metric, t)}</span>
            <span className="font-mono tabular-nums text-ink">
              {formatIndex(index, language)} ·{" "}
              {formatAnalyticsInteger(Number(row[metric] ?? 0), language)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One trend chart for every stored metric. Cumulative changes are indexed to
 * 100 at the first measured period so views cannot flatten likes, comments, and
 * shares; hovering restores absolute values. A grouping change reshapes the
 * same mounted lines: the previous curve is sampled onto the new bucket
 * positions and eased into the destination over the shared morph timing.
 */
export function PerformanceTrendChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [grouping, setGrouping] = useState<Grouping>("week");
  const reduceMotion = useReducedMotion() ?? false;
  const { data, metrics } = useMemo(
    () => trendSeries(dashboard, grouping, language),
    [dashboard, grouping, language],
  );
  const rows = useMorphedRows(data, grouping, !reduceMotion);
  if (data.length === 0 || metrics.length === 0)
    return <EmptyInsight message={t("No measured changes in this range yet.")} />;
  return (
    <InsightCard
      title={t("Performance trend")}
      description={t(
        "Cumulative measured change indexed to 100 at the first measured period. Hover for absolute values.",
      )}
    >
      <div className="mb-2 flex justify-end">
        <GroupingControl grouping={grouping} onChange={setGrouping} />
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ bottom: 0, left: 0, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(value: number) => formatIndex(value, language)}
            />
            <Tooltip content={<TrendTooltip />} />
            <Legend />
            {metrics.map((metric) => (
              <Line
                key={metric}
                type="monotone"
                dataKey={`${metric}_index`}
                name={analyticsMetricLabel(metric, t)}
                stroke={TREND_COLORS[metric]}
                strokeWidth={2}
                strokeDasharray={TREND_DASHES[metric]}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* A block wrapper keeps the visually hidden table from leaking its caption. */}
      <div className="sr-only">
        <table>
          <caption>{t("Performance trend")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("Date")}</th>
              {metrics.map((metric) => (
                <th key={metric} scope="col">
                  {analyticsMetricLabel(metric, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={String(row.label)}>
                <th scope="row">{row.label}</th>
                {metrics.map((metric) => (
                  <td key={metric}>{formatAnalyticsInteger(Number(row[metric] ?? 0), language)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </InsightCard>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const HEAT_METRICS = ["avg_engagement", "avg_likes", "avg_views"] as const;

type HeatMetric = (typeof HEAT_METRICS)[number];
const HOURS = Array.from({ length: 24 }, (_, index) => index);

function bestTimeValue(
  row: AnalyticsBestTime,
  metric: "avg_engagement" | "avg_likes" | "avg_views",
) {
  return row[metric];
}

/** Seven-by-twenty-four heatmap; metric changes tween cell intensity without replacing the grid. */
export function BestTimeHeatmap({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<HeatMetric>("avg_engagement");
  const cells = new Map(dashboard.best_times.map((row) => [`${row.day_of_week}:${row.hour}`, row]));
  const max = Math.max(0, ...dashboard.best_times.map((row) => bestTimeValue(row, metric)));
  const best = [...dashboard.best_times]
    .filter((row) => row.posts >= 2)
    .sort((left, right) => bestTimeValue(right, metric) - bestTimeValue(left, metric))[0];
  const weekdayLabel = (day: number) =>
    new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 0, 4 + day)),
    );
  if (dashboard.best_times.length === 0) {
    return <EmptyInsight message={t("No published posts in this range.")} />;
  }
  return (
    <InsightCard
      title={t("Best time to post")}
      description={t("Average performance by publication weekday and hour (UTC).")}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          options={HEAT_METRICS}
          value={metric}
          onChange={setMetric}
          label={t("Metric")}
          renderOption={(value) =>
            value === "avg_engagement"
              ? t("Engagement")
              : analyticsMetricLabel(value === "avg_likes" ? "likes" : "views", t)
          }
        />
        <p className="text-xs text-ink-3">
          {best
            ? t("Best slot: {day} {hour}:00 · {value} average · {posts} posts", {
                day: weekdayLabel(best.day_of_week),
                hour: String(best.hour).padStart(2, "0"),
                value: formatAverage(bestTimeValue(best, metric), language),
                posts: formatAnalyticsInteger(best.posts, language),
              })
            : t("Not enough measured posts to recommend a time.")}
        </p>
      </div>
      <div className="overflow-x-auto">
        <div className="mx-auto grid min-w-[640px] max-w-[1100px] grid-cols-[40px_repeat(24,minmax(16px,1fr))] gap-1">
          <span />
          {HOURS.map((hour) => (
            <span key={hour} className="text-center text-[10px] text-ink-3">
              {hour % 3 === 0 ? hour : ""}
            </span>
          ))}
          {WEEKDAYS.map((day) => (
            <div key={day} className="contents">
              <span className="text-[11px] text-ink-3">{weekdayLabel(day)}</span>
              {HOURS.map((hour) => {
                const cell = cells.get(`${day}:${hour}`);
                const value = cell ? bestTimeValue(cell, metric) : 0;
                const intensity = max > 0 ? value / max : 0;
                const opacityClass =
                  intensity === 0
                    ? "opacity-15"
                    : intensity < 0.25
                      ? "opacity-30"
                      : intensity < 0.5
                        ? "opacity-50"
                        : intensity < 0.75
                          ? "opacity-75"
                          : "opacity-100";
                return (
                  <span
                    key={`${day}-${hour}`}
                    title={
                      cell
                        ? t("{day} {hour}:00 · {posts} posts · {value} average", {
                            day: weekdayLabel(day),
                            hour: String(hour).padStart(2, "0"),
                            posts: formatAnalyticsInteger(cell.posts, language),
                            value: formatAverage(value, language),
                          })
                        : t("No measured posts")
                    }
                    className="aspect-square rounded-xs border border-line/60 bg-surface"
                  >
                    {cell && (
                      <span
                        className={`block size-full rounded-xs bg-accent transition-opacity duration-300 ease-in-out ${opacityClass}`}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </InsightCard>
  );
}

/** Follower lines aggregated by Platform, with current count and net gain. */
export function FollowerEvolutionChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  // One entry per account so staggered captures never subtract from each other;
  // the platform line sums each account's latest value at or before the date.
  const accountsByPlatform = new Map<Platform, { points: Map<string, number> }[]>();
  for (const account of dashboard.followers) {
    if (!PLATFORMS.includes(account.platform) || account.points.length === 0) continue;
    const points = new Map(
      account.points.map((point) => [point.captured_at.slice(0, 10), point.followers]),
    );
    const list = accountsByPlatform.get(account.platform) ?? [];
    list.push({ points });
    accountsByPlatform.set(account.platform, list);
  }
  if (accountsByPlatform.size === 0) {
    return <EmptyInsight message={t("Follower history is not available yet.")} />;
  }
  const dates = [
    ...new Set(
      [...accountsByPlatform.values()].flatMap((accounts) =>
        accounts.flatMap((account) => [...account.points.keys()]),
      ),
    ),
  ].sort();
  const data = dates.map((date) => {
    const row: Record<string, number | string> = {
      label: new Intl.DateTimeFormat(language, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`)),
    };
    for (const [platform, accounts] of accountsByPlatform) {
      let total = 0;
      let measured = false;
      for (const account of accounts) {
        const latest = [...account.points.entries()].filter(([day]) => day <= date).at(-1);
        if (latest) {
          total += latest[1];
          measured = true;
        }
      }
      if (measured) row[platform] = total;
    }
    return row;
  });
  const comparableRows = platformRows(dashboard);
  const current = comparableRows.reduce((sum, row) => sum + (row.followers ?? 0), 0);
  const gain = comparableRows.reduce((sum, row) => sum + (row.follower_gain ?? 0), 0);
  return (
    <InsightCard
      title={t("Follower evolution")}
      description={t("Current {current} · net {gain} in this range", {
        current: formatAnalyticsInteger(current, language),
        gain: `${gain >= 0 ? "+" : ""}${formatAnalyticsInteger(gain, language)}`,
      })}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => formatAnalyticsInteger(value, language)}
            />
            <Tooltip content={<ChartTooltip />} />
            <Legend />
            {[...accountsByPlatform.keys()].map((platform) => (
              <Line
                key={platform}
                type="monotone"
                dataKey={platform}
                name={platformDisplayName(platform)}
                stroke={PLATFORM_COLORS[platform]}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

/** Ranked content formats with every stored value visible and one comparison bar. */
export function ContentFormatBreakdown({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const rows = dashboard.formats.filter((row) => row.posts > 0);
  if (rows.length === 0) return <EmptyInsight message={t("No published posts in this range.")} />;
  const sorted = [...rows].sort((left, right) => right.avg_engagement - left.avg_engagement);
  const max = Math.max(1, ...sorted.map((row) => row.avg_engagement));
  return (
    <InsightCard
      title={t("Content format breakdown")}
      description={t("Posts, per-post averages, and totals stay separate.")}
    >
      <ul className="flex flex-1 flex-col gap-4">
        {sorted.map((row) => (
          <li key={row.format} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="justify-center text-[10px]">
                  {analyticsFormatLabel(row.format, t)}
                </Badge>
                <span className="truncate text-xs text-ink-2">
                  {t("{count} posts", { count: formatAnalyticsInteger(row.posts, language) })}
                </span>
              </div>
              {row === sorted[0] && <Badge className="text-[10px]">{t("Best")}</Badge>}
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-ink-3">{t("Avg engagement")}</dt>
                <dd className="font-mono tabular-nums text-ink">
                  {formatAverage(row.avg_engagement, language)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-3">{t("Avg views")}</dt>
                <dd className="font-mono tabular-nums text-ink">
                  {formatAverage(row.avg_views, language)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-3">{t("Total engagement")}</dt>
                <dd className="font-mono tabular-nums text-ink">
                  {formatAnalyticsInteger(row.engagement, language)}
                </dd>
              </div>
            </dl>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent w-(--bar-width)"
                style={
                  {
                    "--bar-width": `${Math.max(2, (row.avg_engagement / max) * 100)}%`,
                  } as React.CSSProperties
                }
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-ink-3">
        {t("Bars compare average engagement per post.")}
      </p>
      <p className="mt-1 text-[11px] text-ink-3">
        {t("Formats are derived from each published Distribution's frozen attachments.")}
      </p>
    </InsightCard>
  );
}

type PlatformSortKey =
  | "posts"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "reach"
  | "impressions"
  | "engagement_rate"
  | "followers"
  | "follower_gain";

/**
 * Sorts platform metrics with honest null cells. Native column sizing fills the
 * available width using only visible metrics; narrow viewports scroll locally.
 */
export function PlatformBreakdownTable({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [sort, setSort] = useState<{ key: PlatformSortKey; direction: "asc" | "desc" }>({
    direction: "desc",
    key: "views",
  });
  const rows = platformRows(dashboard);
  if (rows.length === 0) return <EmptyInsight message={t("No published posts in this range.")} />;
  const sorted = [...rows].sort((left, right) => {
    const leftValue = left[sort.key] ?? -1;
    const rightValue = right[sort.key] ?? -1;
    return (Number(leftValue) - Number(rightValue)) * (sort.direction === "asc" ? 1 : -1);
  });
  const columns: readonly { key: PlatformSortKey; label: string }[] = [
    { key: "posts", label: t("Posts") },
    { key: "views", label: t("Views") },
    { key: "likes", label: t("Likes") },
    { key: "comments", label: t("Comments") },
    { key: "shares", label: t("Shares") },
    { key: "reach", label: t("Reach") },
    { key: "impressions", label: t("Impressions") },
    { key: "engagement_rate", label: t("Engagement rate") },
    { key: "followers", label: t("Followers") },
    { key: "follower_gain", label: t("Follower gain") },
  ];
  const showSaves = sorted.some((row) => row.saves !== null);
  const showClicks = sorted.some((row) => row.clicks !== null);
  const untracked = [!showSaves ? t("Saves") : null, !showClicks ? t("Clicks") : null].filter(
    (value): value is string => value !== null,
  );
  const sortBy = (key: PlatformSortKey) =>
    setSort((current) => ({
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
      key,
    }));
  const value = (row: AnalyticsPlatformBreakdown, key: PlatformSortKey) => {
    const raw = row[key];
    if (raw === null) return "—";
    if (key === "engagement_rate") return `${(Number(raw) * 100).toFixed(1)}%`;
    if (key === "follower_gain")
      return `${Number(raw) >= 0 ? "+" : ""}${formatAnalyticsInteger(Number(raw), language)}`;
    return formatAnalyticsInteger(Number(raw), language);
  };
  return (
    <div>
      <div className="overflow-x-auto">
        <Table className="min-w-[1080px] table-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">{t("Platform")}</TableHead>
              {columns.map((column) => (
                <TableHead key={column.key} className="whitespace-nowrap text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-xs font-medium text-ink-3 hover:text-ink"
                    aria-label={t("Sort by {metric}", { metric: column.label })}
                    onClick={() => sortBy(column.key)}
                  >
                    {column.label}
                  </Button>
                </TableHead>
              ))}
              {showSaves && (
                <TableHead className="whitespace-nowrap text-right">{t("Saves")}</TableHead>
              )}
              {showClicks && (
                <TableHead className="whitespace-nowrap text-right">{t("Clicks")}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.platform}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <PlatformIcon provider={row.platform} className="size-4" />
                    {platformDisplayName(row.platform)}
                  </span>
                </TableCell>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className="whitespace-nowrap text-right font-mono tabular-nums"
                  >
                    {value(row, column.key)}
                  </TableCell>
                ))}
                {showSaves && (
                  <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                    {row.saves === null
                      ? t("Not tracked")
                      : formatAnalyticsInteger(row.saves, language)}
                  </TableCell>
                )}
                {showClicks && (
                  <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                    {row.clicks === null
                      ? t("Not tracked")
                      : formatAnalyticsInteger(row.clicks, language)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {untracked.length > 0 && (
        <p className="px-4 pb-3 pt-2 text-[11px] text-ink-3">
          {t("Not tracked by the connected providers: {metrics}.", {
            metrics: untracked.join(", "),
          })}
        </p>
      )}
    </div>
  );
}
