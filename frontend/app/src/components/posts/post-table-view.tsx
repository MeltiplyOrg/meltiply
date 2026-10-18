import React, { Fragment, useMemo, useRef, useState } from "react";
import { ArrowUpDown, ChevronDown, Paperclip, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Empty, EmptyDescription } from "@meltiply/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@meltiply/ui/table";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import { StatusBadge } from "./status-badge";
import { useI18n } from "@/lib/i18n";
import { abbreviateRecordId } from "@/lib/format";
import { cn } from "@meltiply/ui/utils";
import { normalizePostStatus, resolveRowCaption, resolveRowProviders } from "./posts-helpers";
import { groupPostRows, type PostGroupBy } from "./post-groups";
import { postAnalyticsColumns, type PostAnalyticsColumn } from "./post-view-options";
import {
  SKELETON_TABLE_KEYS,
  type BrandProfile,
  type PostRow,
  type PostSelectionProps,
  type PostSortKey,
} from "./types";

export interface PostTableViewProps extends PostSelectionProps {
  posts: PostRow[];
  isLoading: boolean;
  sortKey: PostSortKey;
  brandProfiles: BrandProfile[];
  groupBy: PostGroupBy;
  hiddenColumns: ReadonlySet<string>;
  onSortChange: (key: PostSortKey) => void;
  onViewDetails: (postId: string) => void;
  onCreatePost: () => void;
}

/**
 * One cell of a collapsible Post row.
 *
 * The row's height is the `--post-row-h` hook in `globals.css`, and the cell's
 * content sits in an absolutely positioned layer (`data-post-row-content`)
 * because a table cell never shrinks below its content: only content that has
 * left the cell's flow lets an animated zero height clip it, which is what makes
 * a whole group collapse. Padding therefore belongs to the layer, and `className`
 * carries it plus whatever layout that column's content needs.
 *
 * @param props.className - Layout and padding for the content layer.
 * @param props.onClick - Cell-local handler, e.g. stopping row navigation.
 * @param props.children - Real cell content.
 * @returns The cell with its animated content layer.
 */
function PostRowCell({
  className,
  onClick,
  children,
}: {
  className?: string;
  onClick?: React.MouseEventHandler<HTMLTableCellElement>;
  children: React.ReactNode;
}) {
  return (
    <TableCell data-post-cell="" onClick={onClick}>
      <div data-post-row-content="" className={className}>
        {children}
      </div>
    </TableCell>
  );
}

/**
 * Publish-date column formatters.
 *
 * The column renders the same two shapes in every row, and constructing an
 * `Intl.DateTimeFormat` is the expensive part of formatting, so both are built
 * once for the module instead of per row per render.
 */
const PUBLISH_DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const PUBLISH_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const METRIC_FORMAT = new Intl.NumberFormat("en-US");
type AnalyticsColumn = PostAnalyticsColumn;

/**
 * One resolved Post row of the Posts table.
 *
 * Memoized on its own props so a parent re-render that does not change this row
 * - a keystroke elsewhere in the toolbar, a selection change on another row, a
 * collapse in another group - skips the row's subtree entirely. Every prop is a
 * primitive, a stable row object, a memoized map value, or a `useCallback`
 * handler from `PostsView`, so the comparison is cheap and never stale.
 *
 * @param props.post - Row data: caption, channels, date, Brand Profile.
 * @param props.selected - Whether this row is in the shared selection.
 * @param props.collapsed - Whether this row's group is collapsed.
 * @param props.selectionDisabled - Disables the checkbox while a bulk action runs.
 * @param props.profileName - Resolved Brand Profile name.
 * @param props.showStatus - Whether the Status column is visible.
 * @param props.showChannels - Whether the Channels column is visible.
 * @param props.showDate - Whether the Publish date column is visible.
 * @param props.showProfile - Whether the Brand Profile column is visible.
 * @param props.analyticsColumns - Visible measured-counter columns in toolbar order.
 * @param props.onToggleSelection - Toggles this row's selection.
 * @param props.onViewDetails - Opens the Post drawer for this row.
 * @returns The row's table cells.
 */
const PostTableRow = React.memo(function PostTableRow({
  post,
  selected,
  collapsed,
  selectionDisabled,
  profileName,
  showStatus,
  showChannels,
  showDate,
  showProfile,
  analyticsColumns,
  onToggleSelection,
  onViewDetails,
}: {
  post: PostRow;
  selected: boolean;
  collapsed: boolean;
  selectionDisabled: boolean | undefined;
  profileName: string;
  showStatus: boolean;
  showChannels: boolean;
  showDate: boolean;
  showProfile: boolean;
  analyticsColumns: readonly AnalyticsColumn[];
  onToggleSelection: (postId: string) => void;
  onViewDetails: (postId: string) => void;
}) {
  const { t } = useI18n();
  const providers = resolveRowProviders(post);
  const publishDate = new Date(post.date);
  const attachments = post.post?.attachments.length ?? 0;
  const analytics =
    post.post?.status !== "draft" && post.channels.some((channel) => channel.status === "published")
      ? post.post?.analytics
      : null;

  return (
    <TableRow
      data-post-row=""
      data-collapsed={collapsed || undefined}
      data-selected={selected || undefined}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, input, a")) return;
        event.currentTarget.querySelector<HTMLButtonElement>("[data-post-details]")?.focus();
        onViewDetails(post.id);
      }}
    >
      <PostRowCell className="pl-4 pr-2 sm:pl-6" onClick={(event) => event.stopPropagation()}>
        <Input
          type="checkbox"
          aria-label={t("Select post")}
          checked={selected}
          disabled={selectionDisabled}
          onChange={() => onToggleSelection(post.id)}
        />
      </PostRowCell>
      <PostRowCell className="min-w-0 gap-2 px-2">
        <span
          title={post.id}
          className="shrink-0 font-mono text-(length:--font-size-micro) text-ink-3"
        >
          {abbreviateRecordId(post.id)}
        </span>
        <Button
          data-post-details
          variant="ghost"
          className="block h-auto min-w-0 truncate p-0 text-left text-(length:--font-size-ui) font-normal text-ink hover:bg-transparent hover:underline"
          title={t("View details")}
          onClick={(event) => {
            event.stopPropagation();
            onViewDetails(post.id);
          }}
        >
          {resolveRowCaption(post) || t("Untitled post")}
        </Button>
        {attachments > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-(length:--font-size-micro) text-ink-3">
            <Paperclip className="size-3" />
            {attachments}
          </span>
        )}
      </PostRowCell>
      {showStatus && (
        <PostRowCell className="px-2">
          <StatusBadge status={normalizePostStatus(post)} compact />
        </PostRowCell>
      )}
      {showChannels && (
        <PostRowCell className="gap-1.5 px-2">
          {providers.map((provider) => (
            <PlatformIcon key={provider} provider={provider} className="size-3.5" />
          ))}
          {providers.length === 0 && <span className="text-ink-3">—</span>}
        </PostRowCell>
      )}
      {showDate && (
        <PostRowCell className="px-2 whitespace-nowrap tabular-nums">
          <time dateTime={post.date}>{PUBLISH_DAY_FORMAT.format(publishDate)}</time>
          <span className="ml-1.5 text-(length:--font-size-micro) text-ink-3">
            {PUBLISH_TIME_FORMAT.format(publishDate)}
          </span>
        </PostRowCell>
      )}
      {showProfile && (
        <PostRowCell className="px-2">
          <span className="flex w-full min-w-0 items-center gap-1.5 truncate text-xs">
            <span className="size-1.75 shrink-0 rounded-chip bg-accent" />
            {profileName}
          </span>
        </PostRowCell>
      )}
      {analyticsColumns.map((column) => {
        const value = analytics?.[column.id];
        return (
          <PostRowCell key={column.id} className="justify-end px-3 font-mono tabular-nums">
            {value == null ? <span className="text-ink-3">-</span> : METRIC_FORMAT.format(value)}
          </PostRowCell>
        );
      })}
    </TableRow>
  );
});

/**
 * One placeholder row of the Posts table.
 *
 * Renders the same cell slots as a resolved row - checkbox, id and caption,
 * status, Channels, publish date, Brand Profile - through `PostRowCell`, so the
 * row height, padding, and column widths match the real row exactly and the
 * resolved table does not move when data lands. Hidden from assistive
 * technology; the page's header announces the loading state.
 *
 * @param props.showStatus - Whether the Status column is visible.
 * @param props.showChannels - Whether the Channels column is visible.
 * @param props.showDate - Whether the Publish date column is visible.
 * @param props.showProfile - Whether the Brand Profile column is visible.
 * @param props.analyticsColumns - Visible analytics slots matching resolved rows.
 * @returns A single 36px placeholder row.
 */
function PostRowSkeleton({
  showStatus,
  showChannels,
  showDate,
  showProfile,
  analyticsColumns,
}: {
  showStatus: boolean;
  showChannels: boolean;
  showDate: boolean;
  showProfile: boolean;
  analyticsColumns: readonly AnalyticsColumn[];
}) {
  return (
    <TableRow data-post-row="" aria-hidden="true">
      <PostRowCell className="pl-4 pr-2 sm:pl-6">
        <Skeleton className="size-4" />
      </PostRowCell>
      <PostRowCell className="min-w-0 gap-2 px-2">
        <Skeleton className="h-3 w-14 shrink-0" />
        <Skeleton className="h-3.5 min-w-0 max-w-72 flex-1" />
        <Skeleton className="h-3 w-8 shrink-0" />
      </PostRowCell>
      {showStatus && (
        <PostRowCell className="px-2">
          <Skeleton className="h-4.5 w-20 rounded-chip" />
        </PostRowCell>
      )}
      {showChannels && (
        <PostRowCell className="gap-1.5 px-2">
          <Skeleton className="size-3.5 rounded-chip" />
          <Skeleton className="size-3.5 rounded-chip" />
        </PostRowCell>
      )}
      {showDate && (
        <PostRowCell className="px-2">
          <Skeleton className="h-3.5 w-28" />
        </PostRowCell>
      )}
      {showProfile && (
        <PostRowCell className="px-2">
          <Skeleton className="h-3.5 w-24" />
        </PostRowCell>
      )}
      {analyticsColumns.map((column) => (
        <PostRowCell key={column.id} className="justify-end px-3">
          <Skeleton className="h-3.5 w-8" />
        </PostRowCell>
      ))}
    </TableRow>
  );
}

/**
 * Gr8r Tasks' grouped spreadsheet Table shares semantic primitives with the
 * channel directory. Selection includes collapsed filtered rows, not unloaded
 * records; grouping preserves Post identity. Rows open Details instead of a trailing action column.
 *
 * This view adds one behavior the directory does not have: a group's rows
 * collapse in place. They stay mounted, driven by the `data-collapsed` /
 * `--post-row-h` hook in `globals.css`, so expanding and collapsing are one
 * transition in both directions. Rows keep the shared table hover fill.
 */
export const PostTableView = React.memo(function PostTableView({
  posts,
  isLoading,
  sortKey,
  brandProfiles,
  groupBy,
  hiddenColumns,
  onSortChange,
  onViewDetails,
  onCreatePost,
  selectedIds,
  onToggleSelection,
  onSetSelection,
  selectionDisabled,
}: PostTableViewProps) {
  const { t, tStatus } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useSmoothScrollContainer(scrollRef);
  const groups = useMemo(
    () => groupPostRows(posts, groupBy, brandProfiles),
    [posts, groupBy, brandProfiles],
  );
  const profileNames = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile.name])),
    [brandProfiles],
  );
  const visibleIds = posts.map((post) => post.id);
  const selectedCount = visibleIds.reduce((count, id) => count + Number(selectedIds.has(id)), 0);
  const allSelected = visibleIds.length > 0 && selectedCount === visibleIds.length;
  const showStatus = !hiddenColumns.has("status");
  const showChannels = !hiddenColumns.has("channels");
  const showDate = !hiddenColumns.has("date");
  const showProfile = !hiddenColumns.has("profile");
  const analyticsColumns = useMemo(
    () => postAnalyticsColumns(t).filter((column) => !hiddenColumns.has(column.id)),
    [hiddenColumns, t],
  );
  const columnCount =
    2 +
    Number(showStatus) +
    Number(showChannels) +
    Number(showDate) +
    Number(showProfile) +
    analyticsColumns.length;
  return (
    <div
      ref={scrollRef}
      className={cn("min-h-0 flex-1 overflow-auto pb-24", selectedIds.size > 0 && "pb-32")}
    >
      <Table
        variant="spreadsheet"
        className="min-w-[calc(47.75rem+var(--post-metrics-width))] sm:min-w-[calc(55.25rem+var(--post-metrics-width))]"
        style={
          { "--post-metrics-width": `${analyticsColumns.length * 72}px` } as React.CSSProperties
        }
        aria-label={t("Posts table")}
      >
        <colgroup>
          <col className="w-12" />
          <col />
          {showStatus && <col className="w-33" />}
          {showChannels && <col className="w-27.5" />}
          {showDate && <col className="w-38.5" />}
          {showProfile && <col className="w-40" />}
          {analyticsColumns.map((column) => (
            <col key={column.id} className="w-18" />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Input
                type="checkbox"
                aria-label={t("Select all visible posts")}
                checked={allSelected}
                disabled={selectionDisabled || visibleIds.length === 0}
                onChange={() => onSetSelection(visibleIds, !allSelected)}
              />
            </TableHead>
            <TableHead>{t("Post")}</TableHead>
            {showStatus && <TableHead>{t("Status")}</TableHead>}
            {showChannels && <TableHead>{t("Channels")}</TableHead>}
            {showDate && (
              <TableHead>
                <Button
                  variant="ghost"
                  className="h-auto justify-start p-0 text-xs font-medium text-ink-3"
                  aria-label={t("Sort by date")}
                  onClick={() => onSortChange(sortKey === "date-desc" ? "date-asc" : "date-desc")}
                >
                  {t("Publish date")}
                  <ArrowUpDown className="size-3" />
                </Button>
              </TableHead>
            )}
            {showProfile && <TableHead>{t("Brand Profile")}</TableHead>}
            {analyticsColumns.map((column) => (
              <TableHead
                key={column.id}
                className="text-right"
                aria-label={column.name}
                title={column.name}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            SKELETON_TABLE_KEYS.map((key) => (
              <PostRowSkeleton
                key={key}
                showStatus={showStatus}
                showChannels={showChannels}
                showDate={showDate}
                showProfile={showProfile}
                analyticsColumns={analyticsColumns}
              />
            ))
          ) : posts.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount}>
                <Empty className="min-h-60 gap-3.5 border-0">
                  <EmptyDescription>
                    {t("No posts found matching the active filters.")}
                  </EmptyDescription>
                  <Button variant="outline" onClick={onCreatePost}>
                    <Plus className="size-3.5" />
                    {t("Create post")}
                  </Button>
                </Empty>
              </TableCell>
            </TableRow>
          ) : (
            groups.map((group) => {
              const isCollapsed = collapsed.has(group.id);
              const label = group.status
                ? tStatus(group.status)
                : group.id === "all"
                  ? t("All posts")
                  : group.label;
              return (
                <Fragment key={group.id}>
                  {groupBy !== "none" && (
                    <TableRow
                      data-post-group-row=""
                      data-collapsed={isCollapsed || undefined}
                      className="hover:bg-surface"
                    >
                      <TableCell
                        colSpan={columnCount}
                        className="h-11.5 border-line pt-2.5 group-data-[variant=spreadsheet]/table:h-11.5"
                      >
                        {/* The row is a label, not a target: it keeps the quiet
                            surface hover and never paints a pressed fill. The
                            chevron states the group's phase and turns. */}
                        <Button
                          variant="ghost"
                          className="h-9 justify-start gap-2 p-0 text-(length:--font-size-control) font-semibold text-ink hover:bg-transparent active:bg-transparent"
                          aria-expanded={!isCollapsed}
                          aria-label={t("Toggle {label} group", { label })}
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          <ChevronDown data-post-group-chevron="" className="size-3.5" />
                          {group.status ? <StatusBadge status={group.status} compact /> : label}
                          <span className="text-xs font-normal tabular-nums text-ink-3">
                            <RollingCount value={group.posts.length} />
                          </span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )}
                  {group.posts.map((post) => (
                    <PostTableRow
                      key={post.id}
                      post={post}
                      selected={selectedIds.has(post.id)}
                      collapsed={Boolean(isCollapsed)}
                      selectionDisabled={selectionDisabled}
                      profileName={profileNames.get(post.brandProfileId) ?? t("Unknown profile")}
                      showStatus={showStatus}
                      showChannels={showChannels}
                      showDate={showDate}
                      showProfile={showProfile}
                      analyticsColumns={analyticsColumns}
                      onToggleSelection={onToggleSelection}
                      onViewDetails={onViewDetails}
                    />
                  ))}
                </Fragment>
              );
            })
          )}
          {posts.length > 0 && (
            <TableRow>
              <TableCell colSpan={columnCount}>
                <Button
                  variant="ghost"
                  className="h-8.5 w-full justify-start gap-2 px-0 text-(length:--font-size-control) font-normal text-ink-3"
                  onClick={onCreatePost}
                >
                  <Plus className="size-3.5" />
                  {t("Create post")}
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
});
