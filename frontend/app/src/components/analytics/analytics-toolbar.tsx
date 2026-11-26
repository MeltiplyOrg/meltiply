import { isPlatform } from "@meltiply/domain";
import { RotateCw } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  FilterSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@meltiply/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import {
  TopToolbar,
  TopToolbarButton,
  TopToolbarFilterChip,
  TopToolbarFilterChips,
  TopToolbarFilters,
  TopToolbarReset,
} from "@/components/layout/top-toolbar";
import {
  BrandProfileSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import { isAnalyticsRangePreset } from "@/lib/analytics-range";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import { ANALYTICS_FORMATS, DEFAULT_ANALYTICS_RANGE, isAnalyticsFormat } from "./analytics-helpers";
import type {
  AnalyticsFormat,
  AnalyticsMetric,
  AnalyticsRangePreset,
  BrandProfile,
  Platform,
  PlatformAccount,
} from "@/types";

const RANGE_OPTIONS: readonly AnalyticsRangePreset[] = ["7d", "30d", "90d", "366d"];

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

export function analyticsRangeLabel(
  range: AnalyticsRangePreset,
  t: (message: string) => string,
): string {
  return t(RANGE_LABELS[range]);
}

export function analyticsMetricLabel(metric: AnalyticsMetric, t: (message: string) => string) {
  return t(METRIC_LABELS[metric]);
}

export function analyticsFormatLabel(format: AnalyticsFormat, t: (message: string) => string) {
  return t(FORMAT_LABELS[format]);
}

export interface AnalyticsToolbarProps {
  accounts: readonly PlatformAccount[];
  brandProfiles: BrandProfile[];
  selectedBrandProfileId: string | null;
  onBrandProfileChange: (brandProfileId: string | null) => void;
  onResetFilters: () => void;
  platforms: readonly Platform[];
  selectedAccountId: string | undefined;
  selectedFormat: AnalyticsFormat | undefined;
  selectedRange: AnalyticsRangePreset;
  selectedPlatform: Platform | undefined;
  refreshing: boolean;
  onAccountChange: (accountId: string | undefined) => void;
  onFormatChange: (format: AnalyticsFormat | undefined) => void;
  onRangeChange: (range: AnalyticsRangePreset) => void;
  onPlatformChange: (platform: Platform | undefined) => void;
  onRefresh: () => void;
}

export function AnalyticsToolbar({
  accounts,
  brandProfiles,
  selectedBrandProfileId,
  onBrandProfileChange,
  onResetFilters,
  platforms,
  selectedAccountId,
  selectedFormat,
  selectedRange,
  selectedPlatform,
  refreshing,
  onAccountChange,
  onFormatChange,
  onRangeChange,
  onPlatformChange,
  onRefresh,
}: AnalyticsToolbarProps): React.ReactElement {
  const { t } = useI18n();
  const accountOptions = selectedPlatform
    ? accounts.filter((account) => account.platform === selectedPlatform)
    : accounts;
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const accountLabel = selectedAccount
    ? (selectedAccount.display_name ?? selectedAccount.platform_user_id)
    : t("Account");
  const profileLabel = brandProfileFilterLabel(selectedBrandProfileId, brandProfiles, t);
  const activeCount =
    Number(selectedBrandProfileId !== null) +
    Number(selectedRange !== DEFAULT_ANALYTICS_RANGE) +
    Number(selectedPlatform !== undefined) +
    Number(selectedAccountId !== undefined) +
    Number(selectedFormat !== undefined);
  return (
    <>
      <TopToolbar>
        <TopToolbarFilters
          activeCount={activeCount}
          onClearAll={onResetFilters}
          fields={[
            {
              id: "brandProfile",
              label: t("Brand Profile"),
              active: selectedBrandProfileId !== null,
              onClear: () => onBrandProfileChange(null),
              control: (
                <BrandProfileSelect
                  value={selectedBrandProfileId ?? "all"}
                  onValueChange={(id) => onBrandProfileChange(id === "all" ? null : id)}
                  brandProfiles={brandProfiles}
                  label={t("Brand Profile")}
                  trigger={<TopToolbarButton label={profileLabel} className="w-full" />}
                />
              ),
            },
            {
              id: "range",
              label: t("Range"),
              active: selectedRange !== DEFAULT_ANALYTICS_RANGE,
              onClear: () => onRangeChange(DEFAULT_ANALYTICS_RANGE),
              control: (
                <Select
                  value={selectedRange}
                  onValueChange={(value) => {
                    if (isAnalyticsRangePreset(value)) onRangeChange(value);
                  }}
                >
                  <SelectTrigger asChild aria-label={t("Range")}>
                    <TopToolbarButton
                      label={analyticsRangeLabel(selectedRange, t)}
                      className="w-full"
                    />
                  </SelectTrigger>
                  <SelectContent aria-label={t("Range")}>
                    {RANGE_OPTIONS.map((range) => (
                      <SelectItem key={range} value={range}>
                        {analyticsRangeLabel(range, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
            {
              id: "platform",
              label: t("Platform"),
              active: selectedPlatform !== undefined,
              onClear: () => onPlatformChange(undefined),
              control: (
                <FilterSelect
                  value={selectedPlatform ?? "all"}
                  onValueChange={(value) =>
                    onPlatformChange(
                      value === "all" ? undefined : isPlatform(value) ? value : undefined,
                    )
                  }
                  aggregateOption={{ value: "all", label: t("All platforms") }}
                  options={platforms.map((platform) => ({
                    value: platform,
                    label: platformDisplayName(platform),
                  }))}
                  ariaLabel={t("Platform")}
                  disabled={platforms.length === 0}
                  trigger={
                    <TopToolbarButton
                      label={
                        selectedPlatform
                          ? platformDisplayName(selectedPlatform)
                          : t("All platforms")
                      }
                      className="w-full"
                    />
                  }
                />
              ),
            },
            {
              id: "account",
              label: t("Account"),
              active: selectedAccountId !== undefined,
              onClear: () => onAccountChange(undefined),
              control: (
                <FilterSelect
                  value={selectedAccountId ?? "all"}
                  onValueChange={(value) => onAccountChange(value === "all" ? undefined : value)}
                  aggregateOption={{ value: "all", label: t("All accounts") }}
                  options={accountOptions.map((account) => ({
                    value: account.id,
                    label: account.display_name ?? account.platform_user_id,
                  }))}
                  ariaLabel={t("Account")}
                  trigger={
                    <TopToolbarButton
                      label={selectedAccountId ? accountLabel : t("All accounts")}
                      className="w-full"
                    />
                  }
                />
              ),
            },
            {
              id: "format",
              label: t("Format"),
              active: selectedFormat !== undefined,
              onClear: () => onFormatChange(undefined),
              control: (
                <FilterSelect
                  value={selectedFormat ?? "all"}
                  onValueChange={(value) =>
                    onFormatChange(
                      value === "all" ? undefined : isAnalyticsFormat(value) ? value : undefined,
                    )
                  }
                  aggregateOption={{ value: "all", label: t("All formats") }}
                  options={ANALYTICS_FORMATS.map((format) => ({
                    value: format,
                    label: analyticsFormatLabel(format, t),
                  }))}
                  ariaLabel={t("Format")}
                  trigger={
                    <TopToolbarButton
                      label={
                        selectedFormat ? analyticsFormatLabel(selectedFormat, t) : t("All formats")
                      }
                      className="w-full"
                    />
                  }
                />
              ),
            },
          ]}
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto shrink-0"
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
      {activeCount > 0 && (
        <TopToolbarFilterChips>
          {selectedBrandProfileId !== null && (
            <TopToolbarFilterChip label={profileLabel} onClear={() => onBrandProfileChange(null)} />
          )}
          {selectedRange !== DEFAULT_ANALYTICS_RANGE && (
            <TopToolbarFilterChip
              label={analyticsRangeLabel(selectedRange, t)}
              onClear={() => onRangeChange(DEFAULT_ANALYTICS_RANGE)}
            />
          )}
          {selectedPlatform && (
            <TopToolbarFilterChip
              label={platformDisplayName(selectedPlatform)}
              onClear={() => onPlatformChange(undefined)}
            />
          )}
          {selectedAccountId && (
            <TopToolbarFilterChip label={accountLabel} onClear={() => onAccountChange(undefined)} />
          )}
          {selectedFormat && (
            <TopToolbarFilterChip
              label={analyticsFormatLabel(selectedFormat, t)}
              onClear={() => onFormatChange(undefined)}
            />
          )}
          <TopToolbarReset hasActiveFilters onReset={onResetFilters} className="ml-auto" />
        </TopToolbarFilterChips>
      )}
    </>
  );
}
