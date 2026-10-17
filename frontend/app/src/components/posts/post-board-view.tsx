import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Skeleton } from "@meltiply/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { groupPostRows } from "./post-groups";
import { PostCard } from "./post-card";
import { StatusBadge } from "./status-badge";
import type { PostGridCardViewProps } from "./post-grid-card-view";

const BOARD_STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;

/**
 * Gr8r Tasks Board adapted to immutable publication outcomes: 284px counted,
 * collapsible columns and compact cards. Unknown/in-flight outcomes get their
 * own visible columns instead of disappearing. No drag affordance pretends a
 * provider result can be reassigned. All cards share real Post selection/actions.
 */
export function PostBoardView({
  posts,
  isLoading,
  brandProfiles,
  canMutate,
  onEdit,
  onDelete,
  onCreatePost,
  onViewDetails,
  selectedIds,
  onToggleSelection,
  selectionDisabled,
}: Omit<PostGridCardViewProps, "gridColumnClass" | "onSetSelection">) {
  const { t, tStatus } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const profiles = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile.name])),
    [brandProfiles],
  );
  const groups = useMemo(() => {
    const found = groupPostRows(posts, "status", brandProfiles);
    const byStatus = new Map(found.map((group) => [group.id, group]));
    const ordered = BOARD_STATUSES.map(
      (status) => byStatus.get(status) ?? { id: status, label: status, status, posts: [] },
    );
    for (const group of found)
      if (!BOARD_STATUSES.some((status) => status === group.id)) ordered.push(group);
    return ordered;
  }, [posts, brandProfiles]);
  return (
    <div
      className="flex min-h-0 flex-1 snap-x snap-proximity items-start gap-3 overflow-x-auto px-4 pb-6 pt-3.5 sm:px-6"
      aria-label={t("Posts board")}
    >
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        const toggle = () =>
          setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(group.id)) next.delete(group.id);
            else next.add(group.id);
            return next;
          });
        if (isCollapsed)
          return (
            <Button
              key={group.id}
              variant="ghost"
              className="h-40 w-11 shrink-0 flex-col border border-line-soft bg-inset px-1 py-2.5"
              onClick={toggle}
              aria-label={t("Expand {label}", { label: tStatus(group.id) })}
            >
              <ChevronRight className="size-3.5" />
              <span className="mt-2 text-xs [writing-mode:vertical-rl]">
                {tStatus(group.id)} {group.posts.length}
              </span>
            </Button>
          );
        return (
          <section
            key={group.id}
            className="flex max-h-full w-board-column max-w-[calc(100vw-48px)] shrink-0 snap-start flex-col rounded-window border border-line-soft bg-inset"
            aria-label={tStatus(group.id)}
          >
            <header className="flex items-center gap-1.75 pb-1.5 pl-2.5 pr-2 pt-2.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-5.5"
                aria-label={t("Collapse {label}", { label: tStatus(group.id) })}
                onClick={toggle}
              >
                <ChevronDown className="size-3" />
              </Button>
              <StatusBadge status={group.id} compact />
              <span className="text-xs font-normal tabular-nums text-ink-3">
                {group.posts.length}
              </span>
              {group.id === "draft" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-5.5"
                  onClick={onCreatePost}
                  aria-label={t("Create post")}
                >
                  <Plus className="size-3.5" />
                </Button>
              )}
            </header>
            <div className="flex min-h-15 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 pt-1">
              {isLoading
                ? [0, 1, 2].map((key) => <Skeleton key={key} className="h-28 w-full" />)
                : group.posts.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      postId={post.id}
                      profileName={profiles.get(post.brandProfileId) ?? t("Unknown profile")}
                      canMutate={canMutate}
                      selected={selectedIds.has(post.id)}
                      selectionDisabled={selectionDisabled}
                      onToggleSelection={onToggleSelection}
                      onViewDetails={onViewDetails}
                      onEdit={onEdit}
                      onDelete={onDelete}
                    />
                  ))}
              {group.id === "draft" && (
                <Button
                  variant="ghost"
                  className="h-8.5 w-full justify-start gap-2 px-0 text-control font-normal text-ink-3"
                  onClick={onCreatePost}
                >
                  <Plus className="size-3.5" />
                  {t("Create post")}
                </Button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
