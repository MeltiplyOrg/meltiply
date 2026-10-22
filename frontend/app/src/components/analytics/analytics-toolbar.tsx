import { RotateCw } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { TopToolbar } from "@/components/layout/top-toolbar";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import type {
  AnalyticsFormat,
  AnalyticsMetric,
  AnalyticsRangePreset,
  Platform,
  PlatformAccount,
} from "@/types";

const RANGE_LABELS: Record<AnalyticsRangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "366d": "Last 12 months",
};

const FORMAT_LABELS: Record<AnalyticsFormat, string> = {
  carousel: "Carousel",
  image: "Image",
  text: "Text",
  video: "Video",
};

const METRIC_LABELS: Record<AnalyticsMetric, string> = {
  comments: "Comments",
  likes: "Likes",
  shares: "Shares",
  views: "Views",
};

/**
 * Localized label for a range preset. Exposed so the cohort caption and the
 * select share one wording instead of re-declaring the four labels.
 */
export function analyticsRangeLabel(
  range: AnalyticsRangePreset,
  t: (message: string) => string,
): string {
  return t(RANGE_LABELS[range]);
}

/** Localized label for an analytics metric, shared by headers, chart, and KPIs. */
export function analyticsMetricLabel(metric: AnalyticsMetric, t: (message: string) => string) {
  return t(METRIC_LABELS[metric]);
}

/** Localized label for a content-format filter. */
export function analyticsFormatLabel(format: AnalyticsFormat, t: (message: string) => string) {
  return t(FORMAT_LABELS[format]);
}

export interface AnalyticsToolbarProps {
  /** Connected accounts available for the selected Platform (or all). */
  accounts: readonly PlatformAccount[];
  /** Analytics-capable platforms offered as a single-select filter. */
  platforms: readonly Platform[];
  selectedAccountId: string | undefined;
  selectedFormat: AnalyticsFormat | undefined;
  selectedRange: AnalyticsRangePreset;
  selectedPlatform: Platform | undefined;
  selectedMetric: AnalyticsMetric;
  /** True while stored metrics are refetching; prior data stays visible. */
  refreshing: boolean;
  onAccountChange: (accountId: string | undefined) => void;
  onFormatChange: (format: AnalyticsFormat | undefined) => void;
  onRangeChange: (range: AnalyticsRangePreset) => void;
  onPlatformChange: (platform: Platform | undefined) => void;
  onMetricChange: (metric: AnalyticsMetric) => void;
  onRefresh: () => void;
}

/**
 * Analytics filter row: range preset, one platform, the ranking metric, and a
 * reload that only re-reads stored snapshots. Controls keep their geometry and
 * scroll horizontally on narrow screens rather than wrapping or disappearing.
 */
export function AnalyticsToolbar({
  accounts,
  platforms,
  selectedAccountId,
  selectedFormat,
  selectedRange,
  selectedPlatform,
  selectedMetric,
  refreshing,
  onAccountChange,
  onFormatChange,
  onRangeChange,
  onPlatformChange,
  onMetricChange,
  onRefresh,
}: AnalyticsToolbarProps): React.ReactElement {
  const { t } = useI18n();
  const platformValue = selectedPlatform ?? "all";
  const accountOptions = selectedPlatform
    ? accounts.filter((account) => account.platform === selectedPlatform)
    : accounts;
  return (
    <TopToolbar className="flex-nowrap overflow-x-auto">
      <Select
        value={selectedRange}
        onValueChange={(value) => onRangeChange(value as AnalyticsRangePreset)}
      >
        <SelectTrigger className="w-36 shrink-0" aria-label={t("Range")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(RANGE_LABELS) as AnalyticsRangePreset[]).map((range) => (
            <SelectItem key={range} value={range}>
              {analyticsRangeLabel(range, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={platformValue}
        onValueChange={(value) =>
          onPlatformChange(value === "all" ? undefined : (value as Platform))
        }
        disabled={platforms.length === 0}
      >
        <SelectTrigger className="w-40 shrink-0" aria-label={t("Platform")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("All platforms")}</SelectItem>
          {platforms.map((platform) => (
            <SelectItem key={platform} value={platform}>
              <span className="flex items-center gap-2">
                <PlatformIcon provider={platform} className="size-3.5" />
                {platformDisplayName(platform)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selectedAccountId ?? "all"}
        onValueChange={(value) => onAccountChange(value === "all" ? undefined : value)}
        disabled={accountOptions.length === 0}
      >
        <SelectTrigger className="w-44 shrink-0" aria-label={t("Account")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("All accounts")}</SelectItem>
          {accountOptions.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              <span className="flex items-center gap-2">
                <PlatformIcon provider={account.platform} className="size-3.5" />
                <span className="truncate">{account.display_name ?? account.platform_user_id}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selectedFormat ?? "all"}
        onValueChange={(value) =>
          onFormatChange(value === "all" ? undefined : (value as AnalyticsFormat))
        }
      >
        <SelectTrigger className="w-36 shrink-0" aria-label={t("Format")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("All formats")}</SelectItem>
          {(Object.keys(FORMAT_LABELS) as AnalyticsFormat[]).map((format) => (
            <SelectItem key={format} value={format}>
              {analyticsFormatLabel(format, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SegmentedControl
        options={METRIC_OPTIONS}
        value={selectedMetric}
        onChange={(metric) => onMetricChange(metric)}
        label={t("Metric")}
        className="shrink-0"
        renderOption={(metric) => analyticsMetricLabel(metric, t)}
      />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label={t("Refresh analytics")}
              aria-busy={refreshing}
            >
              <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
              <span className="hidden sm:inline">{t("Refresh")}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("Reloads stored metrics. Provider syncing runs on its own schedule.")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </TopToolbar>
  );
}

const METRIC_OPTIONS: readonly AnalyticsMetric[] = ["views", "likes", "comments", "shares"];
