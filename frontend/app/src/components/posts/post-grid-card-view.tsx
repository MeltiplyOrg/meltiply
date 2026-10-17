import React, { useMemo } from "react";
import { LayoutGrid, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Empty, EmptyIcon, EmptyTitle, EmptyDescription } from "@meltiply/ui/empty";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { PostCard } from "./post-card";
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
  brandProfiles: BrandProfile[];
  canMutate: boolean;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
  onCreatePost: () => void;
  onViewDetails: (postId: string) => void;
}

const GRID_VIEWPORT_CLASS = "min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3.5 sm:px-6";

/**
 * Media Grid composed from canonical Post cards with real attachment previews.
 * Selection covers the rendered filtered page and remains owned by PostsView
 * across Table, Grid, and Calendar changes; no reference demo data is used.
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
  const profiles = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile.name])),
    [brandProfiles],
  );
  const visibleIds = posts.map((post) => post.id);
  const selectedCount = visibleIds.reduce((count, id) => count + Number(selectedIds.has(id)), 0);
  const allSelected = visibleIds.length > 0 && selectedCount === visibleIds.length;
  if (isLoading)
    return (
      <div className={GRID_VIEWPORT_CLASS}>
        <div className={cn("grid gap-3", gridColumnClass)}>
          {SKELETON_CARD_KEYS.map((key) => (
            <Skeleton key={key} className="h-64 rounded-card" />
          ))}
        </div>
      </div>
    );
  if (posts.length === 0)
    return (
      <Empty className="m-auto border-0">
        <EmptyIcon>
          <LayoutGrid className="size-5" />
        </EmptyIcon>
        <EmptyTitle>{t("No posts match filters")}</EmptyTitle>
        <EmptyDescription>
          {t("Try adjusting your search query, status, or date range filters.")}
        </EmptyDescription>
        <Button variant="outline" onClick={onCreatePost} className="mt-3">
          <Plus className="size-3.5" />
          {t("Create post")}
        </Button>
      </Empty>
    );
  return (
    <div className={cn(GRID_VIEWPORT_CLASS, selectedIds.size > 0 && "pb-32")}>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink-3">
        <Input
          type="checkbox"
          aria-label={t("Select all visible posts")}
          checked={allSelected}
          disabled={selectionDisabled}
          onChange={() => onSetSelection(visibleIds, !allSelected)}
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
            selectionDisabled={selectionDisabled}
            onToggleSelection={onToggleSelection}
            canMutate={canMutate}
            onViewDetails={onViewDetails}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
});
