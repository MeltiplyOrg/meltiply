import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@meltiply/ui/card";
import { Button } from "@meltiply/ui/button";
import { Skeleton } from "@meltiply/ui/skeleton";
import { formatAnalyticsInteger } from "@/components/analytics/analytics-helpers";
import { useSessionScope } from "@/hooks/use-session-scope";
import { usePostAnalyticsHistory } from "@/lib/queries";
import { useI18n } from "@/lib/i18n";
import type { PostAnalyticsSummary } from "./posts-helpers";
import { postAnalyticsColumns } from "./post-view-options";
import { postAnalyticsHistory, type PostAnalyticsPoint } from "./post-analytics-history";

const ENGAGEMENT = [
  { key: "likes", color: "var(--accent)", dash: undefined },
  { key: "comments", color: "var(--green)", dash: "5 3" },
  { key: "shares", color: "var(--orange)", dash: "2 3" },
] as const;
const EXPOSURE = [
  { key: "reach", color: "var(--accent)", dash: undefined },
  { key: "impressions", color: "var(--green)", dash: "5 3" },
] as const;

/**
 * One responsive, absolute-count timeline using the Analytics Recharts grammar
 * and canonical Card owner. Linear segments join observed measurements only;
 * dots preserve single-snapshot visibility. A hidden table exposes exact times
 * and counts without requiring hover or color perception.
 */
function PostTimeline({
  title,
  data,
  series,
}: {
  title: string;
  data: PostAnalyticsPoint[];
  series: readonly ((typeof ENGAGEMENT)[number] | (typeof EXPOSURE)[number])[];
}) {
  const { t, language } = useI18n();
  const labels = new Map(postAnalyticsColumns(t).map((column) => [column.id, column.name]));
  const withinTwoDays = (data.at(-1)?.timestamp ?? 0) - (data[0]?.timestamp ?? 0) < 172_800_000;
  const { date, dateTime, count } = useMemo(
    () => ({
      date: new Intl.DateTimeFormat(language, {
        month: "short",
        day: "numeric",
        ...(withinTwoDays ? { hour: "numeric" } : {}),
      }),
      dateTime: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }),
      count: new Intl.NumberFormat(language, { notation: "compact" }),
    }),
    [language, withinTwoDays],
  );
  return (
    <Card className="min-w-0">
      <CardHeader className="p-4 pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-3">
        {series.length === 0 || data.length === 0 ? (
          <p className="flex h-52 items-center justify-center text-xs text-ink-3">
            {t("Not measured")}
          </p>
        ) : (
          <>
            <div className="h-52 text-[11px] text-ink-3" role="img" aria-label={title}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--line)" />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value: number) => date.format(value)}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                    stroke="var(--ink-3)"
                  />
                  <YAxis
                    width={40}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    tickFormatter={(value: number) => count.format(value)}
                    stroke="var(--ink-3)"
                  />
                  <Tooltip
                    labelFormatter={(value) => dateTime.format(Number(value))}
                    formatter={(value) => formatAnalyticsInteger(Number(value), language)}
                    contentStyle={{
                      background: "var(--surface)",
                      borderColor: "var(--line)",
                      borderRadius: "var(--radius-control)",
                      color: "var(--ink)",
                    }}
                  />
                  <Legend iconType="plainline" />
                  {series.map(({ key, color, dash }) => (
                    <Line
                      key={key}
                      dataKey={key}
                      name={labels.get(key)}
                      type="linear"
                      stroke={color}
                      strokeWidth={2}
                      strokeDasharray={dash}
                      dot={{ r: data.length === 1 ? 4 : 2, strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="sr-only">
              <table>
                <caption>{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("Date")}</th>
                    {series.map(({ key }) => (
                      <th key={key} scope="col">
                        {labels.get(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((point) => (
                    <tr key={point.timestamp}>
                      <th scope="row">{dateTime.format(point.timestamp)}</th>
                      {series.map(({ key }) => (
                        <td key={key}>{formatAnalyticsInteger(point[key], language)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Published Post totals and two stored-snapshot timelines: engagement counters,
 * then reach/impressions. Reads histories only while a published Post is inspected;
 * loading and retry states never replace failures with a fabricated flat line.
 * Totals carry each Channel's last reported value forward between its syncs;
 * reach is reported across Channels, not a deduplicated audience.
 */
export function PostAnalyticsSection({ analytics }: { analytics: PostAnalyticsSummary }) {
  const { t, language } = useI18n();
  const scope = useSessionScope();
  const history = usePostAnalyticsHistory(
    scope,
    analytics.visible ? analytics.channels.map((channel) => channel.id) : [],
  );
  const data = useMemo(
    () => postAnalyticsHistory(history.data?.flatMap((item) => item.snapshots) ?? []),
    [history.data],
  );
  const labels = new Map(postAnalyticsColumns(t).map((column) => [column.id, column.name]));
  if (!analytics.visible) return null;
  return (
    <section className="mt-6.5">
      <h3 className="mb-2 text-(length:--font-size-ui) font-semibold">{t("Analytics")}</h3>
      {analytics.awaiting ? (
        <p className="text-(length:--font-size-ui) text-ink-2">
          {t("Metrics appear after the first provider sync.")}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-0.5 sm:grid-cols-3">
            {analytics.metrics.map(({ id, value }) => (
              <div
                key={id}
                className="flex items-baseline justify-between gap-2 border-b border-line/60 py-1"
              >
                <dt className="text-(length:--font-size-control) text-ink-3">
                  {labels.get(id) ?? id}
                </dt>
                <dd className="font-mono tabular-nums text-(length:--font-size-control) text-ink">
                  {formatAnalyticsInteger(value, language)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 grid gap-4">
            {history.isPending ? (
              <>
                <Skeleton className="h-64" />
                <Skeleton className="h-64" />
              </>
            ) : history.isError ? (
              <div className="text-xs text-ink-2" role="alert">
                <p>{t("Analytics could not be loaded")}</p>
                <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
                  {t("Retry")}
                </Button>
              </div>
            ) : (
              <>
                <PostTimeline
                  title={t("Engagement over time")}
                  data={data}
                  series={ENGAGEMENT.filter(({ key }) => !analytics.untracked.includes(key))}
                />
                <PostTimeline
                  title={t("Reach & impressions over time")}
                  data={data}
                  series={EXPOSURE.filter(({ key }) => !analytics.untracked.includes(key))}
                />
              </>
            )}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            {t(
              "Cumulative stored measurements, not live activity. Reach is not deduplicated across channels.",
            )}
          </p>
          {history.data?.some((item) => item.snapshots.length === 500) && (
            <p className="mt-1 text-[11px] text-ink-3">
              {t("Showing the first 500 stored measurements per channel.")}
            </p>
          )}
          {analytics.untracked.length > 0 && (
            <p className="mt-1 text-[11px] text-ink-3">
              {t("Not tracked by the connected providers: {metrics}.", {
                metrics: analytics.untracked.map((id) => labels.get(id) ?? id).join(", "),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
