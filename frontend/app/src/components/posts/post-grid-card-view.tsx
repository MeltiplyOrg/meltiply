import React from "react";
import { LayoutGrid, Plus, FileText, Play, Edit3, Trash2, Info } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Empty, EmptyIcon, EmptyTitle, EmptyDescription } from "@meltiply/ui/empty";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { StatusBadge } from "./status-badge";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { platformDisplayName } from "@/lib/platforms";
import {
  normalizePostStatus,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
} from "./posts-helpers";
import {
  SKELETON_CARD_KEYS,
  type BrandProfile,
  type PostRow,
  type PostSelectionProps,
} from "./types";

export interface PostGridCardViewProps extends PostSelectionProps {
  posts: PostRow[];
  isLoading: boolean;
  gridColumnClass: string;
  /** Active Brand Profiles used to resolve each Post row's owning profile name. */
  brandProfiles: BrandProfile[];
  /**
   * Whether scope-owned mutations are allowed; `false` in the aggregate
   * "All Brand Profiles" view. Deletion no longer consumes this flag — the
   * Post's own `brand_profile_id` authorizes it — so only edits stay gated.
   */
  canMutate: boolean;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
  onCreatePost: () => void;
  /**
   * Opens the right-side post detail dialog; invoked by the card's dedicated
   * Details button and by clicking anywhere else on the card.
   */
  onViewDetails: (postId: string) => void;
}

/**
 * Presenter component for Grid View: renders one card per durable Post with its
 * caption preview, ordered attachment thumbnail, targeted platforms, and
 * status aggregated from its Channel outcomes.
 *
 * Row identity is `Post.id`, so a composition spread across Channels with
 * differing publication times stays a single card.
 * The whole card opens details on click, but the dedicated Details button is the
 * genuine keyboard/actionable trigger: card clicks pre-focus it so the right-side
 * dialog restores focus to a real control, and edit/delete keep stopPropagation.
 * A checkbox strip above the grid is the honest select-all — it applies only to
 * the rendered filtered cards — while per-card checkboxes live in the footer
 * action row with stopPropagation. Single deletes are not scope-gated — the
 * card's own Brand Profile id authorizes them — while edit stays behind
 * `canMutate`.
 * Wrapped in `React.memo` to eliminate re-renders when parent states change
 * outside the cards.
 */
export const PostGridCardView = React.memo(function PostGridCardView({
  posts,
  isLoading,
  gridColumnClass,
  brandProfiles,
  canMutate,
  onEdit,
  onDelete,
  onCreatePost,
  onViewDetails,
  selectedIds,
  onToggleSelection,
  onSetSelection,
  selectionDisabled,
}: PostGridCardViewProps) {
  const { t } = useI18n();
  const visibleIds = posts.map((row) => row.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <div className={cn("grid gap-4", gridColumnClass)}>
          {SKELETON_CARD_KEYS.map((key) => (
            <div
              key={key}
              className="h-56 rounded-card border border-line bg-surface p-4 flex flex-col justify-between"
            >
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <Empty className="py-16 bg-surface rounded-card border border-line w-full max-w-lg">
          <EmptyIcon>
            <LayoutGrid className="size-6" />
          </EmptyIcon>
          <EmptyTitle>{t("No posts match filters")}</EmptyTitle>
          <EmptyDescription>
            {t("Try adjusting your search query, status, or date range filters.")}
          </EmptyDescription>
          <Button variant="default" onClick={onCreatePost} className="mt-4 rounded-control">
            <Plus className="size-4 mr-1.5" />
            {t("Create post")}
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2 pl-1">
        <Input
          type="checkbox"
          aria-label={t("Select all visible posts")}
          checked={allVisibleSelected}
          disabled={selectionDisabled}
          ref={(el) => {
            if (el) {
              el.indeterminate =
                !allVisibleSelected && visibleIds.some((id) => selectedIds.has(id));
            }
          }}
          onChange={() => onSetSelection(visibleIds, !allVisibleSelected)}
        />
        <span className="text-xs font-medium text-ink-2 select-none">{t("Select all posts")}</span>
      </div>
      <div className={cn("flex-1 min-h-0 overflow-y-auto pr-1", selectedIds.size > 0 && "pb-24")}>
        <div className={cn("grid gap-4", gridColumnClass)}>
          {posts.map((row) => {
            const preview = resolveRowPreviewAttachment(row);
            const primaryImage =
              preview?.asset.thumbnail_url ?? preview?.asset.download_url ?? null;
            const isVideo = preview?.asset.asset_type === "video";

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
              brandProfiles.find((p) => p.id === row.brandProfileId)?.name ?? t("Default Profile");

            return (
              <div
                key={row.id}
                onClick={(event) => {
                  event.currentTarget
                    .querySelector<HTMLButtonElement>("[data-post-details]")
                    ?.focus();
                  onViewDetails(row.id);
                }}
                className="flex flex-col justify-between rounded-card border border-line bg-surface p-3.5 shadow-card hover:shadow-raised hover:border-line-strong transition-all duration-200 cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <p className="text-[13px] font-medium text-ink line-clamp-2 leading-snug">
                      {resolveRowCaption(row) || (
                        <span className="italic text-ink-3">{t("No caption")}</span>
                      )}
                    </p>

                    <div className="flex items-center gap-1.5 pt-0.5">
                      {providers.length > 0 ? (
                        providers.map((p) => (
                          <div
                            key={`${row.id}-${p}`}
                            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-page shadow-hairline"
                            title={platformDisplayName(p)}
                          >
                            <PlatformIcon provider={p} className="size-3.5" />
                          </div>
                        ))
                      ) : (
                        <span className="text-[11px] text-ink-3">—</span>
                      )}
                    </div>

                    <div className="text-[11.5px] text-ink-2 font-medium">{dateStr}</div>
                    <div className="text-[11px] text-ink-3 truncate">
                      {t("Profile")}: <span className="text-ink-2 font-medium">{profileName}</span>
                    </div>
                  </div>

                  <div className="relative size-16 shrink-0 rounded-control overflow-hidden bg-page border border-line flex items-center justify-center">
                    {primaryImage ? (
                      <>
                        <img src={primaryImage} alt="" className="size-full object-cover" />
                        {isVideo && (
                          <div className="absolute inset-0 flex items-center justify-center bg-overlay/30">
                            <Play className="size-3.5 fill-ink-inverse text-ink-inverse" />
                          </div>
                        )}
                      </>
                    ) : (
                      <FileText className="size-5 text-ink-3" />
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-line/60">
                  <StatusBadge status={rawStatus} />
                  <div className="flex items-center gap-1">
                    <Input
                      type="checkbox"
                      aria-label={t("Select post")}
                      checked={selectedIds.has(row.id)}
                      disabled={selectionDisabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleSelection(row.id)}
                    />
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
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
