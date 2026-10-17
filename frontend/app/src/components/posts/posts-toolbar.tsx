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
import { useI18n } from "@/lib/i18n";
import type { PostGroupBy } from "./post-groups";
import type { PostViewMode, PostStatusFilter, PostSortKey, BrandProfile } from "./types";

import {
  POST_COLLECTION_MODES,
  POST_VIEW_OPTIONS,
  type PostCollectionMode,
} from "./post-view-options";

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
  onEditProfile?: (profile: BrandProfile) => void;
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
  onEditProfile,
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
          value={searchQuery}
          onChange={onSearchChange}
          placeholder={t("Search posts...")}
        />
        <TopToolbarFilters
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
                  onEditProfile={onEditProfile}
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
        <DropdownMenu>
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
          <DropdownMenu>
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
          <DropdownMenu>
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
        {viewMode === "grid" && (
          <div className="flex items-center text-(length:--font-size-micro) tabular-nums">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("Decrease grid columns")}
              disabled={columns <= 2}
              onClick={() => onColumnsChange((count) => Math.max(2, count - 1))}
            >
              <Minus className="size-3" />
            </Button>
            <span>{columns}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("Increase grid columns")}
              disabled={columns >= 5}
              onClick={() => onColumnsChange((count) => Math.min(5, count + 1))}
            >
              <Plus className="size-3" />
            </Button>
          </div>
        )}
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
