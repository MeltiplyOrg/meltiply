import { useState, type CSSProperties } from "react";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import {
  formatAnalyticsInteger,
  ANALYTICS_METRICS,
} from "@/components/analytics/analytics-helpers";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { useI18n } from "@/lib/i18n";
import type { AnalyticsMetric } from "@/types";
import type { PostAnalyticsSummary } from "./posts-helpers";
import { postAnalyticsColumns } from "./post-view-options";

/**
 * Read-only stored analytics for one Post: measured totals followed by a
 * per-Channel bar comparison for the selected stored metric.
 *
 * The bars are decorative; every row names its Channel and exact value, so the
 * comparison stays readable without color or hover. Channels are ordered by the
 * selected metric so the strongest Channel leads; a missing counter reads
 * "Not tracked" instead of an inferred zero.
 *
 * @param analytics - Resolved visibility, totals, and per-Channel snapshots.
 * @returns The inspector analytics section, or null when the Post is not published.
 */
export function PostAnalyticsSection({ analytics }: { analytics: PostAnalyticsSummary }) {
  const { t, language } = useI18n();
  const [metric, setMetric] = useState<AnalyticsMetric>("views");
  const labels = new Map(postAnalyticsColumns(t).map((column) => [column.id, column.name]));
  if (!analytics.visible) return null;

  const metricValue = (channel: PostAnalyticsSummary["channels"][number]) => {
    const value = channel.analytics[metric];
    return value === null ? null : value;
  };
  const max = Math.max(1, ...analytics.channels.map((channel) => metricValue(channel) ?? 0));
  const channels = [...analytics.channels].sort(
    (left, right) => (metricValue(right) ?? -1) - (metricValue(left) ?? -1),
  );

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
          {channels.length > 0 && (
            <figure className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink-2">{t("Channels")}</span>
                <SegmentedControl
                  options={ANALYTICS_METRICS}
                  value={metric}
                  onChange={setMetric}
                  label={t("Metric")}
                  renderOption={(value) => labels.get(value) ?? value}
                />
              </div>
              <ul aria-label={t("Channels")} className="mt-2 flex flex-col gap-2">
                {channels.map((channel) => {
                  const value = metricValue(channel);
                  return (
                    <li key={channel.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <PlatformIcon provider={channel.platform} className="size-3.5" />
                          <span className="truncate text-xs text-ink-2">{channel.label}</span>
                        </span>
                        <span className="font-mono text-xs tabular-nums text-ink">
                          {value === null
                            ? t("Not tracked")
                            : formatAnalyticsInteger(value, language)}
                        </span>
                      </div>
                      <div
                        aria-hidden="true"
                        className="h-1.5 overflow-hidden rounded-full bg-hover-2"
                      >
                        <div
                          className="h-full rounded-full bg-accent w-(--bar-width)"
                          style={
                            {
                              "--bar-width": `${value === null ? 0 : Math.max(2, (value / max) * 100)}%`,
                            } as CSSProperties
                          }
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </figure>
          )}
          <p className="mt-2 text-[11px] text-ink-3">
            {t("Latest stored snapshots from this post's published channels, not live activity.")}
          </p>
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
