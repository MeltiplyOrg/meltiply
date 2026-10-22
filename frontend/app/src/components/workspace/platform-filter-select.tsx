import type { ReactElement } from "react";
import { PLATFORM_IDS } from "@meltiply/domain";
import { FilterChecklist } from "@meltiply/ui/dropdown-menu";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";

/**
 * Props for {@link PlatformFilterSelect}, the canonical platform multi-select
 * filter shared by the Channels and Posts toolbars.
 */
export interface PlatformFilterSelectProps {
  /**
   * Currently selected contract platform ids. An empty array is the aggregate
   * "All platforms" state; any non-empty array restricts content to those
   * providers.
   */
  value: readonly string[];
  /**
   * Invoked with the next selection array whenever a checkbox toggles or the
   * aggregate "All platforms" row clears the filter.
   */
  onValueChange: (platforms: string[]) => void;
  /**
   * Trigger element rendered inside `DropdownMenuTrigger asChild` (typically a
   * `TopToolbarButton` whose `label` is {@link platformFilterLabel} output), so
   * each screen keeps stable trigger geometry while the
   * button's accessible name stays identical to the visible selection text.
   */
  trigger: ReactElement;
}

/**
 * Resolves the visible trigger label for a platform filter selection.
 *
 * Single label contract shared by the Channels and Posts toolbars so both render
 * identical text for the same selection state: the empty selection maps to
 * "All platforms", a single id maps to its brand display name, and anything
 * larger collapses to a "{count} platforms" summary.
 *
 * @param selectedPlatforms - Selected contract platform ids (empty = all).
 * @param t - Translation function from `useI18n`.
 * @returns Localized label text for the filter trigger.
 */
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

/**
 * Canonical controlled platform multi-select for the Channels and Posts toolbars.
 *
 * Owns the entire dropdown: the `DropdownMenu` root, the caller-supplied
 * trigger, the aggregate "All platforms" checkbox row, the separator, and one
 * checkbox row per canonical `PLATFORM_IDS` entry — the single roster source,
 * so neither caller re-declares the contract platform list. Every row uses
 * `onSelect` prevention to keep the menu open across toggles, preserving the
 * multi-pick workflow both toolbars previously implemented by hand.
 *
 * The trigger's accessible name is the trigger element's own rendered label
 * (the selected-value text), satisfying label-in-name; Radix names the opened
 * menu from that same trigger via `aria-labelledby`, keeping menu and trigger
 * naming consistent.
 *
 * @param props - Selection state, change handler, and caller-owned trigger.
 * @returns A complete platform filter dropdown ready to drop into a toolbar.
 */
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
