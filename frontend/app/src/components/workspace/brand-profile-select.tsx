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

/**
 * Props for {@link BrandProfileSelect}, the canonical Brand Profile picker
 * shared by the Channels and Posts toolbars.
 */
export interface BrandProfileSelectProps {
  /**
   * Currently selected option value. `"all"` selects the aggregate
   * "All Brand Profiles" row; any other value is a profile id.
   */
  value: string;
  /** Invoked with the chosen value (`"all"` or a profile id) when selection changes. */
  onValueChange: (value: string) => void;
  /** Resolved workspace Brand Profiles rendered first, in input order. */
  brandProfiles: BrandProfile[];
  /**
   * Profile ids still referenced by visible content but absent from
   * `brandProfiles`; each renders once as a name-only "Unknown profile" row so
   * stale references stay selectable instead of silently dropping out.
   */
  unresolvedProfileIds?: readonly string[];
  /**
   * Trigger element rendered inside `SelectTrigger asChild` (typically a
   * `TopToolbarButton`), preserving each screen's toolbar trigger geometry.
   * Its `label` prop — the visible selected-value text — doubles as the
   * trigger's accessible name: `role="combobox"` forbids name-from-content,
   * so the name must be supplied explicitly, and reusing the rendered label
   * keeps name and visible text identical instead of masking the selected
   * profile behind a generic field label.
   */
  trigger: ReactElement<{ label?: string }>;
  /**
   * Accessible name applied as `aria-label` on the dropdown listbox content;
   * also the trigger-name fallback when the trigger element exposes no
   * `label` prop.
   */
  label: string;
  /**
   * Whether the aggregate "All Brand Profiles" row stays in the list. Filters
   * keep it so a view can show every profile at once; surfaces that must act on
   * one profile (composing or publishing) pass `false` and let the trigger
   * state the profile instead.
   */
  includeAggregate?: boolean;
}

/**
 * Resolves the visible trigger label for a Brand Profile filter selection.
 *
 * Single label contract shared by the Channels and Posts toolbars so both render
 * identical text for the same selection state. The aggregate sentinels — `null`
 * (Channels) and `"all"` (Posts) — map to "All Brand Profiles"; a concrete id maps
 * to the profile's name, or "Unknown profile" when the id is absent from
 * `brandProfiles` (matching the unresolved rows {@link BrandProfileSelect} renders).
 *
 * @param selection - Selected profile id, `"all"`, or `null` for the aggregate option.
 * @param brandProfiles - Resolved workspace Brand Profiles available for naming.
 * @param t - Translation function from `useI18n`.
 * @returns Localized label text for the filter trigger.
 */
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

/** One selectable Brand Profile row: the aggregate choice, a profile, or an unresolved id. */
interface BrandProfileOption {
  id: string;
  name: string;
}

/**
 * Canonical controlled Brand Profile Select for the Channels and Posts toolbars.
 *
 * Owns the dropdown's whole construction: the `Select` root, the caller-supplied
 * trigger, the aggregate "All Brand Profiles" row, the separator, and one
 * plain option per profile. Selection is the only interaction — profile
 * details and editing live in the Channels directory cards and the
 * profile editor, never inside this list.
 *
 * Options are built here as the single construction path — resolved profiles in
 * input order followed by unique unresolved ids as name-only "Unknown profile"
 * rows — so both screens share identical ordering and layout semantics. The
 * trigger's accessible name is the trigger element's own `label` (the
 * selected-value text); `label` names the listbox instead of masking that
 * selection.
 *
 * @param props - Selection state, profile data, trigger, and label.
 * @returns A complete Select dropdown ready to drop into a toolbar.
 */
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

/** Builds resolved profiles followed by unique unknown references for either selection mode. */
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

/**
 * Multi-profile collection filter using the same option roster as ownership
 * selection. Empty means all profiles; selections are OR-matched by the caller.
 * This does not assign multiple owners to a composed Post.
 */
export function BrandProfileFilterSelect({
  value,
  onValueChange,
  brandProfiles,
  unresolvedProfileIds,
  trigger,
}: {
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  brandProfiles: readonly BrandProfile[];
  unresolvedProfileIds?: readonly string[];
  trigger: ReactElement;
}) {
  const { t } = useI18n();
  const options = useBrandProfileOptions(brandProfiles, unresolvedProfileIds);
  return (
    <FilterChecklist
      value={value}
      onValueChange={onValueChange}
      trigger={trigger}
      label={t("Brand Profile")}
      aggregateLabel={t("All Brand Profiles")}
      className="w-max max-w-80"
      options={options.map((option) => ({ value: option.id, label: option.name }))}
    />
  );
}
