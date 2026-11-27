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

export const ANALYTICS_METRICS: readonly AnalyticsMetric[] = [
  "views",
  "likes",
  "comments",
  "shares",
];

export const ANALYTICS_FORMATS: readonly AnalyticsFormat[] = ["text", "image", "video", "carousel"];
const ANALYTICS_FORMAT_SET: ReadonlySet<string> = new Set(ANALYTICS_FORMATS);

export function isAnalyticsFormat(value: string): value is AnalyticsFormat {
  return ANALYTICS_FORMAT_SET.has(value);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_ANALYTICS_METRIC: AnalyticsMetric = "views";
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRangePreset = "30d";
const ANALYTICS_LIMIT_STEP = 10;
export const ANALYTICS_INITIAL_LIMIT = 10;
export const ANALYTICS_MAX_LIMIT = 50;
const ANALYTICS_STALE_AFTER_MS = 26 * 60 * 60 * 1_000;

export type AnalyticsMetricState = "measured" | "partial" | "unsupported" | "awaiting-sync";

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

export function isCompactOnPhone(value: number): boolean {
  return value >= 10_000_000;
}

export function nextAnalyticsLimit(current: number): number {
  return Math.min(current + ANALYTICS_LIMIT_STEP, ANALYTICS_MAX_LIMIT);
}

export function analyticsRowMetricState(
  row: Pick<AnalyticsPostRow, "last_synced_at" | "platforms" | "unsupported_platforms">,
): AnalyticsMetricState {
  if (row.platforms.length > 0 && row.unsupported_platforms.length === row.platforms.length) {
    return "unsupported";
  }
  if (row.last_synced_at === null) return "awaiting-sync";
  return row.unsupported_platforms.length > 0 ? "partial" : "measured";
}

export type AnalyticsEmptyState = "no-posts" | "all-unsupported" | "awaiting-sync";

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

export function formatAnalyticsInteger(value: number, language: Language = "en"): string {
  return INTEGER_FORMATS[language].format(value);
}

const DECIMAL_FORMATS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }),
  es: new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }),
  "pt-BR": new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }),
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }),
  de: new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }),
  it: new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }),
  zh: new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }),
  vi: new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }),
};

export function formatAnalyticsDecimal(value: number, language: Language = "en"): string {
  return DECIMAL_FORMATS[language].format(value);
}

const WHOLE_FORMATS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }),
  es: new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }),
  "pt-BR": new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }),
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }),
  de: new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }),
  it: new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }),
  zh: new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }),
  vi: new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }),
};

export function formatAnalyticsWhole(value: number, language: Language = "en"): string {
  return WHOLE_FORMATS[language].format(value);
}
const COMPACT_FORMATS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }),
  es: new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, notation: "compact" }),
  "pt-BR": new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, notation: "compact" }),
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, notation: "compact" }),
  de: new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1, notation: "compact" }),
  it: new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, notation: "compact" }),
  zh: new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }),
  vi: new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1, notation: "compact" }),
};

export function formatAnalyticsCompact(value: number, language: Language = "en"): string {
  return COMPACT_FORMATS[language].format(value);
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

const RELATIVE_FORMATS: Record<Language, Intl.RelativeTimeFormat> = {
  en: new Intl.RelativeTimeFormat("en", { numeric: "auto" }),
  es: new Intl.RelativeTimeFormat("es", { numeric: "auto" }),
  "pt-BR": new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" }),
  fr: new Intl.RelativeTimeFormat("fr", { numeric: "auto" }),
  de: new Intl.RelativeTimeFormat("de", { numeric: "auto" }),
  it: new Intl.RelativeTimeFormat("it", { numeric: "auto" }),
  zh: new Intl.RelativeTimeFormat("zh", { numeric: "auto" }),
  vi: new Intl.RelativeTimeFormat("vi", { numeric: "auto" }),
};

export function formatAnalyticsRelativeTime(
  iso: string,
  language: Language = "en",
  now = Date.now(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const deltaSeconds = Math.round((date.getTime() - now) / 1_000);
  const formatter = RELATIVE_FORMATS[language];
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, "second");
}
