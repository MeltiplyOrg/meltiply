import React, { type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent, type Transition } from "motion/react";
import { RotateCcw, Search, X } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { useI18n } from "@/lib/i18n";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
import { cn } from "@meltiply/ui/utils";

export interface TopToolbarProps {
  children: ReactNode;
  className?: string;
}

export interface TopToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

export interface TopToolbarLabelProps {
  label: string;
  className?: string;
}
export interface TopToolbarResetProps {
  hasActiveFilters: boolean;
  onReset: () => void;
  title?: string;
  className?: string;
}

/**
 * Route-shared filter participants that morph between workspace toolbars. Each id
 * maps to the `workspace-filter-${id}` layout identity inside the route-level
 * `LayoutGroup`; `sort` is Posts-only but shares the same identity scheme.
 */
type TopToolbarFilterSlotId = "platform" | "profile" | "status" | "date" | "reset" | "sort";

export interface TopToolbarFilterGroupProps {
  children: ReactNode;
  className?: string;
}

export interface TopToolbarFilterSlotProps {
  id: TopToolbarFilterSlotId;
  children?: ReactNode;
  /**
   * Render the slot's collapsed stand-in when no child is provided. Reserved for
   * the `date` slot: routes without a date filter keep a two-pixel,
   * negative-margin target so the Posts date trigger still has a morph partner.
   */
  collapseWhenEmpty?: boolean;
}

export { TopToolbarButton } from "@/components/primitives/top-toolbar-button";

/**
 * Top horizontal toolbar card anchoring operational view filters, search, and view switchers.
 *
 * Provides the shared navigation card geometry with identical dimensions and layout across
 * workspace views, keeping filters and search controls anchored without route-transition scaling.
 * Marks the scroll viewport so route snapshots preserve its clipping on narrow screens.
 * The persistent `layoutId`/`layout` morph is disabled under the shared low-motion
 * preference so the card lands at its resting geometry with no projection or travel.
 *
 * @param props.children - Toolbar content (search bar, filter clusters, mode switchers).
 * @param props.className - Optional outer styling overrides.
 * @returns Solid interactive toolbar card adhering to the Beautiful UI design tokens.
 */
export function TopToolbar({ children, className }: TopToolbarProps) {
  const { lowMotion } = useMotionPreference();
  const transition: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  return (
    <motion.div
      layout={lowMotion ? false : "position"}
      layoutId={lowMotion ? undefined : "workspace-surface-toolbar"}
      transition={{ layout: transition }}
      data-workspace-toolbar=""
      className={cn(
        "flex h-[3.375rem] min-h-[3.375rem] shrink-0 items-center justify-between gap-3 overflow-x-auto rounded-card border border-line bg-surface p-2.5 hide-scrollbar select-none",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

/**
 * Shared search input with persistent layout continuity and animated placeholder morphing.
 * Anchors the search box across view transitions via `layoutId="workspace-toolbar-search"`,
 * crossfading dynamic placeholder text with a subtle vertical drift and optical blur rather
 * than abruptly blinking between routes. Dissolves away when populated and shows a clear
 * trigger whose accessible name follows the active i18n translation. The same
 * `AnimatePresence`/`motion.*` tree renders in both motion modes — under the
 * shared low-motion preference the layout morph is disabled and the placeholder
 * swap and clear trigger settle at their final state in zero duration — so
 * toggling the preference never remounts the input's overlays.
 *
 * @param props.value - Controlled query string.
 * @param props.onChange - Value change callback receiving the updated query string.
 * @param props.placeholder - Localized placeholder label crossfaded across route changes.
 * @param props.id - Optional HTML input element id for accessible form association.
 * @param props.ariaLabel - Accessible name attribute passed to the underlying input.
 * @param props.className - Optional wrapper element styling overrides.
 * @returns Fluid search bar element adhering to the workspace design system.
 */
export function TopToolbarSearch({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  className,
}: TopToolbarSearchProps) {
  const { t } = useI18n();
  const { lowMotion } = useMotionPreference();
  const transition: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  const clearButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => onChange("")}
      className="size-6 text-ink-3 hover:text-ink active:scale-90 transition-colors p-0 rounded-control"
      aria-label={t("Clear search")}
    >
      <X className="size-3" />
    </Button>
  );

  return (
    <motion.div
      layout={lowMotion ? false : "position"}
      layoutId={lowMotion ? undefined : "workspace-toolbar-search"}
      transition={transition}
      className={cn("relative w-52 shrink-0 sm:w-64", className)}
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3 z-10" />
      <Input
        type="text"
        id={id}
        aria-label={ariaLabel ?? placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-control border border-line bg-page pl-8 pr-7 text-xs text-ink placeholder:text-transparent focus:border-line-strong focus:outline-none select-text transition-colors"
      />
      {/* Animated placeholder overlay */}
      {!value && (
        <div className="pointer-events-none absolute inset-y-0 left-8 right-7 flex items-center overflow-hidden select-none">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={placeholder}
              initial={lowMotion ? false : { opacity: 0, y: 3, filter: "blur(2px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={lowMotion ? { opacity: 0 } : { opacity: 0, y: -3, filter: "blur(2px)" }}
              transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="truncate text-xs text-ink-3"
            >
              {placeholder}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
      <AnimatePresence>
        {value && (
          <motion.div
            initial={lowMotion ? false : { opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={lowMotion ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            transition={{ duration: lowMotion ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          >
            {clearButton}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * Crossfades changing label text inside a toolbar button without unmounting its trigger.
 *
 * The keyed text runs inside the persistent button so focus and menu identity remain
 * stable while the surrounding motion wrapper interpolates the control's new width.
 * Exiting spans are removed from the accessibility tree via `aria-hidden` so a
 * trigger whose accessible name comes from its content (e.g. the platform
 * filter button) never transiently announces the concatenation of the outgoing
 * and incoming labels mid-crossfade. The same `AnimatePresence`/`motion.span`
 * tree renders in both motion modes — under the shared low-motion preference
 * `initial` is suppressed, the exit is opacity-only, and the duration is zero —
 * so toggling the preference never remounts the label or shifts its spacing.
 *
 * @param props.label - Localized visible label for the current filter or sort state.
 * @param props.className - Optional text styling overrides.
 * @returns The current label, crossfaded only when effective low motion is off.
 */
export function TopToolbarLabel({ label, className }: TopToolbarLabelProps) {
  const { lowMotion } = useMotionPreference();
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <TopToolbarLabelText key={label} label={label} className={className} lowMotion={lowMotion} />
    </AnimatePresence>
  );
}

/**
 * One keyed label span inside {@link TopToolbarLabel}'s `AnimatePresence`.
 *
 * Must be a direct child of `AnimatePresence` so `useIsPresent` flips to false
 * the moment the exit animation starts; the resulting `aria-hidden` keeps the
 * outgoing text out of the trigger's accessible name while it fades. The
 * `popLayout` mode also injects a measurement ref into its direct children, so
 * this wrapper forwards that ref to the `motion.span`: without it the exiting
 * label cannot be popped out of flow and the crossfade snaps layout instead of
 * overlapping. `lowMotion` gates the variants in place — no travel, no blur,
 * zero duration — so the span's geometry is identical in both modes.
 *
 * @param props.label - Text rendered inside the animated span.
 * @param props.className - Optional text styling overrides.
 * @param props.lowMotion - Effective low-motion preference; disables travel, blur, and duration.
 * @param ref - Measurement ref injected by `AnimatePresence` `popLayout`.
 * @returns Motion span that hides from assistive technology while exiting.
 */
const TopToolbarLabelText = React.forwardRef<
  HTMLSpanElement,
  TopToolbarLabelProps & { lowMotion: boolean }
>(({ label, className, lowMotion }, ref) => {
  const isPresent = useIsPresent();
  return (
    <motion.span
      ref={ref}
      initial={lowMotion ? false : { opacity: 0, y: 3, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={lowMotion ? { opacity: 0 } : { opacity: 0, y: -3, filter: "blur(2px)" }}
      transition={{ duration: lowMotion ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden={!isPresent}
      className={cn("inline-block whitespace-nowrap", className)}
    >
      {label}
    </motion.span>
  );
});
TopToolbarLabelText.displayName = "TopToolbarLabelText";

/**
 * Wraps the pill row in a dedicated `LayoutGroup` (`inherit={false}`) so the
 * slots' local geometry changes — especially Reset entering or exiting — are
 * measured as one toolbar row. Cross-route projection belongs to the
 * navigation shell's persistent snapshot host; the row itself remains a plain
 * flex container and callers provide only ordered slots.
 *
 * @param props.children - `TopToolbarFilterSlot` participants in display order.
 * @param props.className - Optional row styling overrides.
 * @returns Flex row grouping the toolbar's morphing filter slots.
 */
export function TopToolbarFilterGroup({ children, className }: TopToolbarFilterGroupProps) {
  return (
    <LayoutGroup inherit={false}>
      <div className={cn("flex items-center gap-1.5 shrink-0", className)}>{children}</div>
    </LayoutGroup>
  );
}

/**
 * Per-participant layout mode and resting geometry for {@link TopToolbarFilterSlot}.
 * `position` slots only translate as siblings resize; `date` and `reset` also
 * interpolate size because their footprint changes between routes and filter states.
 */
const FILTER_SLOT_GEOMETRY: Record<
  TopToolbarFilterSlotId,
  { layout: "position" | true; className: string }
> = {
  platform: { layout: "position", className: "shrink-0" },
  profile: { layout: "position", className: "shrink-0" },
  status: { layout: "position", className: "shrink-0" },
  sort: { layout: "position", className: "shrink-0" },
  date: {
    layout: true,
    className: "w-40 shrink-0 overflow-hidden origin-left flex items-center",
  },
  reset: {
    layout: true,
    className: "shrink-0 flex items-center overflow-hidden origin-left",
  },
};

/**
 * Collapsed `date` stand-in geometry: `w-2 -mr-3.5` cancels its own flex footprint
 * plus the following `gap-1.5`, so the reset slot sits one gap after the status
 * filter exactly as on routes with a real date control.
 */
const FILTER_SLOT_COLLAPSED_CLASS = "w-2 h-8 -mr-3.5 shrink-0 pointer-events-none";

/**
 * Marks the slot for the shell's persistent snapshot host and applies standard
 * local geometry motion (0.22s). Feature toolbars therefore compose ordinary
 * controls without authoring route-level Motion wrappers. With
 * `collapseWhenEmpty` and no child, the slot renders the date participant's
 * collapsed stand-in — a two-pixel, aria-hidden target that cancels its own
 * flex footprint so the reset slot keeps its usual gap while the Posts date
 * trigger still has a morph partner on this route. Under the shared low-motion
 * preference `layout` is disabled so sibling resizes land instantly instead of
 * interpolating; the snapshot markers stay so the imperative handoff (itself
 * skipped in low motion) keeps working when motion returns.
 *
 * @param props.id - Route-shared participant id (`platform`, `profile`, `status`,
 * `date`, `reset`, or `sort`).
 * @param props.children - Ordinary filter control rendered inside the slot.
 * @param props.collapseWhenEmpty - Render the collapsed date stand-in when no
 * child is provided; only meaningful for the `date` slot.
 * @returns Local motion wrapper marked for the shell's shared snapshot host.
 */
export function TopToolbarFilterSlot({
  id,
  children,
  collapseWhenEmpty,
}: TopToolbarFilterSlotProps) {
  const { lowMotion } = useMotionPreference();
  const transition: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };
  const hasChild = !(children === undefined || children === null || children === false);
  const collapsed = collapseWhenEmpty === true && !hasChild;
  const geometry = FILTER_SLOT_GEOMETRY[id];

  return (
    <motion.div
      layout={lowMotion ? false : geometry.layout}
      transition={{ layout: transition }}
      data-workspace-transition-slot={id}
      data-workspace-transition-collapsed={collapsed ? "true" : undefined}
      aria-hidden={collapsed ? true : undefined}
      className={collapsed ? FILTER_SLOT_COLLAPSED_CLASS : geometry.className}
    >
      {children}
    </motion.div>
  );
}

/**
 * Shared filter reset button providing seamless morph animation on appearance and dismissal.
 *
 * Renders only the button's internal enter/exit animation. The surrounding
 * `TopToolbarFilterSlot id="reset"` marks its geometry for the navigation
 * shell's snapshot host and handles the ordinary flex-row footprint, so
 * Channels/Posts navigation projects the reset control in place without
 * retaining an entire outgoing route. The button enters and exits via
 * `AnimatePresence` (expanding width, scaling up, and sliding from the
 * preceding filter pill), with
 * `initial={false}` so a route remount renders the button directly at its resting
 * state. The same `AnimatePresence`/`motion.div` tree renders in both motion
 * modes — under the shared low-motion preference the width morph, slide, and
 * blur collapse to an instant opacity swap — so toggling the preference never
 * remounts the button or shifts the pill row's spacing.
 *
 * @param props.hasActiveFilters - Boolean flag indicating if any filter is non-default.
 * @param props.onReset - Callback function invoked when the operator clicks reset.
 * @param props.title - Accessible tooltip/title string.
 * @param props.className - Optional extra button styling overrides.
 * @returns A reset trigger when filters are active, rendered immediately in low motion; otherwise `null`.
 */
export function TopToolbarReset({
  hasActiveFilters,
  onReset,
  title,
  className,
}: TopToolbarResetProps) {
  const { t } = useI18n();
  const { lowMotion } = useMotionPreference();
  const transition: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  const resetButton = (
    <Button
      size="sm"
      variant="outline"
      type="button"
      onClick={onReset}
      className={cn(
        "h-8 w-[4.875rem] rounded-chip border-dashed border-line-strong bg-hover/80 px-2 text-[11px] font-medium text-ink-2 hover:text-ink hover:bg-hover active:scale-95 transition-colors shadow-hairline shrink-0 gap-1",
        className,
      )}
      title={title ?? t("Reset all active filters")}
    >
      <RotateCcw className="size-3 text-ink-3 shrink-0" />
      <span className="whitespace-nowrap">{t("Reset")}</span>
    </Button>
  );

  return (
    <AnimatePresence initial={false}>
      {hasActiveFilters && (
        <motion.div
          initial={
            lowMotion ? false : { opacity: 0, scale: 0.75, x: -16, width: 0, filter: "blur(2px)" }
          }
          animate={{ opacity: 1, scale: 1, x: 0, width: "auto", filter: "blur(0px)" }}
          exit={
            lowMotion
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.75, x: -16, width: 0, filter: "blur(2px)" }
          }
          transition={
            lowMotion
              ? { duration: 0 }
              : {
                  opacity: { duration: 0.18 },
                  width: transition,
                  scale: transition,
                  x: transition,
                  filter: { duration: 0.18 },
                }
          }
          className="overflow-hidden shrink-0 flex items-center origin-left"
        >
          {resetButton}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
