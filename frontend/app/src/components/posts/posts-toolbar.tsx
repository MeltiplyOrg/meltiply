import React from "react";
import { motion } from "motion/react";
import {
  CalendarDays,
  ArrowUpDown,
  List,
  Calendar as CalendarIcon,
  LayoutGrid,
} from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  TopToolbar,
  TopToolbarSearch,
  TopToolbarReset,
  TopToolbarButton,
  TopToolbarFilterGroup,
  TopToolbarFilterSlot,
} from "@/components/layout/top-toolbar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@meltiply/ui/dropdown-menu";
import { FilterSelect } from "@meltiply/ui/select";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
import { type PostViewMode, type PostStatusFilter, type PostSortKey } from "./types";
import type { BrandProfile } from "./types";
import {
  BrandProfileSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import {
  PlatformFilterSelect,
  platformFilterLabel,
} from "@/components/workspace/platform-filter-select";

const VIEW_MODES = [
  { id: "list", label: "List", icon: List },
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "grid", label: "Grid", icon: LayoutGrid },
] as const;

export interface PostsToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  viewMode: PostViewMode;
  onViewModeChange: (m: PostViewMode) => void;
  columns: number;
  onColumnsChange: (updater: (c: number) => number) => void;
  statusFilter: PostStatusFilter;
  onStatusChange: (s: PostStatusFilter) => void;
  platformFilter: string[];
  onPlatformChange: (platforms: string[]) => void;
  profileFilter: string;
  onProfileChange: (pr: string) => void;
  dateFilter: string;
  onDateChange: (d: string) => void;
  sortKey: PostSortKey;
  onSortChange: (k: PostSortKey) => void;
  brandProfiles: BrandProfile[];
  /**
   * Brand Profile ids referenced by rendered Post rows, derived by the parent
   * view. Forwarded unchanged to {@link BrandProfileSelect}, which keeps only
   * ids missing from `brandProfiles` as selectable "Unknown profile" rows so a
   * persisted selection or post reference to a deleted profile stays visible.
   */
  unresolvedProfileIds: readonly string[];
  onEditProfile?: (profile: BrandProfile) => void;
}
/**
 * Presenter component for the top filter toolbar, view switcher, and multi-dimensional sort control.
 *
 * Crossfades every changing filter and sort label while each persistent trigger interpolates its
 * geometry, preventing text or sibling controls from jumping. The filter pills compose inside
 * `TopToolbarFilterGroup`/`TopToolbarFilterSlot`, which mark snapshot participants.
 * The date slot morphs against Channels' collapsed stand-in; Sort and the view
 * switcher register independent entry/exit snapshots on route changes. Preserves the
 * view mode's spring-animated layout pill and grid density stepper; inactive view modes use the
 * `ghost` button variant so they retain the muted ink role instead of inheriting the primary
 * action fill. The Brand Profile filter is the shared `BrandProfileSelect`; `unresolvedProfileIds`
 * (derived by the parent from rendered Post rows) keeps profile ids referenced by posts but
 * missing from `brandProfiles` selectable as "Unknown profile" rows. Status uses the
 * location-independent `FilterSelect`; date keeps its established dropdown composition inside the
 * shared date slot. The density stepper mounts at the selected mode's width
 * (zero for List/Calendar), so route snapshots never capture a transient grid control.
 * Under the shared low-motion preference the view-mode pill, stepper, and column
 * counter all land at their resting state instantly — no spring, no width morph.
 * The left group's intrinsic width is preserved: when controls exceed the
 * viewport, the shared toolbar scrolls instead of letting Sort cover filters.
 *
 * @param props - Toolbar state handlers for search, filters, view mode, density, and sorting. An
 * empty `platformFilter` shows posts from every platform.
 * @returns Fluid interactive toolbar card with tactile button feedback and morphing layout.
 */
export const PostsToolbar = React.memo(function PostsToolbar({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  columns,
  onColumnsChange,
  statusFilter,
  onStatusChange,
  platformFilter,
  onPlatformChange,
  profileFilter,
  onProfileChange,
  dateFilter,
  onDateChange,
  sortKey,
  onSortChange,
  brandProfiles,
  unresolvedProfileIds,
  onEditProfile,
}: PostsToolbarProps) {
  const { t } = useI18n();
  const { lowMotion } = useMotionPreference();

  const hasActiveFilters =
    statusFilter !== "all" ||
    platformFilter.length > 0 ||
    profileFilter !== "all" ||
    dateFilter !== "all";
  const platformFilterText = platformFilterLabel(platformFilter, t);
  const statusFilterLabel =
    statusFilter === "all"
      ? t("All statuses")
      : statusFilter === "scheduled"
        ? t("Scheduled")
        : statusFilter === "published"
          ? t("Published")
          : statusFilter === "draft"
            ? t("Drafts")
            : t("Failed");
  const profileFilterLabel = brandProfileFilterLabel(profileFilter, brandProfiles, t);
  const dateFilterLabel =
    dateFilter === "today"
      ? t("Today")
      : dateFilter === "next7"
        ? t("Next 7 days")
        : dateFilter === "past30"
          ? t("Past 30 days")
          : t("All dates");
  const sortKeyLabel =
    sortKey === "date-desc"
      ? t("Time: Newest first")
      : sortKey === "date-asc"
        ? t("Time: Oldest first")
        : t("Sorted");

  const handleResetFilters = React.useCallback(() => {
    onStatusChange("all");
    onPlatformChange([]);
    onProfileChange("all");
    onDateChange("all");
  }, [onStatusChange, onPlatformChange, onProfileChange, onDateChange]);
  return (
    <TopToolbar>
      {/* Left: Search input + Filter pills all in one line */}
      <div className="flex items-center gap-2 min-w-max shrink-0 flex-1">
        <TopToolbarSearch
          placeholder={t("Search posts...")}
          value={searchQuery}
          onChange={onSearchChange}
        />
        <TopToolbarFilterGroup>
          <TopToolbarFilterSlot id="platform">
            <PlatformFilterSelect
              value={platformFilter}
              onValueChange={onPlatformChange}
              trigger={
                <TopToolbarButton
                  label={platformFilterText}
                  isActive={platformFilter.length > 0}
                  width="w-36"
                  className="capitalize"
                />
              }
            />
          </TopToolbarFilterSlot>

          <TopToolbarFilterSlot id="profile">
            <BrandProfileSelect
              value={profileFilter}
              onValueChange={onProfileChange}
              brandProfiles={brandProfiles}
              unresolvedProfileIds={unresolvedProfileIds}
              onEditProfile={onEditProfile}
              label={t("Brand Profile")}
              trigger={
                <TopToolbarButton
                  label={profileFilterLabel}
                  isActive={profileFilter !== "all"}
                  width="w-44"
                />
              }
            />
          </TopToolbarFilterSlot>

          <TopToolbarFilterSlot id="status">
            <FilterSelect
              value={statusFilter}
              onValueChange={onStatusChange}
              aggregateOption={{ value: "all", label: t("All statuses") }}
              options={[
                { value: "scheduled", label: t("Scheduled") },
                { value: "published", label: t("Published") },
                { value: "draft", label: t("Drafts") },
                { value: "failed", label: t("Failed") },
              ]}
              ariaLabel={t("Post status")}
              contentClassName="w-40"
              trigger={
                <TopToolbarButton
                  label={statusFilterLabel}
                  isActive={statusFilter !== "all"}
                  width="w-36"
                  className="capitalize"
                />
              }
            />
          </TopToolbarFilterSlot>

          <TopToolbarFilterSlot id="date">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TopToolbarButton
                  label={dateFilterLabel}
                  isActive={dateFilter !== "all"}
                  width="w-40"
                  icon={<CalendarDays className="size-3.5 text-ink-3 shrink-0" />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuItem onClick={() => onDateChange("all")}>
                  {t("All dates")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onDateChange("today")}>
                  {t("Today")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDateChange("next7")}>
                  {t("Next 7 days")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDateChange("past30")}>
                  {t("Past 30 days")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TopToolbarFilterSlot>
          <TopToolbarFilterSlot id="reset">
            <TopToolbarReset hasActiveFilters={hasActiveFilters} onReset={handleResetFilters} />
          </TopToolbarFilterSlot>
        </TopToolbarFilterGroup>
      </div>
      {/* Right: Sort dropdown + View Mode Switcher + Density Stepper */}
      <div className="flex items-center gap-2 shrink-0">
        <TopToolbarFilterSlot id="sort">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <TopToolbarButton
                label={sortKeyLabel}
                width="w-44"
                icon={<ArrowUpDown className="size-3 text-ink-3 shrink-0" />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onSortChange("date-desc")}>
                {t("Time: Newest first")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSortChange("date-asc")}>
                {t("Time: Oldest first")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TopToolbarFilterSlot>
        <div
          data-workspace-transition-slot="view-mode"
          className="relative flex items-center rounded-control border border-line bg-page p-0.5 shadow-hairline shrink-0"
        >
          {VIEW_MODES.map((mode) => {
            const Icon = mode.icon;
            const isActive = viewMode === mode.id;
            return (
              <Button
                key={mode.id}
                type="button"
                variant="ghost"
                onClick={() => onViewModeChange(mode.id)}
                className={cn(
                  "relative flex h-7 items-center gap-1.5 px-2.5 rounded-chip text-xs font-semibold select-none transition-colors duration-150 outline-none active:scale-95",
                  isActive ? "text-ink" : "text-ink-3 hover:text-ink-2",
                )}
                title={
                  mode.id === "list"
                    ? t("List View")
                    : mode.id === "calendar"
                      ? t("Calendar View")
                      : t("Grid View")
                }
              >
                {isActive && (
                  <motion.span
                    layoutId={lowMotion ? undefined : "posts-view-mode-pill"}
                    className="absolute inset-0 rounded-chip bg-surface shadow-sm border border-line/60"
                    transition={
                      lowMotion
                        ? { duration: 0 }
                        : {
                            type: "spring",
                            stiffness: 450,
                            damping: 35,
                          }
                    }
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  <Icon className="size-3.5" />
                  <span>
                    {mode.id === "list"
                      ? t("List")
                      : mode.id === "calendar"
                        ? t("Calendar")
                        : t("Grid")}
                  </span>
                </span>
              </Button>
            );
          })}

          <motion.div
            initial={false}
            animate={{
              width: viewMode === "grid" ? 72 : 0,
              opacity: viewMode === "grid" ? 1 : 0,
            }}
            transition={{
              duration: lowMotion ? 0 : 0.24,
              ease: [0.16, 1, 0.3, 1],
            }}
            aria-hidden={viewMode !== "grid"}
            className="h-7 shrink-0 overflow-hidden flex items-center justify-center self-center"
          >
            <div className="flex h-7 w-[72px] shrink-0 items-center justify-center border-l border-line/70 pl-1 px-0.5 text-ink text-xs font-mono select-none whitespace-nowrap">
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onColumnsChange((c) => Math.max(2, c - 1));
                }}
                disabled={columns <= 2 || viewMode !== "grid"}
                className="flex h-7 items-center justify-center px-1 leading-none text-ink-3 hover:text-ink active:scale-90 transition-transform disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                title={t("Decrease grid columns")}
              >
                −
              </Button>
              <motion.span
                key={columns}
                initial={lowMotion ? false : { opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: lowMotion ? 0 : 0.15 }}
                className="flex h-7 min-w-[12px] items-center justify-center px-1 text-center font-semibold text-[11px] leading-none"
              >
                {columns}
              </motion.span>
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onColumnsChange((c) => Math.min(5, c + 1));
                }}
                disabled={columns >= 5 || viewMode !== "grid"}
                className="flex h-7 items-center justify-center px-1 leading-none text-ink-3 hover:text-ink active:scale-90 transition-transform disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                title={t("Increase grid columns")}
              >
                +
              </Button>
            </div>
          </motion.div>
        </div>
      </div>
    </TopToolbar>
  );
});
