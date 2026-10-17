import { useMemo, useRef, useState, type ReactElement } from "react";
import { Info, Pencil } from "lucide-react";
import type { BrandProfile } from "@/types";
import { useI18n } from "@/lib/i18n";
import { Button } from "@meltiply/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@meltiply/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";

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
  /**
   * Resolved workspace Brand Profiles rendered first, in input order, each with
   * its color swatch and edit affordance.
   */
  brandProfiles: BrandProfile[];
  /**
   * Profile ids still referenced by visible content but absent from
   * `brandProfiles`; each renders once as a name-only "Unknown profile" row so
   * stale references stay selectable instead of silently dropping out.
   */
  unresolvedProfileIds?: readonly string[];
  /** Invoked with a resolved profile when its edit affordance is activated. */
  onEditProfile?: (profile: BrandProfile) => void;
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
}

/**
 * A single option in the Brand Profile dropdown: a resolved profile carries its
 * record for the swatch and edit affordance; an unresolved id is name-only.
 */
interface BrandProfileOption {
  id: string;
  name: string;
  profile?: BrandProfile;
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
/**
 * One Brand Profile option row: the selectable {@link SelectItem} (name plus,
 * for resolved profiles, a color swatch), a static description indicator, and
 * an edit affordance.
 *
 * The sibling edit button intercepts pointer-down before Radix Select can
 * consume it as an option selection, then invokes the editor from `onClick`;
 * keyboard activation remains native. It closes the menu before opening the
 * dialog through the parent handler. A noninteractive Info icon exposes the
 * optional description in a tooltip without changing selection behavior.
 * @param props.option - Option descriptor; `profile` present only for resolved profiles.
 * @param props.onEditProfile - Invoked with the resolved profile on edit activation;
 * omit to render a plain non-editable row.
 * @returns The option row with profile context and editing affordances.
 */
function ProfileOptionRow({
  option,
  onEditProfile,
}: {
  option: BrandProfileOption;
  onEditProfile?: (profile: BrandProfile) => void;
}) {
  const { t } = useI18n();
  const itemRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const pointerActivationRef = useRef(false);
  const profile = option.profile;
  const canEdit = profile !== undefined && onEditProfile !== undefined;

  return (
    <div className="relative">
      <SelectItem
        ref={itemRef}
        value={option.id}
        hideIndicator={canEdit}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.shiftKey && editRef.current) {
            e.preventDefault();
            e.stopPropagation();
            editRef.current.focus();
          }
        }}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-left">{option.name}</span>
          {profile ? <span className="ml-auto w-16 shrink-0" aria-hidden="true" /> : null}
        </span>
      </SelectItem>
      {profile ? (
        <span className="absolute right-2 top-1/2 z-30 flex -translate-y-1/2 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={t("Profile description")}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                className="flex size-6 cursor-help items-center justify-center"
              >
                <Info className="size-3.5" color={profile.color} aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 leading-relaxed">
              {profile.description ?? t("No profile description")}
            </TooltipContent>
          </Tooltip>
          {canEdit ? (
            <Button
              ref={editRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Edit profile")}
              title={t("Edit profile")}
              onPointerDown={(event) => {
                pointerActivationRef.current = true;
                event.preventDefault();
                event.stopPropagation();
                onEditProfile(profile);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (pointerActivationRef.current) {
                  pointerActivationRef.current = false;
                  return;
                }
                onEditProfile(profile);
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab" && event.shiftKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  itemRef.current?.focus();
                }
              }}
              onPointerEnter={(event) => {
                if (document.activeElement !== event.currentTarget) {
                  itemRef.current?.focus({ preventScroll: true });
                }
              }}
              onPointerLeave={(event) => {
                if (itemRef.current === document.activeElement) {
                  event.currentTarget.closest<HTMLElement>('[role="listbox"]')?.focus();
                }
              }}
              className="size-7 rounded-full text-ink-3 transition-all duration-150 hover:scale-105 hover:bg-hover hover:text-ink active:scale-95 [&_svg]:size-3.5"
            >
              <Pencil />
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Canonical controlled Brand Profile Select for the Channels and Posts toolbars.
 *
 * Owns the entire dropdown: the `Select` root, the caller-supplied trigger, the
 * aggregate "All Brand Profiles" row, the separator, and one row per option.
 * Options are built here as the single construction path — resolved profiles in
 * input order followed by unique unresolved ids as name-only "Unknown profile"
 * rows — so both screens share identical ordering and layout semantics.
 *
 * Each profile row is a full-width flex container directly under the item text:
 * the name truncates flexibly on the left while the color swatch and edit
 * affordance stay pinned to the right edge via `ml-auto`. The edit affordance
 * appears only when `onEditProfile` is supplied (admins); editable rows opt out
 * of the selected checkmark (`hideIndicator`) so it cannot collide with the
 * pinned accessories, while non-editable rows keep the standard indicator. The
 * affordance is a sibling overlay button (see {@link ProfileOptionRow}), so
 * activating it never selects the row; the select controls its own open state
 * and closes the menu before invoking `onEditProfile`, so the dropdown never
 * remains mounted behind the profile editor. The trigger's accessible name is
 * the trigger element's own `label` (the selected-value text); `label` names
 * the listbox instead of masking that selection.
 * @param props - Selection state, profile data, edit handler, trigger, and label.
 * @returns A complete Select dropdown ready to drop into a toolbar.
 */
export function BrandProfileSelect({
  value,
  onValueChange,
  brandProfiles,
  unresolvedProfileIds,
  onEditProfile,
  trigger,
  label,
}: BrandProfileSelectProps) {
  const { t } = useI18n();

  /**
   * Internal open state for the dropdown. The select must close itself before
   * the edit affordance fires — Radix never closes on the overlay button's
   * click because it sits outside every option — so `open` is controlled here
   * rather than left to Radix's uncontrolled default.
   */
  const [open, setOpen] = useState(false);

  /**
   * Closes the dropdown, then hands the resolved profile to the caller's edit
   * callback. Ordering matters: the editor dialog opens inside the callback,
   * so the menu must already be closing to guarantee no listbox remains
   * mounted behind it. Passed to rows only when `onEditProfile` exists.
   */
  const handleEditProfile = (profile: BrandProfile) => {
    setOpen(false);
    onEditProfile?.(profile);
  };

  /**
   * Canonical option list: resolved profiles first, followed by any unique
   * unresolved ids, so profile context and edit affordances remain consistent.
   */
  const options = useMemo(() => {
    const list: BrandProfileOption[] = brandProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      profile,
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

  return (
    <TooltipProvider>
      <Select value={value} onValueChange={onValueChange} open={open} onOpenChange={setOpen}>
        <SelectTrigger asChild aria-label={trigger.props.label ?? label}>
          {trigger}
        </SelectTrigger>
        <SelectContent align="start" className="w-56" aria-label={label}>
          <SelectItem value="all">{t("All Brand Profiles")}</SelectItem>
          <SelectSeparator />
          {options.map((option) => (
            <ProfileOptionRow
              key={option.id}
              option={option}
              onEditProfile={onEditProfile ? handleEditProfile : undefined}
            />
          ))}
        </SelectContent>
      </Select>
    </TooltipProvider>
  );
}
