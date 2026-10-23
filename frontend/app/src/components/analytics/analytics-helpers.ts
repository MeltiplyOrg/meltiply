import type { Language } from "@/lib/i18n";
import { isAnalyticsRangePreset } from "@/lib/analytics-range";
import type {
  AnalyticsFormat,
  AnalyticsMetric,
  AnalyticsPostRow,
  AnalyticsRangePreset,
  AnalyticsSummary,
  Platform,
} from "@/types";

/** Stable metric order shared by the toolbar, headers, and KPI row. */
export const ANALYTICS_METRICS: readonly AnalyticsMetric[] = [
  "views",
  "likes",
  "comments",
  "shares",
];

const ANALYTICS_FORMATS: readonly AnalyticsFormat[] = ["text", "image", "video", "carousel"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Default metric when the URL carries no supported value. */
const DEFAULT_ANALYTICS_METRIC: AnalyticsMetric = "views";
/** Default range when the URL carries no supported value. */
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRangePreset = "30d";
/** Rows raised by one Load more action, bounded by the page's maximum. */
const ANALYTICS_LIMIT_STEP = 10;
/** Initial top-Posts page size. */
export const ANALYTICS_INITIAL_LIMIT = 10;
/** Maximum top-Posts window the page requests; the API allows up to 100. */
export const ANALYTICS_MAX_LIMIT = 50;
/** Daily sync cadence plus margin, after which the page warns about freshness. */
const ANALYTICS_STALE_AFTER_MS = 26 * 60 * 60 * 1_000;

/** Metric cell meaning derived from real coverage and snapshot state. */
export type AnalyticsMetricState = "measured" | "partial" | "unsupported" | "awaiting-sync";

/**
 * Resolves URL state without throwing: unknown ranges and metrics fall back to
 * their defaults, and an unsupported platform becomes the aggregate selection.
 *
 * @param searchParams - Current route query string.
 * @param availablePlatforms - Analytics-capable platforms offered by the toolbar.
 * @returns Parsed range, single Platform filter, and ranking metric.
 */
export function parseAnalyticsSearchParams(
  searchParams: URLSearchParams,
  availablePlatforms: readonly Platform[],
): {
  accountId: string | undefined;
  format: AnalyticsFormat | undefined;
  metric: AnalyticsMetric;
  platform: Platform | undefined;
  range: AnalyticsRangePreset;
} {
  const rangeValue = searchParams.get("range");
  const metricValue = searchParams.get("metric");
  const platformValue = searchParams.get("platform");
  const accountValue = searchParams.get("account");
  const formatValue = searchParams.get("format");
  return {
    accountId: accountValue && UUID_PATTERN.test(accountValue) ? accountValue : undefined,
    format: ANALYTICS_FORMATS.find((format) => format === formatValue),
    metric:
      metricValue === "likes" || metricValue === "comments" || metricValue === "shares"
        ? metricValue
        : DEFAULT_ANALYTICS_METRIC,
    platform: availablePlatforms.find((platform) => platform === platformValue),
    range: isAnalyticsRangePreset(rangeValue) ? rangeValue : DEFAULT_ANALYTICS_RANGE,
  };
}

/**
 * Serializes the page's shareable state. The range and metric are always
 * explicit; the platform is omitted for "All platforms".
 *
 * @param range - Selected range preset.
 * @param platform - Selected Platform, or undefined for the aggregate.
 * @param metric - Selected ranking metric.
 * @returns Query-string body without a leading `?`.
 */
export function formatAnalyticsSearchParams(input: {
  accountId?: string;
  format?: AnalyticsFormat;
  metric: AnalyticsMetric;
  platform?: Platform;
  range: AnalyticsRangePreset;
}): string {
  const params = new URLSearchParams({ metric: input.metric, range: input.range });
  if (input.platform) params.set("platform", input.platform);
  if (input.accountId) params.set("account", input.accountId);
  if (input.format) params.set("format", input.format);
  return params.toString();
}

/** Raises a top-Posts window by one step without exceeding the page maximum. */
export function nextAnalyticsLimit(current: number): number {
  return Math.min(current + ANALYTICS_LIMIT_STEP, ANALYTICS_MAX_LIMIT);
}

/**
 * Decides what a Post row's metric cells may display.
 *
 * `unsupported` wins over `awaiting-sync` because an unsupported Destination
 * can never produce a measurement; a row mixing supported and unsupported
 * Destinations reports `partial` with its honest sum, and a row with some
 * destinations still awaiting their first snapshot keeps its measured sum plus
 * the table's Awaiting sync badge. Only a fully supported row with a snapshot
 * is `measured`.
 *
 * @param row - Post row carrying platform coverage and sync state.
 * @returns Display state for every metric cell in the row.
 */
export function analyticsRowMetricState(
  row: Pick<AnalyticsPostRow, "last_synced_at" | "platforms" | "unsupported_platforms">,
): AnalyticsMetricState {
  if (row.platforms.length > 0 && row.unsupported_platforms.length === row.platforms.length) {
    return "unsupported";
  }
  if (row.last_synced_at === null) return "awaiting-sync";
  return row.unsupported_platforms.length > 0 ? "partial" : "measured";
}

/** Empty cohort state, or null when the page has real coverage to show. */
export type AnalyticsEmptyState = "no-posts" | "all-unsupported" | "awaiting-sync";

/**
 * Selects the cohort empty state from the summary's published coverage.
 *
 * A cohort with no published destinations is empty before coverage matters.
 * Every unsupported destination is its own state; otherwise all platforms
 * awaiting their first snapshot means metrics will appear later.
 *
 * @param summary - Successful summary response for the current cohort.
 * @returns The matching empty state, or null when metrics are available.
 */
export function resolveAnalyticsEmptyState(summary: AnalyticsSummary): AnalyticsEmptyState | null {
  if (summary.totals.post_count === 0) return "no-posts";
  const rows = summary.by_platform;
  if (
    rows.length > 0 &&
    rows.every((row) => summary.unsupported_platforms.includes(row.platform))
  ) {
    return "all-unsupported";
  }
  if (rows.length > 0 && rows.every((row) => row.last_synced_at === null)) return "awaiting-sync";
  return null;
}

/** True when the latest stored snapshot is older than the daily-sync warning margin. */
export function isAnalyticsStale(lastSyncedAt: string | null, now = Date.now()): boolean {
  if (lastSyncedAt === null) return false;
  const synced = new Date(lastSyncedAt).getTime();
  return Number.isFinite(synced) && now - synced > ANALYTICS_STALE_AFTER_MS;
}

const INTEGER_FORMATS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US"),
  es: new Intl.NumberFormat("es-ES"),
  "pt-BR": new Intl.NumberFormat("pt-BR"),
  fr: new Intl.NumberFormat("fr-FR"),
  de: new Intl.NumberFormat("de-DE"),
  it: new Intl.NumberFormat("it-IT"),
  zh: new Intl.NumberFormat("zh-CN"),
  vi: new Intl.NumberFormat("vi-VN"),
};

/** Formats an exact analytics integer with locale thousands separators. */
export function formatAnalyticsInteger(value: number, language: Language = "en"): string {
  return INTEGER_FORMATS[language].format(value);
}

const TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  year: "numeric",
};

const TIMESTAMP_FORMATS: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat("en-US", { ...TIMESTAMP_OPTIONS, hour: "numeric" }),
  es: new Intl.DateTimeFormat("es-ES", TIMESTAMP_OPTIONS),
  "pt-BR": new Intl.DateTimeFormat("pt-BR", TIMESTAMP_OPTIONS),
  fr: new Intl.DateTimeFormat("fr-FR", TIMESTAMP_OPTIONS),
  de: new Intl.DateTimeFormat("de-DE", TIMESTAMP_OPTIONS),
  it: new Intl.DateTimeFormat("it-IT", TIMESTAMP_OPTIONS),
  zh: new Intl.DateTimeFormat("zh-CN", TIMESTAMP_OPTIONS),
  vi: new Intl.DateTimeFormat("vi-VN", TIMESTAMP_OPTIONS),
};

/** Formats an exact timestamp for `title`, tooltips, and the freshness label. */
export function formatAnalyticsTimestamp(iso: string, language: Language = "en"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : TIMESTAMP_FORMATS[language].format(date);
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/**
 * Formats the publication time relative to now, falling back to seconds for
 * very recent Posts. The exact timestamp always accompanies this in the UI.
 */
export function formatAnalyticsRelativeTime(
  iso: string,
  language: Language = "en",
  now = Date.now(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const deltaSeconds = Math.round((date.getTime() - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, "second");
}
