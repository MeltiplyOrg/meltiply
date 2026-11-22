import { useState, useCallback, useMemo } from "react";
import { useWorkspace } from "@/context/workspace.context";
import { Button } from "@meltiply/ui/button";
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
import { BulkSelectionBar } from "@/components/layout/bulk-selection-bar";
import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@meltiply/ui/tooltip";

import { useSessionScope } from "@/hooks/use-session-scope";
import {
  useCalendar,
  useCancelDistribution,
  useDeletePost,
  useDeletePostsBatch,
  usePosts,
  POSTS_PAGE_SIZE,
} from "@/lib/queries";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Trans, useI18n } from "@/lib/i18n";
import { useSearchParams } from "@/lib/navigation";
import { toast } from "@meltiply/ui/toast";
import { Alert } from "@meltiply/ui/alert";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";
import {
  CenterAlertDialog,
  CenterAlertDialogContent,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogAction,
  CenterAlertDialogCancel,
} from "@meltiply/ui/center-alert-dialog";
import type { ChannelIntegration } from "@/api/types";
import type { Post, PostQueryParams } from "@/types";

import { PostTableView } from "./post-table-view";
import { PostCalendarGridView } from "./post-calendar-grid-view";
import { toCalendarRows, toPostRow } from "./post-row";
import { postsOnCalendarDay } from "./calendar-dates";
import { usePublishingTimeZone } from "@/context/publishing-timezone.context";
import { PostGridCardView } from "./post-grid-card-view";
import type { PostGroupBy } from "./post-groups";
import { CalendarDateDetailDialog } from "./calendar-date-detail-dialog";
import { PostsDrawer } from "./posts-drawer";
import { usePostComposerSurface } from "./post-composer-surface";
import { usePostDetailSurface } from "./post-detail-surface";
import { PostsToolbar } from "./posts-toolbar";
import {
  filterAndSortPosts,
  prunePostSelection,
  resolveCancellableDistributionIds,
  resolveRowCaption,
} from "./posts-helpers";
import { isDeleteProtectedPublicationStatus } from "@/lib/publication-status";
import type {
  PostViewMode,
  PostStatusFilter,
  PostSortKey,
  PostsViewProps,
  CalendarDayCell,
  PostRow,
  PostDestructiveRequest,
  PostSelectionEntry,
} from "./types";

export function PostsView({
  initialViewMode = "table",
  initialStatusFilter = "all",
  initialPostId,
  initialComposerOpen = false,
  onNavigate,
}: PostsViewProps) {
  const {
    brandProfiles,
    integrations,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    selectedPlatforms,
    setSelectedPlatforms,
    canWriteContent,
    isAdmin,
  } = useWorkspace();
  const scope = useSessionScope();
  const { t } = useI18n();
  const publishingTimeZone = usePublishingTimeZone();
  const searchParams = useSearchParams();

  const [viewMode, setViewMode] = useState<PostViewMode>(initialViewMode);
  const [statusFilter, setStatusFilter] = useState<Exclude<PostStatusFilter, "all">[]>(() =>
    initialStatusFilter === "all" ? [] : [initialStatusFilter],
  );
  const [profileFilter, setProfileFilter] = useState<string[]>(() =>
    selectedBrandProfileId ? [selectedBrandProfileId] : [],
  );
  const [previousProfileId, setPreviousProfileId] = useState(selectedBrandProfileId);
  if (previousProfileId !== selectedBrandProfileId) {
    setPreviousProfileId(selectedBrandProfileId);
    setProfileFilter(selectedBrandProfileId ? [selectedBrandProfileId] : []);
  }
  const handleProfileFilterChange = useCallback(
    (profiles: string[]) => {
      const owner = profiles.length === 1 ? profiles[0] : null;
      setProfileFilter(profiles);
      setPreviousProfileId(owner);
      setSelectedBrandProfileId(owner);
    },
    [setSelectedBrandProfileId],
  );
  const [dateFilter, setDateFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortKey, setSortKey] = useState<PostSortKey>("date-desc");
  const [columns, setColumns] = useState<number>(4);
  const [groupBy, setGroupBy] = useState<PostGroupBy>("status");
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set());
  const [requestedGridPage, setRequestedGridPage] = useState(0);
  const gridCriteria = JSON.stringify([
    scope.workspaceId,
    scope.brandProfileId,
    statusFilter,
    profileFilter,
    selectedPlatforms,
    dateFilter,
    searchQuery,
    sortKey,
  ]);
  const [previousGridCriteria, setPreviousGridCriteria] = useState(gridCriteria);
  if (previousGridCriteria !== gridCriteria) {
    setPreviousGridCriteria(gridCriteria);
    setRequestedGridPage(0);
  }
  const [editingPostId, setEditingPostId] = useState<string | undefined>(initialPostId);
  const [schedulingDate, setSchedulingDate] = useState<Date | undefined>(undefined);
  const [composerKey, setComposerKey] = useState<number>(0);
  const [composerOpen, setComposerOpen] = useState<boolean>(
    initialComposerOpen || Boolean(initialPostId),
  );

  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date());
  const [detailPostId, setDetailPostId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PostDestructiveRequest | null>(null);

  const [selectedPosts, setSelectedPosts] = useState<ReadonlyMap<string, PostSelectionEntry>>(
    new Map(),
  );
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<PostSelectionEntry[] | null>(null);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const shownPendingAction = useLatchedValue(pendingAction);
  const shownBulkDeleteTargets = useLatchedValue(bulkDeleteTargets);

  const [prevInputs, setPrevInputs] = useState({
    initialViewMode,
    initialStatusFilter,
    initialPostId,
    initialComposerOpen,
  });

  if (
    prevInputs.initialViewMode !== initialViewMode ||
    prevInputs.initialStatusFilter !== initialStatusFilter ||
    prevInputs.initialPostId !== initialPostId ||
    prevInputs.initialComposerOpen !== initialComposerOpen
  ) {
    const compositionChanged =
      prevInputs.initialPostId !== initialPostId ||
      prevInputs.initialComposerOpen !== initialComposerOpen;
    setPrevInputs({ initialViewMode, initialStatusFilter, initialPostId, initialComposerOpen });
    if (initialViewMode) setViewMode(initialViewMode);
    if (initialStatusFilter) {
      setStatusFilter(initialStatusFilter === "all" ? [] : [initialStatusFilter]);
    }
    if (compositionChanged) {
      setEditingPostId(initialPostId);
      setSchedulingDate(undefined);
      setDetailPostId(null);
      setComposerKey((k) => k + 1);
      setComposerOpen(initialComposerOpen || Boolean(initialPostId));
    }
  }

  const scopeKey = `${scope.isSignedIn ? "1" : "0"}|${scope.workspaceId ?? ""}|${scope.brandProfileId ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setSelectedPosts(new Map());
    setBulkDeleteTargets(null);
    setPendingAction(null);
  }

  const calendarRange = useMemo(() => {
    const y = calendarMonth.getFullYear();
    const m = calendarMonth.getMonth();
    const start = new Date(y, m - 1, 20, 0, 0, 0, 0);
    const end = new Date(y, m + 1, 15, 23, 59, 59, 999);
    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }, [calendarMonth]);

  const isDraftFilter = statusFilter.length === 1 && statusFilter[0] === "draft";
  const isCalendarMode = viewMode === "calendar";

  const postParams = useMemo<Omit<PostQueryParams, "limit" | "offset">>(
    () => (isDraftFilter ? { status: "draft" } : {}),
    [isDraftFilter],
  );

  const postsQuery = usePosts(scope, postParams);
  const calendarQuery = useCalendar(
    scope,
    isCalendarMode ? { start: calendarRange.startDate, end: calendarRange.endDate } : undefined,
  );
  const deletePost = useDeletePost(scope);
  const deletePostsBatch = useDeletePostsBatch(scope);
  const cancelDistribution = useCancelDistribution(scope);

  const integrationById = useMemo(() => {
    const map = new Map<string, ChannelIntegration>();
    for (const integration of integrations) map.set(integration.id, integration);
    return map;
  }, [integrations]);

  const loadedPosts = useMemo(() => postsQuery.data ?? [], [postsQuery.data]);

  const postById = useMemo(() => {
    const map = new Map<string, Post>();
    for (const post of loadedPosts) map.set(post.id, post);
    return map;
  }, [loadedPosts]);

  const posts = useMemo<PostRow[]>(() => {
    if (isCalendarMode) {
      return toCalendarRows(
        calendarQuery.data ?? [],
        postById,
        integrationById,
        publishingTimeZone,
      );
    }
    return loadedPosts.map((post) => toPostRow(post, integrationById));
  }, [
    isCalendarMode,
    calendarQuery.data,
    loadedPosts,
    postById,
    integrationById,
    publishingTimeZone,
  ]);

  const rowByPostId = useMemo(() => {
    const map = new Map<string, PostRow>();
    for (const row of posts) map.set(row.id, row);
    return map;
  }, [posts]);

  const hasPublishedDistribution = useCallback(
    (row: PostRow) =>
      row.channels.some((channel) =>
        isDeleteProtectedPublicationStatus(channel.distribution?.status ?? channel.status),
      ),
    [],
  );

  const canDeletePost = useCallback(
    (row: PostRow) => canWriteContent && (isAdmin || !hasPublishedDistribution(row)),
    [canWriteContent, hasPublishedDistribution, isAdmin],
  );

  const postProfileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of posts) {
      if (row.brandProfileId) ids.add(row.brandProfileId);
    }
    return [...ids];
  }, [posts]);

  const isLoading = isCalendarMode
    ? calendarQuery.isLoading || postsQuery.isLoading
    : postsQuery.isLoading;

  const queryError = isCalendarMode ? (calendarQuery.error ?? postsQuery.error) : postsQuery.error;

  const selectionData = useMemo(() => {
    const known: { id: string; brandProfileId: string | null }[] = loadedPosts.map((post) => ({
      id: post.id,
      brandProfileId: post.brand_profile_id,
    }));
    if (isCalendarMode) {
      for (const event of calendarQuery.data ?? []) {
        known.push({ id: event.post_id, brandProfileId: event.brand_profile_id });
      }
    }
    return known;
  }, [loadedPosts, isCalendarMode, calendarQuery.data]);

  const dataSettled = !postsQuery.isFetching && !calendarQuery.isFetching;
  if (selectedPosts.size > 0) {
    const pruned = prunePostSelection(selectedPosts, selectionData, {
      dataSettled,
      draftFilter: isDraftFilter,
    });
    if (pruned !== selectedPosts) setSelectedPosts(pruned);
  }

  const refetchActive = useCallback(() => {
    const tasks: Promise<unknown>[] = [postsQuery.refetch()];
    if (isCalendarMode) tasks.push(calendarQuery.refetch());
    return Promise.all(tasks);
  }, [postsQuery, calendarQuery, isCalendarMode]);

  const dateParam = searchParams.get("date");
  const [prevDateParam, setPrevDateParam] = useState(dateParam);
  if (dateParam !== prevDateParam) {
    setPrevDateParam(dateParam);
    if (dateParam) {
      const parsed = new Date(`${dateParam}T00:00:00`);
      if (!isNaN(parsed.getTime())) {
        setCalendarMonth(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
        setSelectedCalendarDate(parsed);
      }
    }
  }

  const handleDeletePostAction = useCallback(
    (postId: string) => {
      const row = rowByPostId.get(postId);
      if (!row || !canDeletePost(row)) return;
      setPendingAction({
        kind: "delete-post",
        postId,
        brandProfileId: row.brandProfileId,
        distributionIds: [],
      });
    },
    [rowByPostId, canDeletePost],
  );

  const confirmPendingAction = useCallback(() => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    const work =
      action.kind === "delete-post"
        ? deletePost.mutateAsync({ id: action.postId, brandProfileId: action.brandProfileId })
        : Promise.all(action.distributionIds.map((id) => cancelDistribution.mutateAsync(id)));
    work
      .then(() => {
        const row = rowByPostId.get(action.postId);
        const caption = row ? resolveRowCaption(row) : "";
        toast(action.kind === "delete-post" ? t("Post deleted") : t("Scheduled post cancelled"), {
          description:
            action.kind === "delete-post"
              ? caption || t("The post and its pending channels were removed.")
              : t("Cancelled {count} pending channel(s).", {
                  count: action.distributionIds.length,
                }),
          variant: "success",
        });
        setDetailPostId((current) => (current === action.postId ? null : current));
      })
      .catch(() => {
        toast(
          action.kind === "delete-post"
            ? t("Could not delete this post")
            : t("Could not cancel this post"),
          {
            description: t("We could not complete that request. Try again in a moment."),
            variant: "error",
          },
        );
      });
  }, [pendingAction, deletePost, cancelDistribution, rowByPostId, t]);

  const handleModalRequestDelete = useCallback((request: PostDestructiveRequest) => {
    setPendingAction(request);
  }, []);

  const handleTogglePostSelection = useCallback(
    (postId: string) => {
      setSelectedPosts((prev) => {
        const next = new Map(prev);
        if (next.has(postId)) {
          next.delete(postId);
        } else {
          const row = rowByPostId.get(postId);
          if (!row || !canDeletePost(row)) return prev;
          next.set(postId, {
            id: postId,
            brandProfileId: row.brandProfileId,
            isDraft: postById.get(postId)?.status === "draft",
          });
        }
        return next;
      });
    },
    [rowByPostId, postById, canDeletePost],
  );

  const handleSetPostSelection = useCallback(
    (postIds: string[], selected: boolean) => {
      setSelectedPosts((prev) => {
        const next = new Map(prev);
        for (const postId of postIds) {
          if (selected) {
            const row = rowByPostId.get(postId);
            if (!row || !canDeletePost(row)) continue;
            next.set(postId, {
              id: postId,
              brandProfileId: row.brandProfileId,
              isDraft: postById.get(postId)?.status === "draft",
            });
          } else {
            next.delete(postId);
          }
        }
        return next;
      });
    },
    [rowByPostId, postById, canDeletePost],
  );

  const handleClearPostSelection = useCallback(() => {
    setSelectedPosts(new Map());
  }, []);

  const openBulkDelete = useCallback(() => {
    const targets = [...selectedPosts.values()].filter((entry) => {
      const row = rowByPostId.get(entry.id);
      return row !== undefined && canDeletePost(row);
    });
    if (targets.length === 0) return;
    setBulkDeleteTargets(targets);
  }, [selectedPosts, rowByPostId, canDeletePost]);

  const handleConfirmBulkDelete = useCallback(async () => {
    const targets = bulkDeleteTargets;
    if (!targets || bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      const outcome = await deletePostsBatch.mutateAsync({
        targets: targets.map((target) => ({
          id: target.id,
          brandProfileId: target.brandProfileId,
        })),
      });
      succeeded = outcome.deletedIds.length;
      failed = outcome.failed.length;
      const deleted = new Set(outcome.deletedIds);
      setSelectedPosts((prev) => {
        const next = new Map(prev);
        for (const id of deleted) next.delete(id);
        return next;
      });
    } catch {
      failed = targets.length;
    } finally {
      setBulkDeleteBusy(false);
      setBulkDeleteTargets(null);
    }
    if (failed === 0) {
      toast(
        succeeded === 1 ? t("Post deleted") : t("Deleted {count} posts", { count: succeeded }),
        {
          description: t("The posts were removed and their pending channels stopped."),
          variant: "success",
        },
      );
    } else if (succeeded === 0) {
      toast(t("Could not delete the selected posts"), {
        description: t("We could not complete that request. Try again in a moment."),
        variant: "error",
      });
    } else {
      toast(t("Deleted {succeeded} of {total} posts", { succeeded, total: targets.length }), {
        description: t("{failed} could not be deleted and remain selected.", { failed }),
        variant: "error",
      });
    }
  }, [bulkDeleteTargets, bulkDeleteBusy, deletePostsBatch, t]);

  const handleEditPost = useCallback(
    (postId: string) => {
      const row = posts.find((r) => r.id === postId);
      const editable = Boolean(
        row && (row.post?.status === "draft" || resolveCancellableDistributionIds(row).length > 0),
      );
      if (!editable) {
        toast(t("Editing published posts is not supported yet"), {
          description: t("Only drafts and scheduled posts can be edited."),
        });
        return;
      }
      setDetailPostId(null);
      setSelectedCalendarDate(null);
      setEditingPostId(postId);
      setSchedulingDate(undefined);
      setComposerKey((k) => k + 1);
      setComposerOpen(true);
    },
    [posts, t],
  );

  const handleCreatePost = useCallback(() => {
    setDetailPostId(null);
    if (composerOpen) return;
    setEditingPostId(undefined);
    setSchedulingDate(undefined);
    setComposerKey((k) => k + 1);
    setComposerOpen(true);
  }, [composerOpen]);

  const handleComposerOpenChange = useCallback((open: boolean) => {
    if (open) return;
    setComposerOpen(false);
    setEditingPostId(undefined);
    setSchedulingDate(undefined);
  }, []);

  const handlePostSuccess = useCallback(() => {
    setComposerOpen(false);
    setEditingPostId(undefined);
    setSchedulingDate(undefined);
    refetchActive().catch(() => {});
  }, [refetchActive]);

  const handlePrevMonth = useCallback(() => {
    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const handleNextMonth = useCallback(() => {
    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }, []);

  const handleToday = useCallback(() => {
    setCalendarMonth(new Date());
  }, []);

  const handleWeekNavigate = useCallback((offset: number) => {
    setCalendarMonth(
      (previous) =>
        new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + offset * 7),
    );
  }, []);

  const processedPosts = useMemo(() => {
    return filterAndSortPosts(posts, {
      statusFilter,
      platformFilter: selectedPlatforms,
      profileFilter,
      searchQuery,
      dateFilter,
      sortKey,
    });
  }, [posts, statusFilter, selectedPlatforms, profileFilter, searchQuery, dateFilter, sortKey]);

  const lastGridPage = Math.max(0, Math.ceil(processedPosts.length / POSTS_PAGE_SIZE) - 1);
  const gridPage = Math.min(requestedGridPage, lastGridPage);
  const visiblePosts =
    viewMode === "grid"
      ? processedPosts.slice(gridPage * POSTS_PAGE_SIZE, (gridPage + 1) * POSTS_PAGE_SIZE)
      : processedPosts;

  const nextGridPage = async () => {
    if (gridPage < lastGridPage) {
      setRequestedGridPage(gridPage + 1);
      return;
    }
    const result = await postsQuery.fetchNextPage({ cancelRefetch: false });
    if (!result.isError) setRequestedGridPage(gridPage + 1);
  };

  const pagination = !isLoading && viewMode !== "calendar" && (
    <div className="flex flex-col items-center gap-2 py-4">
      {postsQuery.isFetchNextPageError && (
        <p role="alert" className="text-xs text-red">
          {t("An error has occurred.")}
        </p>
      )}
      {viewMode === "grid" ? (
        <nav aria-label={t("Posts")} className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={gridPage === 0 || postsQuery.isFetching || bulkDeleteBusy}
            onClick={() => setRequestedGridPage(gridPage - 1)}
          >
            {t("Previous page")}
          </Button>
          <span className="text-xs tabular-nums text-ink-3" aria-live="polite">
            {t("Page {page}", { page: gridPage + 1 })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={
              (gridPage >= lastGridPage && !postsQuery.hasNextPage) ||
              postsQuery.isFetching ||
              bulkDeleteBusy
            }
            onClick={() => void nextGridPage()}
          >
            {postsQuery.isFetchingNextPage ? t("Loading…") : t("Next page")}
          </Button>
        </nav>
      ) : (
        (postsQuery.hasNextPage || postsQuery.isFetchNextPageError) && (
          <Button
            variant="outline"
            size="sm"
            disabled={postsQuery.isFetching || bulkDeleteBusy}
            onClick={() => void postsQuery.fetchNextPage({ cancelRefetch: false })}
          >
            {postsQuery.isFetchingNextPage ? t("Loading…") : t("Load more")}
          </Button>
        )
      )}
    </div>
  );

  const selectedIds = useMemo(() => new Set(selectedPosts.keys()), [selectedPosts]);

  const detailPost = detailPostId ? (rowByPostId.get(detailPostId) ?? null) : null;

  const detailSurface = usePostDetailSurface({
    post: detailPost,
    canMutate: canWriteContent && selectedBrandProfileId !== null,
    canDelete: detailPost !== null && canDeletePost(detailPost),
    onClose: () => handleCloseDetail(),
    onEdit: handleEditPost,
    onRequestDelete: handleModalRequestDelete,
  });
  const composerSurface = usePostComposerSurface({
    open: composerOpen,
    initialPostId: editingPostId,
    initialDate: schedulingDate,
    sessionKey: composerKey,
    onClose: () => handleComposerOpenChange(false),
    onPostSuccess: handlePostSuccess,
    onNavigate,
  });

  const calendarDatePosts = useMemo(() => {
    if (!selectedCalendarDate) return [];
    return postsOnCalendarDay(processedPosts, selectedCalendarDate, publishingTimeZone);
  }, [processedPosts, selectedCalendarDate, publishingTimeZone]);

  const handleCalendarCellClick = useCallback((date: Date) => {
    setSelectedCalendarDate(date);
  }, []);

  const handleCloseCalendarDialog = useCallback(() => {
    setSelectedCalendarDate(null);
  }, []);

  const handleScheduleCalendarDate = useCallback((date: Date) => {
    setDetailPostId(null);
    setSchedulingDate(date);
    setSelectedCalendarDate(null);
    setEditingPostId(undefined);
    setComposerKey((key) => key + 1);
    setComposerOpen(true);
  }, []);

  const handleScheduleNewFromCalendar = useCallback(() => {
    if (selectedCalendarDate) handleScheduleCalendarDate(selectedCalendarDate);
  }, [selectedCalendarDate, handleScheduleCalendarDate]);

  const handleViewDetails = useCallback((postId: string) => {
    setDetailPostId(postId);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailPostId(null);
  }, []);

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const totalDaysInPrevMonth = new Date(year, month, 0).getDate();

    const days: CalendarDayCell[] = [];

    for (let i = firstDayIndex - 1; i >= 0; i--) {
      days.push({
        date: new Date(year, month - 1, totalDaysInPrevMonth - i),
        isCurrentMonth: false,
        dayNumber: totalDaysInPrevMonth - i,
      });
    }

    for (let i = 1; i <= totalDaysInMonth; i++) {
      days.push({
        date: new Date(year, month, i),
        isCurrentMonth: true,
        dayNumber: i,
      });
    }

    const remainingDays = Math.max(35, Math.ceil(days.length / 7) * 7) - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      days.push({
        date: new Date(year, month + 1, i),
        isCurrentMonth: false,
        dayNumber: i,
      });
    }

    return days;
  }, [calendarMonth]);

  const gridColumnClass =
    columns === 1
      ? "grid-cols-1"
      : columns === 2
        ? "grid-cols-1 sm:grid-cols-2"
        : columns === 3
          ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          : columns === 5
            ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            : "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4";

  const viewModeContent =
    viewMode === "calendar" ? (
      <PostCalendarGridView
        posts={processedPosts}
        isLoading={isLoading}
        calendarMonth={calendarMonth}
        calendarDays={calendarDays}
        onPrevMonth={handlePrevMonth}
        onNextMonth={handleNextMonth}
        onToday={handleToday}
        onCellClick={handleCalendarCellClick}
        onWeekNavigate={handleWeekNavigate}
        onScheduleDate={handleScheduleCalendarDate}
        onViewDetails={handleViewDetails}
        canSchedule={canWriteContent && selectedBrandProfileId !== null}
        selectionActive={selectedIds.size > 0}
      />
    ) : viewMode === "grid" ? (
      <PostGridCardView
        posts={visiblePosts}
        isLoading={isLoading}
        gridColumnClass={gridColumnClass}
        page={gridPage}
        footer={pagination}
        brandProfiles={brandProfiles}
        canMutate={canWriteContent && selectedBrandProfileId !== null}
        canCreate={canWriteContent}
        canDelete={canDeletePost}
        onEdit={handleEditPost}
        onDelete={handleDeletePostAction}
        onCreatePost={handleCreatePost}
        onViewDetails={handleViewDetails}
        selectedIds={selectedIds}
        onToggleSelection={handleTogglePostSelection}
        onSetSelection={handleSetPostSelection}
        selectionDisabled={bulkDeleteBusy}
        canSelect={canDeletePost}
      />
    ) : (
      <PostTableView
        posts={processedPosts}
        isLoading={isLoading}
        footer={pagination}
        sortKey={sortKey}
        brandProfiles={brandProfiles}
        groupBy={groupBy}
        hiddenColumns={hiddenColumns}
        canCreate={canWriteContent}
        onCreatePost={handleCreatePost}
        onSortChange={setSortKey}
        onViewDetails={handleViewDetails}
        selectedIds={selectedIds}
        onToggleSelection={handleTogglePostSelection}
        onSetSelection={handleSetPostSelection}
        selectionDisabled={bulkDeleteBusy}
        canSelect={canDeletePost}
      />
    );

  return (
    <WorkspaceSurface
      title={t("Posts")}
      description={
        isLoading ? (
          <span role="status">{t("Loading posts…")}</span>
        ) : (
          <Trans
            message="Showing {count} posts across your Brand Profiles."
            values={{ count: <RollingCount value={visiblePosts.length} /> }}
          />
        )
      }
      actions={
        canWriteContent ? (
          <Button variant="default" onClick={handleCreatePost}>
            <Plus className="size-4" />
            {t("Create post")}
          </Button>
        ) : undefined
      }
    >
      {queryError && (isCalendarMode || !postsQuery.isFetchNextPageError) && (
        <Alert variant="destructive" className="items-center">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <p className="flex-1">{t("An error has occurred.")}</p>
          <Button size="sm" variant="outline" onClick={() => refetchActive().catch(() => {})}>
            {t("Try again")}
          </Button>
        </Alert>
      )}

      <PostsToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        hiddenColumns={hiddenColumns}
        onToggleColumn={(column) =>
          setHiddenColumns((previous) => {
            const next = new Set(previous);
            if (next.has(column)) next.delete(column);
            else next.add(column);
            return next;
          })
        }
        columns={columns}
        onColumnsChange={setColumns}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        platformFilter={selectedPlatforms}
        onPlatformChange={setSelectedPlatforms}
        profileFilter={profileFilter}
        onProfileChange={handleProfileFilterChange}
        dateFilter={dateFilter}
        onDateChange={setDateFilter}
        sortKey={sortKey}
        onSortChange={setSortKey}
        brandProfiles={brandProfiles}
        unresolvedProfileIds={postProfileIds}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{viewModeContent}</div>

      <CalendarDateDetailDialog
        selectedDate={selectedCalendarDate}
        posts={calendarDatePosts}
        canMutate={canWriteContent && selectedBrandProfileId !== null}
        onClose={handleCloseCalendarDialog}
        onEdit={handleEditPost}
        onDelete={handleDeletePostAction}
        onScheduleNew={handleScheduleNewFromCalendar}
        onViewDetails={handleViewDetails}
        selectedIds={selectedIds}
        onToggleSelection={handleTogglePostSelection}
        onSetSelection={handleSetPostSelection}
        selectionDisabled={bulkDeleteBusy}
        canSelect={canDeletePost}
      />

      <PostsDrawer
        detail={detailSurface}
        composer={composerSurface}
        headerAction={
          canWriteContent && !(composerOpen && !detailPost) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("New Post")}
                  onClick={handleCreatePost}
                >
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("New Post")}</TooltipContent>
            </Tooltip>
          ) : undefined
        }
      />

      <CenterAlertDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => !open && setPendingAction(null)}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>
              {shownPendingAction?.kind === "delete-post"
                ? t("Delete this post?")
                : t("Cancel pending channels?")}
            </CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {shownPendingAction?.kind === "delete-post"
                ? t(
                    "Deleting this post removes its draft and stops its pending channels. Anything already published stays live on its platform — deleting a post here never removes a copy from a platform.",
                  )
                : t(
                    "Pending distributions for this post will be cancelled. Already-published channels are unaffected.",
                  )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel>{t("Keep post")}</CenterAlertDialogCancel>
            <CenterAlertDialogAction onClick={confirmPendingAction}>
              {shownPendingAction?.kind === "delete-post" ? t("Delete post") : t("Cancel channels")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>

      {canWriteContent && selectedIds.size > 0 && (
        <BulkSelectionBar
          count={selectedIds.size}
          actionLabel={t("Delete")}
          actionIcon={Trash2}
          busyLabel={t("Deleting…")}
          onClear={handleClearPostSelection}
          onAction={openBulkDelete}
          busy={bulkDeleteBusy}
        />
      )}

      <CenterAlertDialog
        open={bulkDeleteTargets !== null}
        onOpenChange={(open) => !open && !bulkDeleteBusy && setBulkDeleteTargets(null)}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>
              {t("Delete {count} posts?", { count: shownBulkDeleteTargets?.length ?? 0 })}
            </CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Deleting the selected posts removes their drafts and stops their pending channels. Anything already published stays live on its platform — deleting a post here never removes a copy from a platform.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel disabled={bulkDeleteBusy}>
              {t("Keep posts")}
            </CenterAlertDialogCancel>
            <CenterAlertDialogAction
              disabled={bulkDeleteBusy}
              onClick={() => void handleConfirmBulkDelete()}
            >
              {bulkDeleteBusy ? t("Deleting…") : t("Delete")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>
    </WorkspaceSurface>
  );
}
