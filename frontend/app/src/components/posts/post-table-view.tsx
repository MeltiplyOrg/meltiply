import React, { Fragment, useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, ChevronRight, Paperclip, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Empty, EmptyDescription } from "@meltiply/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@meltiply/ui/table";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { StatusBadge } from "./status-badge";
import { useI18n } from "@/lib/i18n";
import { abbreviateRecordId } from "@/lib/format";
import { cn } from "@meltiply/ui/utils";
import { normalizePostStatus, resolveRowCaption, resolveRowProviders } from "./posts-helpers";
import { groupPostRows, type PostGroupBy } from "./post-groups";
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
 * Gr8r Tasks' grouped spreadsheet Table shares semantic primitives with the
 * channel directory. Selection includes collapsed filtered rows, not unloaded
 * records; grouping preserves Post identity. Rows open Details instead of a trailing action column.
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
  const columnCount =
    2 + Number(showStatus) + Number(showChannels) + Number(showDate) + Number(showProfile);
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto pb-24", selectedIds.size > 0 && "pb-32")}>
      <Table variant="spreadsheet" className="min-w-191 sm:min-w-221" aria-label={t("Posts table")}>
        <colgroup>
          <col className="w-12" />
          <col />
          {showStatus && <col className="w-33" />}
          {showChannels && <col className="w-27.5" />}
          {showDate && <col className="w-38.5" />}
          {showProfile && <col className="w-40" />}
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            SKELETON_TABLE_KEYS.map((key) => (
              <TableRow key={key}>
                <TableCell colSpan={columnCount}>
                  <Skeleton className="my-2 h-5 w-full" />
                </TableCell>
              </TableRow>
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
                    <TableRow className="hover:bg-surface">
                      <TableCell
                        colSpan={columnCount}
                        className="h-11.5 border-line pt-2.5 group-data-[variant=spreadsheet]/table:h-11.5"
                      >
                        <Button
                          variant="ghost"
                          className="h-9 justify-start gap-2 p-0 text-(length:--font-size-control) font-semibold text-ink hover:bg-transparent"
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
                          {isCollapsed ? (
                            <ChevronRight className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                          {group.status ? <StatusBadge status={group.status} compact /> : label}
                          <span className="text-xs font-normal tabular-nums text-ink-3">
                            {group.posts.length}
                          </span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )}
                  {!isCollapsed &&
                    group.posts.map((post) => {
                      const providers = resolveRowProviders(post);
                      const publishDate = new Date(post.date);
                      return (
                        <TableRow
                          key={post.id}
                          data-selected={selectedIds.has(post.id) || undefined}
                          onClick={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest("button, input, a")
                            )
                              return;
                            event.currentTarget
                              .querySelector<HTMLButtonElement>("[data-post-details]")
                              ?.focus();
                            onViewDetails(post.id);
                          }}
                        >
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            <Input
                              type="checkbox"
                              aria-label={t("Select post")}
                              checked={selectedIds.has(post.id)}
                              disabled={selectionDisabled}
                              onChange={() => onToggleSelection(post.id)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 font-mono text-(length:--font-size-micro) text-ink-3">
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
                              {(post.post?.attachments.length ?? 0) > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-1 text-(length:--font-size-micro) text-ink-3">
                                  <Paperclip className="size-3" />
                                  {post.post?.attachments.length}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          {showStatus && (
                            <TableCell>
                              <StatusBadge status={normalizePostStatus(post)} compact />
                            </TableCell>
                          )}
                          {showChannels && (
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {providers.map((provider) => (
                                  <PlatformIcon
                                    key={provider}
                                    provider={provider}
                                    className="size-3.5"
                                  />
                                ))}
                                {providers.length === 0 && <span className="text-ink-3">—</span>}
                              </div>
                            </TableCell>
                          )}
                          {showDate && (
                            <TableCell className="whitespace-nowrap tabular-nums">
                              <time dateTime={post.date}>
                                {publishDate.toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </time>
                              <span className="ml-1.5 text-(length:--font-size-micro) text-ink-3">
                                {publishDate.toLocaleTimeString("en-US", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  hour12: true,
                                })}
                              </span>
                            </TableCell>
                          )}
                          {showProfile && (
                            <TableCell>
                              <span className="flex min-w-0 items-center gap-1.5 truncate text-xs">
                                <span className="size-1.75 shrink-0 rounded-chip bg-accent" />
                                {profileNames.get(post.brandProfileId) ?? t("Unknown profile")}
                              </span>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
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
