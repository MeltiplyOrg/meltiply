import React from "react";
import { ArrowUpDown, FileText, Edit3, Trash2, Info } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { StatusBadge } from "./status-badge";
import { useI18n } from "@/lib/i18n";
import { cn } from "@meltiply/ui/utils";
import {
  normalizePostStatus,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
} from "./posts-helpers";
import {
  SKELETON_TABLE_KEYS,
  type BrandProfile,
  type PostRow,
  type PostSelectionProps,
  type PostSortKey,
} from "./types";

export interface PostListTableViewProps extends PostSelectionProps {
  posts: PostRow[];
  isLoading: boolean;
  sortKey: PostSortKey;
  /** Active Brand Profiles used to resolve each Post row's owning profile name. */
  brandProfiles: BrandProfile[];
  /**
   * Whether scope-owned mutations are allowed; `false` in the aggregate
   * "All Brand Profiles" view. Deletion no longer consumes this flag — the
   * Post's own `brand_profile_id` authorizes it — so only edits stay gated.
   */
  canMutate: boolean;
  onSortChange: (key: PostSortKey) => void;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
  /**
   * Opens the right-side post detail dialog; invoked by the row's dedicated
   * Details button and by clicking anywhere else on the row.
   */
  onViewDetails: (postId: string) => void;
}

/**
 * Presenter component for List View: renders one row per durable Post with its
 * caption preview, ordered attachment thumbnail, targeted platforms, and
 * aggregated status derived from its Channel outcomes.
 *
 * Row identity is `Post.id`, so per-channel publication times and content
 * overrides never split one composition into several rows.
 *
 * The whole row opens details on click, but the dedicated Details button is the
 * genuine keyboard/actionable trigger: row clicks pre-focus it so the right-side
 * dialog restores focus to a real control, and edit/delete keep stopPropagation.
 *
 * The leading column carries the selection checkboxes: the header checkbox is
 * the honest select-all (it applies only to the currently rendered filtered
 * rows, never hidden pages) and flips indeterminate on partial selection.
 * Checkbox cells stopPropagation so a toggle never opens details. Single
 * deletes are not scope-gated — the row's own Brand Profile id authorizes them —
 * while edit stays behind `canMutate`.
 * Wrapped in `React.memo` to eliminate table re-renders when parent toolbar or modal states change.
 */
export const PostListTableView = React.memo(function PostListTableView({
  posts,
  isLoading,
  sortKey,
  brandProfiles,
  canMutate,
  onSortChange,
  onEdit,
  onDelete,
  onViewDetails,
  selectedIds,
  onToggleSelection,
  onSetSelection,
  selectionDisabled,
}: PostListTableViewProps) {
  const { t } = useI18n();
  const visibleIds = posts.map((row) => row.id);
  const selectedVisibleCount = visibleIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0);
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  return (
    <div
      className={cn(
        "rounded-card border border-line bg-surface overflow-auto flex-1 min-h-0 shadow-card",
        selectedIds.size > 0 && "pb-24",
      )}
    >
      <div className="overflow-x-auto min-w-full">
        <table className="w-full text-left text-xs text-ink">
          <thead className="sticky top-0 z-10 border-b border-line bg-page text-[11px] uppercase tracking-wider text-ink-2 font-semibold select-none shadow-hairline">
            <tr>
              <th className="w-10 py-3 pl-4 pr-1">
                <Input
                  type="checkbox"
                  aria-label={t("Select all visible posts")}
                  checked={allVisibleSelected}
                  disabled={selectionDisabled || visibleIds.length === 0}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
                    }
                  }}
                  onChange={() => onSetSelection(visibleIds, !allVisibleSelected)}
                  className="align-middle"
                />
              </th>
              <th className="py-3 pl-3 pr-3 min-w-[240px]">{t("Post & Preview")}</th>
              <th className="py-3 px-3 min-w-[120px]">{t("Profile")}</th>
              <th className="py-3 px-3 min-w-[90px]">{t("Platforms")}</th>
              <th className="py-3 px-3 min-w-[140px]">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onSortChange(sortKey === "date-desc" ? "date-asc" : "date-desc")}
                  aria-label={t("Sort by date")}
                  className="h-auto justify-start gap-1 rounded-sm p-0 text-[11px] font-semibold uppercase tracking-wider cursor-pointer hover:bg-transparent hover:text-ink"
                >
                  <span>{t("Date")}</span>
                  <ArrowUpDown className="size-3" />
                </Button>
              </th>
              <th className="py-3 px-3 min-w-[100px]">{t("Status")}</th>
              <th className="py-3 pr-4 pl-3 text-right">{t("Actions")}</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-line">
            {isLoading ? (
              SKELETON_TABLE_KEYS.map((key) => (
                <tr key={key}>
                  <td colSpan={7} className="py-4 px-4">
                    <Skeleton className="h-6 w-full" />
                  </td>
                </tr>
              ))
            ) : posts.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-ink-3">
                  {t("No posts found matching the active filters.")}
                </td>
              </tr>
            ) : (
              posts.map((row) => {
                const preview = resolveRowPreviewAttachment(row);
                const primaryImage =
                  preview?.asset.thumbnail_url ?? preview?.asset.download_url ?? null;
                const dateStr = new Date(row.date).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: true,
                });
                const rawStatus = normalizePostStatus(row);

                const providers = resolveRowProviders(row);

                const profileName =
                  brandProfiles.find((p) => p.id === row.brandProfileId)?.name ??
                  t("Default Profile");

                return (
                  <tr
                    key={row.id}
                    className="hover:bg-hover/50 transition-colors group cursor-pointer"
                    onClick={(event) => {
                      event.currentTarget
                        .querySelector<HTMLButtonElement>("[data-post-details]")
                        ?.focus();
                      onViewDetails(row.id);
                    }}
                  >
                    <td className="py-3 pl-4 pr-1" onClick={(e) => e.stopPropagation()}>
                      <Input
                        type="checkbox"
                        aria-label={t("Select post")}
                        checked={selectedIds.has(row.id)}
                        disabled={selectionDisabled}
                        onChange={() => onToggleSelection(row.id)}
                        className="align-middle"
                      />
                    </td>
                    <td className="py-3 pl-3 pr-3">
                      <div className="flex items-center gap-2.5">
                        <div className="size-10 rounded-control overflow-hidden bg-page border border-line shrink-0 flex items-center justify-center">
                          {primaryImage ? (
                            <img src={primaryImage} alt="" className="size-full object-cover" />
                          ) : (
                            <FileText className="size-4 text-ink-3" />
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-ink truncate max-w-[240px]">
                            {resolveRowCaption(row) || t("Untitled post")}
                          </span>
                          <span className="font-mono text-[10px] text-ink-3">
                            {row.id.slice(0, 8)}...
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-3 text-ink-2 font-medium whitespace-nowrap">
                      {profileName}
                    </td>

                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1">
                        {providers.map((p) => (
                          <PlatformIcon key={`${row.id}-${p}`} provider={p} className="size-3.5" />
                        ))}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-ink-2 whitespace-nowrap font-medium">
                      {dateStr}
                    </td>

                    <td className="py-3 px-3 whitespace-nowrap">
                      <StatusBadge status={rawStatus} />
                    </td>
                    <td className="py-3 pr-4 pl-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          data-post-details
                          className="size-7 rounded-control text-ink-3 hover:text-ink"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewDetails(row.id);
                          }}
                          title={t("View details")}
                        >
                          <Info className="size-3.5" />
                        </Button>
                        {canMutate && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-control text-ink-3 hover:text-ink"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(row.id);
                            }}
                            title={t("Edit post")}
                          >
                            <Edit3 className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-control text-ink-3 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(row.id);
                          }}
                          title={t("Delete post")}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});
