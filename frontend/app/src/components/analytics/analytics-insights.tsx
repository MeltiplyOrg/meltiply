import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Badge } from "@meltiply/ui/badge";
import { Button } from "@meltiply/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@meltiply/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meltiply/ui/table";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { formatAnalyticsInteger } from "./analytics-helpers";
import { analyticsFormatLabel, analyticsMetricLabel } from "./analytics-toolbar";
import type {
  AnalyticsBestTime,
  AnalyticsDashboard,
  AnalyticsDaySeries,
  AnalyticsMetric,
  AnalyticsPlatformBreakdown,
  Platform,
} from "@/types";

type Grouping = "day" | "week" | "month";

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
    <Card>
      <CardHeader className="gap-1 p-4 pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <p className="text-xs text-ink-3">{description}</p>}
      </CardHeader>
      <CardContent className="p-4">{children}</CardContent>
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

function GroupingToggle({
  grouping,
  onChange,
}: {
  grouping: Grouping;
  onChange: (grouping: Grouping) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t("Group by")}>
      {(["day", "week", "month"] as const).map((value) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={grouping === value ? "secondary" : "ghost"}
          aria-pressed={grouping === value}
          onClick={() => onChange(value)}
          className="h-7 px-2 text-xs"
        >
          {groupingLabel(value, t)}
        </Button>
      ))}
    </div>
  );
}

function MetricToggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-pressed={active}
      onClick={onClick}
      className="h-7 px-2 text-xs"
    >
      {label}
    </Button>
  );
}

function platformRows(dashboard: AnalyticsDashboard) {
  return dashboard.platforms.filter((row) => PLATFORMS.includes(row.platform));
}

/** Posts published on each Platform, with the cohort total in the header. */
export function PostsPerPlatformChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const rows = [...platformRows(dashboard)].sort((left, right) => right.posts - left.posts);
  const total = rows.reduce((sum, row) => sum + row.posts, 0);
  if (rows.length === 0) return <EmptyInsight message={t("No published posts in this range.")} />;
  return (
    <InsightCard
      title={t("Posts per platform")}
      description={t("{count} published destinations", {
        count: formatAnalyticsInteger(total, language),
      })}
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ bottom: 0, left: 0, right: 0, top: 18 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis
              dataKey="platform"
              tickFormatter={(value: Platform) => platformDisplayName(value)}
              tickLine={false}
              axisLine={false}
            />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-2)" }} />
            <Bar dataKey="posts" name={t("Posts")} radius={[3, 3, 0, 0]} maxBarSize={42}>
              {rows.map((row) => (
                <Cell key={row.platform} fill={PLATFORM_COLORS[row.platform]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

/** Stacked publication counts per time bucket and Platform. */
export function PostsOverTimeChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [grouping, setGrouping] = useState<Grouping>("week");
  const buckets = groupSeries(dashboard.series, grouping, language);
  if (buckets.length === 0)
    return <EmptyInsight message={t("No published posts in this range.")} />;
  const platforms = PLATFORMS.filter((platform) =>
    dashboard.series.some((row) => row.platform === platform && row.posts > 0),
  );
  return (
    <InsightCard
      title={t("Posts over time")}
      description={t("Publishing consistency by platform.")}
    >
      <div className="mb-2 flex justify-end">
        <GroupingToggle grouping={grouping} onChange={setGrouping} />
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ bottom: 0, left: 0, right: 0, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-2)" }} />
            <Legend />
            {platforms.map((platform) => (
              <Bar
                key={platform}
                dataKey={platform}
                stackId="posts"
                name={platformDisplayName(platform)}
                fill={PLATFORM_COLORS[platform]}
                maxBarSize={42}
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

function metricSeries(
  dashboard: AnalyticsDashboard,
  grouping: Grouping,
  language: Language,
  metric: AnalyticsMetric,
) {
  const buckets = groupSeries(dashboard.series, grouping, language);
  return buckets.map((bucket) => ({
    ...bucket,
    value: PLATFORMS.reduce(
      (sum, platform) => sum + Number(bucket[`${platform}_${metric}`] ?? 0),
      0,
    ),
  }));
}

/** One selected stored metric over time; likes/comments/shares/views share this chart. */
export function MetricOverTimeChart({
  dashboard,
  metric,
}: {
  dashboard: AnalyticsDashboard;
  metric: AnalyticsMetric;
}) {
  const { t, language } = useI18n();
  const [grouping, setGrouping] = useState<Grouping>("week");
  const data = metricSeries(dashboard, grouping, language, metric);
  if (data.length === 0)
    return <EmptyInsight message={t("No measured changes in this range yet.")} />;
  return (
    <InsightCard
      title={t("{metric} over time", { metric: analyticsMetricLabel(metric, t) })}
      description={t("Measured change between stored snapshots.")}
    >
      <div className="mb-2 flex justify-end">
        <GroupingToggle grouping={grouping} onChange={setGrouping} />
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ bottom: 0, left: 0, right: 0, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={48} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-2)" }} />
            <Bar
              dataKey="value"
              name={analyticsMetricLabel(metric, t)}
              fill="var(--accent)"
              radius={[3, 3, 0, 0]}
              maxBarSize={36}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

/** Multi-series likes/comments/shares trend on one comparable scale. */
export function EngagementOverTimeChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [grouping, setGrouping] = useState<Grouping>("week");
  const [enabled, setEnabled] = useState<Record<"likes" | "comments" | "shares", boolean>>({
    comments: true,
    likes: true,
    shares: true,
  });
  const buckets = groupSeries(dashboard.series, grouping, language);
  const data = buckets.map((bucket) => {
    const row: Record<string, number | string> = { label: bucket.label };
    for (const metric of ["likes", "comments", "shares"] as const) {
      row[metric] = PLATFORMS.reduce(
        (sum, platform) => sum + Number(bucket[`${platform}_${metric}`] ?? 0),
        0,
      );
    }
    return row;
  });
  if (data.length === 0)
    return <EmptyInsight message={t("No measured changes in this range yet.")} />;
  return (
    <InsightCard
      title={t("Engagement over time")}
      description={t("Likes, comments, and shares measured between snapshots.")}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={t("Metrics")}>
          {(["likes", "comments", "shares"] as const).map((metric) => (
            <MetricToggle
              key={metric}
              active={enabled[metric]}
              label={analyticsMetricLabel(metric, t)}
              onClick={() => setEnabled((current) => ({ ...current, [metric]: !current[metric] }))}
            />
          ))}
        </div>
        <GroupingToggle grouping={grouping} onChange={setGrouping} />
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} />
            <Legend />
            {enabled.likes && (
              <Line
                type="monotone"
                dataKey="likes"
                name={t("Likes")}
                stroke="var(--accent)"
                strokeWidth={2}
                dot={false}
              />
            )}
            {enabled.comments && (
              <Line
                type="monotone"
                dataKey="comments"
                name={t("Comments")}
                stroke="var(--green)"
                strokeWidth={2}
                dot={false}
              />
            )}
            {enabled.shares && (
              <Line
                type="monotone"
                dataKey="shares"
                name={t("Shares")}
                stroke="var(--orange)"
                strokeWidth={2}
                dot={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const HOURS = Array.from({ length: 24 }, (_, index) => index);

function bestTimeValue(
  row: AnalyticsBestTime,
  metric: "avg_engagement" | "avg_likes" | "avg_views",
) {
  return row[metric];
}

/** Seven-by-twenty-four heatmap with a minimum sample before recommending a slot. */
export function BestTimeHeatmap({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<"avg_engagement" | "avg_likes" | "avg_views">(
    "avg_engagement",
  );
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
        <div className="flex items-center gap-1" role="group" aria-label={t("Metric")}>
          {(["avg_engagement", "avg_likes", "avg_views"] as const).map((value) => (
            <MetricToggle
              key={value}
              active={metric === value}
              label={
                value === "avg_engagement"
                  ? t("Engagement")
                  : analyticsMetricLabel(value === "avg_likes" ? "likes" : "views", t)
              }
              onClick={() => setMetric(value)}
            />
          ))}
        </div>
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
        <div className="grid min-w-[640px] grid-cols-[40px_repeat(24,minmax(16px,1fr))] gap-1">
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
                        className={`block size-full rounded-xs bg-accent ${opacityClass}`}
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
  if (dashboard.followers.length === 0) {
    return <EmptyInsight message={t("Follower history is not available yet.")} />;
  }
  const byPlatform = new Map<Platform, Map<string, number>>();
  for (const account of dashboard.followers) {
    const points = byPlatform.get(account.platform) ?? new Map<string, number>();
    for (const point of account.points) {
      const day = point.captured_at.slice(0, 10);
      points.set(day, (points.get(day) ?? 0) + point.followers);
    }
    byPlatform.set(account.platform, points);
  }
  const dates = [
    ...new Set([...byPlatform.values()].flatMap((points) => [...points.keys()])),
  ].sort();
  const data = dates.map((date) => {
    const row: Record<string, number | string> = {
      label: new Intl.DateTimeFormat(language, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`)),
    };
    for (const [platform, points] of byPlatform) {
      const latest = [...points.entries()].filter(([day]) => day <= date).at(-1);
      if (latest) row[platform] = latest[1];
    }
    return row;
  });
  const current = dashboard.platforms.reduce((sum, row) => sum + (row.followers ?? 0), 0);
  const gain = dashboard.platforms.reduce((sum, row) => sum + (row.follower_gain ?? 0), 0);
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
            {[...byPlatform.keys()].map((platform) => (
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

/** Ranked content formats with total/average separation and a best badge. */
export function ContentFormatBreakdown({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<"avg_engagement" | "avg_views" | "engagement">(
    "avg_engagement",
  );
  const rows = dashboard.formats.filter((row) => row.posts > 0);
  if (rows.length === 0) return <EmptyInsight message={t("No published posts in this range.")} />;
  const sorted = [...rows].sort((left, right) => right[metric] - left[metric]);
  const max = Math.max(1, ...sorted.map((row) => row[metric]));
  return (
    <InsightCard
      title={t("Content format breakdown")}
      description={t("Totals and per-post averages stay separate.")}
    >
      <div className="mb-3 flex items-center gap-1" role="group" aria-label={t("Metric")}>
        {(["avg_engagement", "avg_views", "engagement"] as const).map((value) => (
          <MetricToggle
            key={value}
            active={metric === value}
            label={
              value === "avg_engagement"
                ? t("Avg engagement")
                : value === "avg_views"
                  ? t("Avg views")
                  : t("Total engagement")
            }
            onClick={() => setMetric(value)}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-3">
        {sorted.map((row) => (
          <li key={row.format} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
            <Badge variant="outline" className="justify-center text-[10px]">
              {analyticsFormatLabel(row.format, t)}
            </Badge>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-ink-2">
                  {t("{count} posts", { count: formatAnalyticsInteger(row.posts, language) })}
                </span>
                <span className="font-mono tabular-nums text-ink">
                  {metric === "engagement"
                    ? formatAnalyticsInteger(row.engagement, language)
                    : formatAverage(row[metric], language)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent w-(--bar-width)"
                  style={
                    {
                      "--bar-width": `${Math.max(2, (row[metric] / max) * 100)}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            </div>
            {row === sorted[0] && <Badge className="text-[10px]">{t("Best")}</Badge>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-ink-3">
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

/** Consolidated platform table with client-side sorting and honest null cells. */
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
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Platform")}</TableHead>
            {columns.map((column) => (
              <TableHead key={column.key} className="text-right">
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
            <TableHead className="text-right">{t("Saves")}</TableHead>
            <TableHead className="text-right">{t("Clicks")}</TableHead>
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
                <TableCell key={column.key} className="text-right font-mono tabular-nums">
                  {value(row, column.key)}
                </TableCell>
              ))}
              <TableCell className="text-right text-ink-3">
                {row.saves === null
                  ? t("Not tracked")
                  : formatAnalyticsInteger(row.saves, language)}
              </TableCell>
              <TableCell className="text-right text-ink-3">
                {row.clicks === null
                  ? t("Not tracked")
                  : formatAnalyticsInteger(row.clicks, language)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Weekly platform observations; no causal trend line is inferred. */
export function FrequencyScatterChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t, language } = useI18n();
  const points = new Map<
    Platform,
    { engagementRate: number; posts: number; views: number; week: string }[]
  >();
  const weekly = groupSeries(dashboard.series, "week", language);
  for (const bucket of weekly) {
    for (const platform of PLATFORMS) {
      const posts = Number(bucket[platform] ?? 0);
      const views = Number(bucket[`${platform}_views`] ?? 0);
      const engagement =
        Number(bucket[`${platform}_likes`] ?? 0) +
        Number(bucket[`${platform}_comments`] ?? 0) +
        Number(bucket[`${platform}_shares`] ?? 0);
      if (posts === 0 || views === 0) continue;
      const list = points.get(platform) ?? [];
      list.push({
        engagementRate: (engagement / views) * 100,
        posts,
        views,
        week: String(bucket.label),
      });
      points.set(platform, list);
    }
  }
  if (points.size === 0)
    return (
      <EmptyInsight message={t("Not enough measured weeks to compare frequency and engagement.")} />
    );
  return (
    <InsightCard
      title={t("Posting frequency vs engagement")}
      description={t("Weekly platform observations. Correlation is not causation.")}
    >
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ bottom: 8, left: 0, right: 8, top: 8 }}>
            <CartesianGrid stroke="var(--line)" />
            <XAxis
              type="number"
              dataKey="posts"
              name={t("Posts")}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="number"
              dataKey="engagementRate"
              name={t("Engagement rate")}
              unit="%"
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <ZAxis range={[60, 60]} />
            <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: "3 3" }} />
            <Legend />
            {[...points.entries()].map(([platform, data]) => (
              <Scatter
                key={platform}
                name={platformDisplayName(platform)}
                data={data}
                fill={PLATFORM_COLORS[platform]}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}

/** Average cumulative engagement at fixed elapsed-time milestones. */
export function AccumulationChart({ dashboard }: { dashboard: AnalyticsDashboard }) {
  const { t } = useI18n();
  const data = dashboard.accumulation.map((point) => ({
    ...point,
    label:
      point.elapsed_hours < 24
        ? `${point.elapsed_hours}h`
        : point.elapsed_hours < 168
          ? `${Math.round(point.elapsed_hours / 24)}d`
          : `${Math.round(point.elapsed_hours / 168)}w`,
  }));
  if (data.length === 0)
    return <EmptyInsight message={t("No measured engagement history in this range.")} />;
  return (
    <InsightCard
      title={t("Engagement accumulation")}
      description={t("Average engagement at elapsed time since publication.")}
    >
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} />
            <Line
              type="monotone"
              dataKey="avg_engagement"
              name={t("Average engagement")}
              stroke="var(--accent)"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </InsightCard>
  );
}
