import { useMemo, type ReactElement } from "react";
import type { BrandProfile } from "@/types";
import { useI18n } from "@/lib/i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@meltiply/ui/select";
import { FilterChecklist } from "@meltiply/ui/dropdown-menu";

export interface BrandProfileSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  brandProfiles: BrandProfile[];
  unresolvedProfileIds?: readonly string[];
  trigger: ReactElement<{ label?: string }>;
  label: string;
  includeAggregate?: boolean;
}

export function brandProfileFilterLabel(
  selection: string | null,
  brandProfiles: readonly BrandProfile[],
  t: (message: string) => string,
): string {
  if (selection === null || selection === "all") {
    return t("All Brand Profiles");
  }
  return brandProfiles.find((profile) => profile.id === selection)?.name ?? t("Unknown profile");
}

interface BrandProfileOption {
  id: string;
  name: string;
}

export function BrandProfileSelect({
  value,
  onValueChange,
  brandProfiles,
  unresolvedProfileIds,
  trigger,
  label,
  includeAggregate = true,
}: BrandProfileSelectProps) {
  const { t } = useI18n();

  const options = useBrandProfileOptions(brandProfiles, unresolvedProfileIds);

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger asChild aria-label={trigger.props.label ?? label}>
        {trigger}
      </SelectTrigger>
      <SelectContent align="start" className="w-max max-w-80" aria-label={label}>
        {includeAggregate && (
          <>
            <SelectItem value="all">
              <span className="block truncate text-left">{t("All Brand Profiles")}</span>
            </SelectItem>
            <SelectSeparator />
          </>
        )}
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            <span className="block truncate text-left">{option.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function useBrandProfileOptions(
  brandProfiles: readonly BrandProfile[],
  unresolvedProfileIds?: readonly string[],
) {
  const { t } = useI18n();
  return useMemo(() => {
    const list: BrandProfileOption[] = brandProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    }));
    const known = new Set(list.map((option) => option.id));
    for (const id of unresolvedProfileIds ?? []) {
      if (!known.has(id)) {
        known.add(id);
        list.push({ id, name: t("Unknown profile") });
      }
    }
    return list;
  }, [brandProfiles, unresolvedProfileIds, t]);
}

export function BrandProfileFilterSelect({
  value,
  onValueChange,
  brandProfiles,
  unresolvedProfileIds,
  trigger,
  includeAggregate = true,
}: {
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  brandProfiles: readonly BrandProfile[];
  unresolvedProfileIds?: readonly string[];
  trigger: ReactElement;
  includeAggregate?: boolean;
}) {
  const { t } = useI18n();
  const options = useBrandProfileOptions(brandProfiles, unresolvedProfileIds);
  return (
    <FilterChecklist
      value={value}
      onValueChange={onValueChange}
      trigger={trigger}
      label={t("Brand Profile")}
      aggregateLabel={includeAggregate ? t("All Brand Profiles") : undefined}
      className="w-max max-w-80"
      options={options.map((option) => ({ value: option.id, label: option.name }))}
    />
  );
}
