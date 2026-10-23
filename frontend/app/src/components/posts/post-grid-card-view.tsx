import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { LayoutGrid, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Card } from "@meltiply/ui/card";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Empty, EmptyIcon, EmptyTitle, EmptyDescription } from "@meltiply/ui/empty";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { PostCard } from "./post-card";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
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
  /** Zero-based displayed page; changing it resets only this viewport's scroll. */
  page: number;
  footer: React.ReactNode;
  brandProfiles: BrandProfile[];
  canMutate: boolean;
  canDelete: (post: PostRow) => boolean;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
  canCreate: boolean;
  onCreatePost: () => void;
  onViewDetails: (postId: string) => void;
}

const GRID_VIEWPORT_CLASS = "min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3.5 sm:px-6";

/**
 * Media Grid composed from canonical Post cards with real attachment previews.
 * Selection covers the rendered filtered page and remains owned by PostsView
 * across Table, Grid, and Calendar changes; no reference demo data is used.
 * The owner supplies one bounded page and its navigation footer. Page changes
 * return the viewport to its top without remounting the cards or selection.
 */
export const PostGridCardView = React.memo(function PostGridCardView({
  posts,
  isLoading,
  gridColumnClass,
  page,
  footer,
  brandProfiles,
  canMutate,
  canDelete,
  onEdit,
  onDelete,
  canCreate,
  onCreatePost,
  onViewDetails,
  selectedIds,
  onToggleSelection,
  onSetSelection,
  selectionDisabled,
  canSelect,
}: PostGridCardViewProps) {
  const { t } = useI18n();
  const scrollRef = useSmoothScrollContainer();
  const viewportRef = useRef<HTMLDivElement>(null);
  const attachViewport = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      scrollRef(node);
    },
    [scrollRef],
  );
  useLayoutEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [page]);
  const profiles = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile.name])),
    [brandProfiles],
  );
  const selectablePosts = canSelect ? posts.filter(canSelect) : posts;
  const selectableIds = selectablePosts.map((post) => post.id);
  const selectedCount = selectableIds.reduce((count, id) => count + Number(selectedIds.has(id)), 0);
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
  if (isLoading)
    return (
      <div className={GRID_VIEWPORT_CLASS}>
        <div className={cn("grid gap-3", gridColumnClass)}>
          {/* Same anatomy as `post-card.tsx` - profile line, caption, the
              `h-35` media box, status, meta row, and analytics footer - so resolved cards drop
              into these slots without moving anything. */}
          {SKELETON_CARD_KEYS.map((key) => (
            <Card key={key} aria-hidden="true" className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-35 rounded-chip" />
              <Skeleton className="h-4.5 w-20 rounded-chip" />
              <div className="flex min-h-4.5 items-center gap-2">
                <Skeleton className="h-3.5 w-28" />
              </div>
              <div className="mt-auto grid grid-cols-4 gap-2 border-t border-line pt-2">
                {["views", "likes", "comments", "shares"].map((metric) => (
                  <Skeleton key={metric} className="h-3.5 w-full" />
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  if (posts.length === 0)
    return (
      <div ref={attachViewport} className={GRID_VIEWPORT_CLASS}>
        <Empty className="m-auto border-0">
          <EmptyIcon>
            <LayoutGrid className="size-5" />
          </EmptyIcon>
          <EmptyTitle>{t("No posts match filters")}</EmptyTitle>
          <EmptyDescription>
            {t("Try adjusting your search query, status, or date range filters.")}
          </EmptyDescription>
          {canCreate && (
            <Button variant="outline" onClick={onCreatePost} className="mt-3">
              <Plus className="size-3.5" />
              {t("Create post")}
            </Button>
          )}
        </Empty>
        {footer}
      </div>
    );
  return (
    <div ref={attachViewport} className={cn(GRID_VIEWPORT_CLASS, selectedIds.size > 0 && "pb-32")}>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink-3">
        <Input
          type="checkbox"
          aria-label={t("Select all visible posts")}
          checked={allSelected}
          disabled={selectionDisabled || selectableIds.length === 0}
          onChange={() => onSetSelection(selectableIds, !allSelected)}
        />
        {t("Select all posts")}
      </label>
      <div className={cn("grid gap-3", gridColumnClass)}>
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            postId={post.id}
            profileName={profiles.get(post.brandProfileId) ?? t("Unknown profile")}
            selected={selectedIds.has(post.id)}
            selectionDisabled={selectionDisabled || !(canSelect?.(post) ?? true)}
            onToggleSelection={onToggleSelection}
            canMutate={canMutate}
            canDelete={canDelete(post)}
            onViewDetails={onViewDetails}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
      {footer}
    </div>
  );
});
