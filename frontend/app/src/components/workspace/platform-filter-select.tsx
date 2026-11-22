import type { ReactElement } from "react";
import { PLATFORM_IDS } from "@meltiply/domain";
import { FilterChecklist } from "@meltiply/ui/dropdown-menu";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";

export interface PlatformFilterSelectProps {
  value: readonly string[];
  onValueChange: (platforms: string[]) => void;
  trigger: ReactElement;
}

export function platformFilterLabel(
  selectedPlatforms: readonly string[],
  t: (message: string, values?: Record<string, number | string>) => string,
): string {
  if (selectedPlatforms.length === 0) {
    return t("All platforms");
  }
  if (selectedPlatforms.length === 1) {
    return platformDisplayName(selectedPlatforms[0]);
  }
  return t("{count} platforms", { count: selectedPlatforms.length });
}

export function PlatformFilterSelect({ value, onValueChange, trigger }: PlatformFilterSelectProps) {
  const { t } = useI18n();

  return (
    <FilterChecklist
      value={value}
      onValueChange={onValueChange}
      trigger={trigger}
      aggregateLabel={t("All platforms")}
      options={PLATFORM_IDS.map((platform) => ({
        value: platform,
        label: (
          <>
            <PlatformIcon provider={platform} className="size-3.5 mr-2" />
            {platformDisplayName(platform)}
          </>
        ),
      }))}
    />
  );
}
