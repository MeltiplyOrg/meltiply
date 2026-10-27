import React from "react";
import { CalendarDays, Edit3, Trash2, Plus, Info } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Input } from "@meltiply/ui/input";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogDescription,
  CenterDialogFooter,
} from "@meltiply/ui/center-dialog";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { StatusBadge } from "./status-badge";
import { Trans, useI18n } from "@/lib/i18n";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";
import {
  normalizePostStatus,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
} from "./posts-helpers";
import type { PostRow, PostSelectionProps } from "./types";

export interface CalendarDateDetailDialogProps extends PostSelectionProps {
  selectedDate: Date | null;
  posts: PostRow[];
  /**
   * Whether scope-owned mutations are allowed; `false` in the aggregate
   * "All Brand Profiles" view. Deletion no longer consumes this flag — the
   * Post's own `brand_profile_id` authorizes it — so only edit and
   * schedule-for-this-date stay gated.
   */
  canMutate: boolean;
  onClose: () => void;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
  onScheduleNew: () => void;
  /**
   * Opens the right-side post detail dialog for a Post listed in this day.
   * This button stays mounted while the panel opens so focus returns to it.
   */
  onViewDetails: (postId: string) => void;
}

/**
 * Presenter component for Date Detail modal: expands a calendar cell to inspect
 * and manage the Posts that land on that day, one card per durable `Post.id`.
 * Creating a Post for the date uses the normal primary treatment; destructive
 * styling is reserved for deleting an existing Post.
 * The day list doubles as the Calendar mode's selection surface: a header
 * checkbox selects all rows shown for this day and each card carries its own
 * toggle, so multi-select stays reachable in every view mode.
 * Wrapped in `React.memo` to avoid re-rendering unless the selected date or post list changes.
 * `selectedDate === null` closes it; the last day and its posts stay rendered
 * through the exit animation instead of blanking to an empty list.
 */
export const CalendarDateDetailDialog = React.memo(function CalendarDateDetailDialog({
  selectedDate: liveDate,
  posts: livePosts,
  canMutate,
  onClose,
  onEdit,
  onDelete,
  onScheduleNew,
  onViewDetails,
  selectedIds,
  onToggleSelection,
  onSetSelection,
  selectionDisabled,
  canSelect,
}: CalendarDateDetailDialogProps) {
  const { t } = useI18n();
  // Closing clears the date and empties `posts`; keep both through the pop-out.
  const selectedDate = useLatchedValue(liveDate);
  const posts = useLatchedValue(liveDate ? livePosts : null) ?? livePosts;
  const selectableIds = (canSelect ? posts.filter(canSelect) : posts).map((row) => row.id);
  const allDaySelected =
    selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  return (
    <CenterDialog open={liveDate !== null} onOpenChange={(open) => !open && onClose()}>
      <CenterDialogContent closeLabel={t("Close")} className="sm:max-w-2xl">
        <CenterDialogHeader>
          <CenterDialogTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="size-5 text-accent" />
            {t("Posts for")}{" "}
            {selectedDate?.toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </CenterDialogTitle>
          <CenterDialogDescription>
            <Trans
              message="{count} post(s) scheduled or published on this date."
              values={{ count: <RollingCount value={posts.length} /> }}
            />
          </CenterDialogDescription>
        </CenterDialogHeader>

        <div className="flex flex-col gap-3 py-3">
          {selectableIds.length > 0 && (
            <div className="flex items-center gap-2">
              <Input
                type="checkbox"
                aria-label={t("Select all posts for this day")}
                checked={allDaySelected}
                disabled={selectionDisabled}
                onChange={() => onSetSelection(selectableIds, !allDaySelected)}
              />
              <span className="text-xs font-medium text-ink-2 select-none">
                {t("Select all posts")}
              </span>
            </div>
          )}
          {posts.length === 0 ? (
            <div className="py-8 text-center text-ink-3 text-sm">
              {t("No posts scheduled for this day yet. Click below to schedule one.")}
            </div>
          ) : (
            posts.map((row) => {
              const preview = resolveRowPreviewAttachment(row);
              const primaryImage =
                preview?.asset.thumbnail_url ?? preview?.asset.download_url ?? null;
              const rawStatus = normalizePostStatus(row);
              const providers = resolveRowProviders(row);

              return (
                <div
                  key={row.id}
                  className="rounded-card border border-line bg-page p-3 flex flex-col gap-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-1 min-w-0 items-start gap-2.5">
                      <Input
                        type="checkbox"
                        aria-label={t("Select post")}
                        checked={selectedIds.has(row.id)}
                        disabled={selectionDisabled || !(canSelect?.(row) ?? true)}
                        onChange={() => onToggleSelection(row.id)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <StatusBadge status={rawStatus} />
                          <div className="flex items-center gap-1">
                            {providers.map((p) => (
                              <PlatformIcon
                                key={`${row.id}-${p}`}
                                provider={p}
                                className="size-3.5"
                              />
                            ))}
                          </div>
                        </div>
                        <p className="text-sm font-medium text-ink line-clamp-2">
                          {resolveRowCaption(row) || t("Untitled post")}
                        </p>
                      </div>
                    </div>

                    {primaryImage && (
                      <div className="size-14 rounded-control overflow-hidden shrink-0 border border-line bg-surface">
                        <img src={primaryImage} alt="" className="size-full object-cover" />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onViewDetails(row.id)}
                      className="h-7 text-xs rounded-control gap-1"
                    >
                      <Info className="size-3" />
                      {t("Details")}
                    </Button>
                    {canMutate && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEdit(row.id)}
                        className="h-7 text-xs rounded-control gap-1"
                      >
                        <Edit3 className="size-3" />
                        {t("Edit")}
                      </Button>
                    )}
                    {(canSelect?.(row) ?? true) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDelete(row.id)}
                        className="h-7 text-xs rounded-control text-destructive border-destructive/30 hover:bg-destructive/10"
                      >
                        <Trash2 className="size-3" />
                        {t("Delete")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <CenterDialogFooter className="flex items-center justify-between sm:justify-between w-full">
          <Button variant="outline" onClick={onClose} className="rounded-control">
            {t("Close")}
          </Button>
          {canMutate && (
            <Button variant="default" onClick={onScheduleNew} className="rounded-control gap-1.5">
              <Plus className="size-4" />
              {t("Schedule post for this date")}
            </Button>
          )}
        </CenterDialogFooter>
      </CenterDialogContent>
    </CenterDialog>
  );
});
