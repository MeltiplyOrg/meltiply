import React from "react";
import { ArrowDownUp, Columns3, Minus, Plus, Rows3 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "@meltiply/ui/dropdown-menu";
import { FilterSelect } from "@meltiply/ui/select";
import {
  TopToolbar,
  TopToolbarSearch,
  TopToolbarFilters,
  TopToolbarFilterChips,
  TopToolbarFilterChip,
  TopToolbarButton,
  TopToolbarReset,
} from "@/components/layout/top-toolbar";
import {
  BrandProfileSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import {
  PlatformFilterSelect,
  platformFilterLabel,
} from "@/components/workspace/platform-filter-select";
import { playEffect } from "@meltiply/ui/effects";
import { useI18n } from "@/lib/i18n";
import type { PostGroupBy } from "./post-groups";
import type { PostViewMode, PostStatusFilter, PostSortKey, BrandProfile } from "./types";
import {
  POST_COLLECTION_MODES,
  POST_VIEW_OPTIONS,
  type PostCollectionMode,
} from "./post-view-options";

/**
 * Grid column bounds: the narrowest and widest card row the collection supports.
 */
const GRID_COLUMN_MIN = 2;
const GRID_COLUMN_MAX = 5;
/** The strip the column count steps through, so a change slides instead of swapping. */
const GRID_COLUMN_VALUES = Array.from(
  { length: GRID_COLUMN_MAX - GRID_COLUMN_MIN + 1 },
  (_, index) => GRID_COLUMN_MIN + index,
);
/** How long a revealed view control takes to grow in or out, in milliseconds. */
const VIEW_CONTROL_MORPH_MS = 220;

export interface PostsToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: PostCollectionMode;
  onViewModeChange: (mode: PostViewMode) => void;
  groupBy: PostGroupBy;
  onGroupByChange: (group: PostGroupBy) => void;
  columns: number;
  onColumnsChange: (updater: (columns: number) => number) => void;
  hiddenColumns: ReadonlySet<string>;
  onToggleColumn: (column: string) => void;
  statusFilter: PostStatusFilter;
  onStatusChange: (status: PostStatusFilter) => void;
  platformFilter: string[];
  onPlatformChange: (platforms: string[]) => void;
  profileFilter: string;
  onProfileChange: (profile: string) => void;
  dateFilter: string;
  onDateChange: (date: string) => void;
  sortKey: PostSortKey;
  onSortChange: (key: PostSortKey) => void;
  brandProfiles: BrandProfile[];
  unresolvedProfileIds: readonly string[];
}

/** Gr8r Tasks controls composed from the reusable toolbar, filter, selector, and segment implementations. */
export const PostsToolbar = React.memo(function PostsToolbar({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  groupBy,
  onGroupByChange,
  columns,
  onColumnsChange,
  hiddenColumns,
  onToggleColumn,
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
}: PostsToolbarProps) {
  const { t, tStatus } = useI18n();
  const columnOptions = [
    { id: "status", label: t("Status") },
    { id: "channels", label: t("Channels") },
    { id: "date", label: t("Publish date") },
    { id: "profile", label: t("Brand Profile") },
  ];
  const activeCount =
    Number(statusFilter !== "all") +
    Number(platformFilter.length > 0) +
    Number(profileFilter !== "all") +
    Number(dateFilter !== "all");
  const profileLabel = brandProfileFilterLabel(profileFilter, brandProfiles, t);
  const platformLabel = platformFilterLabel(platformFilter, t);
  const dateLabel =
    dateFilter === "today"
      ? t("Today")
      : dateFilter === "next7"
        ? t("Next 7 days")
        : dateFilter === "past30"
          ? t("Past 30 days")
          : t("All dates");
  const reset = () => {
    onStatusChange("all");
    onPlatformChange([]);
    onProfileChange("all");
    onDateChange("all");
  };
  return (
    <>
      <TopToolbar>
        <TopToolbarSearch
          key="search"
          value={searchQuery}
          onChange={onSearchChange}
          placeholder={t("Search posts...")}
        />
        <TopToolbarFilters
          key="filters"
          activeCount={activeCount}
          onClearAll={reset}
          fields={[
            {
              id: "platform",
              label: t("Platform"),
              active: platformFilter.length > 0,
              onClear: () => onPlatformChange([]),
              control: (
                <PlatformFilterSelect
                  value={platformFilter}
                  onValueChange={onPlatformChange}
                  trigger={<TopToolbarButton label={platformLabel} className="w-full" />}
                />
              ),
            },
            {
              id: "profile",
              label: t("Brand Profile"),
              active: profileFilter !== "all",
              onClear: () => onProfileChange("all"),
              control: (
                <BrandProfileSelect
                  value={profileFilter}
                  onValueChange={onProfileChange}
                  brandProfiles={brandProfiles}
                  unresolvedProfileIds={unresolvedProfileIds}
                  label={t("Brand Profile")}
                  trigger={<TopToolbarButton label={profileLabel} className="w-full" />}
                />
              ),
            },
            {
              id: "status",
              label: t("Post status"),
              active: statusFilter !== "all",
              onClear: () => onStatusChange("all"),
              control: (
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
                  trigger={
                    <TopToolbarButton
                      label={statusFilter === "all" ? t("All statuses") : tStatus(statusFilter)}
                      className="w-full"
                    />
                  }
                />
              ),
            },
            {
              id: "date",
              label: t("Publish date"),
              active: dateFilter !== "all",
              onClear: () => onDateChange("all"),
              control: (
                <FilterSelect
                  value={dateFilter}
                  onValueChange={onDateChange}
                  aggregateOption={{ value: "all", label: t("All dates") }}
                  options={[
                    { value: "today", label: t("Today") },
                    { value: "next7", label: t("Next 7 days") },
                    { value: "past30", label: t("Past 30 days") },
                  ]}
                  ariaLabel={t("Publish date")}
                  trigger={<TopToolbarButton label={dateLabel} className="w-full" />}
                />
              ),
            },
          ]}
        />
        <DropdownMenu key="sort">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <ArrowDownUp className="size-3.5" />
              {t("Sort:")} {sortKey === "date-desc" ? t("Newest") : t("Oldest")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onSortChange("date-desc")}>
              {t("Time: Newest first")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSortChange("date-asc")}>
              {t("Time: Oldest first")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {viewMode === "table" && (
          <DropdownMenu key="group">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Rows3 className="size-3.5" />
                {t("Group:")}{" "}
                {groupBy === "status"
                  ? t("Status")
                  : groupBy === "profile"
                    ? t("Brand Profile")
                    : t("None")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onGroupByChange("status")}>
                {t("Status")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onGroupByChange("profile")}>
                {t("Brand Profile")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onGroupByChange("none")}>
                {t("None")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {viewMode === "table" && (
          <DropdownMenu key="columns">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Columns3 className="size-3.5" />
                {t("Columns")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {columnOptions.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={!hiddenColumns.has(column.id)}
                  onCheckedChange={() => onToggleColumn(column.id)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <SegmentedControl
          key="view"
          options={POST_COLLECTION_MODES}
          value={viewMode}
          onChange={onViewModeChange}
          label={t("Post view")}
          className="w-full overflow-x-auto sm:ml-auto sm:w-auto"
          renderOption={(mode) => {
            const Icon = POST_VIEW_OPTIONS[mode].icon;
            return (
              <>
                <Icon className="size-3.5" />
                <span>
                  {mode === "table" ? t("Table") : mode === "grid" ? t("Grid") : t("Calendar")}
                </span>
              </>
            );
          }}
        />
        <MorphingControl key="grid-columns" open={viewMode === "grid"}>
          <div className="flex items-center text-(length:--font-size-micro) tabular-nums">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("Decrease grid columns")}
              disabled={columns <= GRID_COLUMN_MIN}
              onClick={() => onColumnsChange((count) => Math.max(GRID_COLUMN_MIN, count - 1))}
            >
              <Minus className="size-3" />
            </Button>
            <GridColumnCount value={columns} />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("Increase grid columns")}
              disabled={columns >= GRID_COLUMN_MAX}
              onClick={() => onColumnsChange((count) => Math.min(GRID_COLUMN_MAX, count + 1))}
            >
              <Plus className="size-3" />
            </Button>
          </div>
        </MorphingControl>
      </TopToolbar>
      {activeCount > 0 && (
        <TopToolbarFilterChips>
          {statusFilter !== "all" && (
            <TopToolbarFilterChip
              label={`${t("Status")}: ${tStatus(statusFilter)}`}
              onClear={() => onStatusChange("all")}
            />
          )}
          {platformFilter.length > 0 && (
            <TopToolbarFilterChip label={platformLabel} onClear={() => onPlatformChange([])} />
          )}
          {profileFilter !== "all" && (
            <TopToolbarFilterChip label={profileLabel} onClear={() => onProfileChange("all")} />
          )}
          {dateFilter !== "all" && (
            <TopToolbarFilterChip label={dateLabel} onClear={() => onDateChange("all")} />
          )}
          <TopToolbarReset hasActiveFilters onReset={reset} className="ml-auto" />
        </TopToolbarFilterChips>
      )}
    </>
  );
});

/**
 * A toolbar control that appears with the selected view. It stays mounted so its
 * box can grow from nothing and push the controls beside it over smoothly — and
 * shrink again on the way out — instead of the row snapping to a new layout.
 *
 * The growth is a WAAPI effect rather than a transition: switching to the Grid
 * mounts a whole view, and that render can block the main thread past a
 * transition's entire duration, so the morph would start and finish with no frame
 * in between. The effect is created in a layout effect, after that render has
 * finished and before the view's first paint, and rests on styles the browser
 * resolves alone: the box's width is its content's, so nothing stale is kept.
 *
 * @param props.open - Whether the selected view uses this control.
 * @param props.children - The control's content, unclipped inside the morphing box.
 */
function MorphingControl({ open, children }: { open: boolean; children: React.ReactNode }) {
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const content = box.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    if ((box.dataset.morph === "open") === open) return;

    // The change lands in the frame after the view has settled. Switching views
    // mounts a whole view, and its render, effects, and layout run as their own
    // tasks: an effect created inside that work spends its whole duration there and
    // the user sees the end state instead of the move.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (open) {
          // The box is rendered before it is measured — hidden content has no width —
          // and the effect starts from nothing in that same frame.
          box.dataset.morph = "open";
          const width = content.getBoundingClientRect().width;
          if (width > 0) {
            playEffect(box, [{ width: "0px" }, { width: `${width}px` }], 0, {
              duration: VIEW_CONTROL_MORPH_MS,
            });
          }
          return;
        }

        // Closing keeps the box rendered for the effect, then removes it in the same
        // frame the effect's fill is released, so the row never sees the swap.
        const width = content.getBoundingClientRect().width;
        const effect =
          width > 0
            ? playEffect(box, [{ width: `${width}px` }, { width: "0px" }], 0, {
                duration: VIEW_CONTROL_MORPH_MS,
                fill: "forwards",
              })
            : null;
        if (!effect) {
          delete box.dataset.morph;
          return;
        }
        const settle = () => {
          delete box.dataset.morph;
          effect.cancel();
        };
        effect.finished.then(settle, settle);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);

  return (
    <div ref={boxRef} data-control-morph>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

/**
 * Grid column count. Every supported count renders in one strip that rolls to the
 * selected cell, so stepping a column raises the next count into the window from
 * below as the previous one leaves upwards (`value-push` in `motion.css`) instead
 * of swapping a glyph in place. The strip is decorative — assistive technology
 * reads the value once, as text.
 *
 * @param props.value - Selected column count, one of `GRID_COLUMN_VALUES`.
 */
function GridColumnCount({ value }: { value: number }) {
  return (
    <span
      data-value-push-track
      style={{ "--value-push-index": value - GRID_COLUMN_MIN } as React.CSSProperties}
    >
      <span data-value-push-strip aria-hidden>
        {GRID_COLUMN_VALUES.map((count) => (
          <span key={count} data-value-push-cell>
            {count}
          </span>
        ))}
      </span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
