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
import type { ChannelIntegration, MediaItem } from "@/api/types";
import type { CalendarEvent, Distribution, Post, PostQueryParams, PostTarget } from "@/types";

import { PostTableView } from "./post-table-view";
import { PostCalendarGridView } from "./post-calendar-grid-view";
import { PostGridCardView } from "./post-grid-card-view";
import type { PostGroupBy } from "./post-groups";
import { CalendarDateDetailDialog } from "./calendar-date-detail-dialog";
import { PostsDrawer } from "./posts-drawer";
import { usePostComposerSurface } from "./post-composer-surface";
import { usePostDetailSurface } from "./post-detail-surface";
import { PostsToolbar } from "./posts-toolbar";
import {
  filterAndSortPosts,
  isPublishedDistributionStatus,
  prunePostSelection,
  resolveChannelMedia,
  resolveChannelText,
  resolveCancellableDistributionIds,
  resolvePostDisplayDate,
  resolveRowCaption,
  summarizeChannelStatuses,
  toLocalDateKey,
} from "./posts-helpers";
import type {
  PostViewMode,
  PostStatusFilter,
  PostSortKey,
  PostsViewProps,
  CalendarDayCell,
  PostDetailItem,
  PostRow,
  PostDestructiveRequest,
  PostSelectionEntry,
  ChannelMediaItem,
} from "./types";

/** Page size for the Post list, which every view mode projects into rows. */
const POSTS_PAGE_LIMIT = 100;

/** Workspace channel integrations keyed by Platform account id. */
type IntegrationById = Map<string, ChannelIntegration>;

/**
 * Resolves the display instant for a distribution: the scheduled slot when set,
 * otherwise the actual publish time, otherwise creation time.
 */
function distributionDate(d: Distribution): string {
  return d.scheduled_at ?? d.published_at ?? d.created_at;
}

/**
 * Resolves the display instant for a calendar event the same way distributions do.
 */
function calendarEventDate(e: CalendarEvent): string {
  return e.scheduled_at ?? e.published_at ?? e.updated_at;
}

/**
 * Projects one Channel's resolved media into the preview image list, skipping
 * items with no renderable live attachment — including frozen media detached
 * from the Post, which is never replaced by media the Channel did not publish.
 */
function toPreviewImages(media: ChannelMediaItem[]): MediaItem[] {
  const images: MediaItem[] = [];
  for (const item of media) {
    const path = item.attachment?.asset.thumbnail_url ?? item.attachment?.asset.download_url;
    if (path) images.push({ id: item.assetId, path });
  }
  return images;
}

/**
 * Projects one Channel of a Post — a saved per-account target and its
 * independent outcome — into a view-model entry.
 *
 * A Channel with no outcome yet still renders: a saved draft target reads as
 * `draft`, and an active Post's unscheduled target reads as `scheduled` pending
 * work, because the aggregate status must come from outcomes without hiding a
 * destination the creator already chose. Once a Provider attempt claimed the
 * outcome, its caption and media come from the frozen publication, so later
 * Post or target edits never rewrite what this Channel displays as delivered.
 */
function toChannelEntry(
  post: Post,
  target: PostTarget | undefined,
  distribution: Distribution | undefined,
  integrationById: IntegrationById,
): PostDetailItem {
  const accountId = distribution?.platform_account_id ?? target?.platform_account_id ?? null;
  const media = resolveChannelMedia(post, target, distribution);
  const caption = resolveChannelText(post, distribution ?? target ?? {}, distribution?.publication);
  return {
    id: distribution?.id ?? `target:${accountId ?? post.id}`,
    postId: post.id,
    publishDate: distribution ? distributionDate(distribution) : resolvePostDisplayDate(post),
    status: distribution?.status ?? (post.status === "draft" ? "draft" : "scheduled"),
    errorMessage: distribution?.failure?.message ?? null,
    integration: accountId ? integrationById.get(accountId) : undefined,
    content: [{ content: caption, image: toPreviewImages(media) }],
    attachments: media,
    distribution,
    target,
  };
}

/**
 * Projects a durable Post into one collection row, so Table, Grid, Calendar,
 * and Details agree on identity. Channel entries follow the Post's saved target
 * order first and then any outcome without a target, and the row's display
 * status is aggregated from those outcomes only — never from `Post.status`,
 * which is a lifecycle marker rather than a global success flag.
 *
 * @param post - Durable Post with ordered attachments, targets, and outcomes.
 * @param integrationById - Workspace channel integrations keyed by Platform account id.
 * @returns One Post row whose `id` is `post.id`.
 */
function toPostRow(post: Post, integrationById: IntegrationById): PostRow {
  const channels: PostDetailItem[] = [];
  const seen = new Set<string>();
  const distributionByAccount = new Map<string, Distribution>();
  for (const distribution of post.distributions) {
    const accountId = distribution.platform_account_id;
    if (accountId && !distributionByAccount.has(accountId)) {
      distributionByAccount.set(accountId, distribution);
    }
  }
  for (const target of post.targets) {
    if (seen.has(target.platform_account_id)) continue;
    seen.add(target.platform_account_id);
    const distribution = distributionByAccount.get(target.platform_account_id);
    channels.push(toChannelEntry(post, target, distribution, integrationById));
  }
  for (const distribution of post.distributions) {
    if (distribution.platform_account_id && seen.has(distribution.platform_account_id)) continue;
    channels.push(toChannelEntry(post, undefined, distribution, integrationById));
  }
  return {
    id: post.id,
    date: resolvePostDisplayDate(post),
    // Only real outcomes drive the aggregate: a saved target that has not been
    // scheduled yet has no outcome to summarize, and an active Post with only
    // such targets reads as pending work.
    status:
      post.status === "draft"
        ? "draft"
        : summarizeChannelStatuses(
            channels.filter((c) => c.distribution !== undefined).map((c) => c.status),
            "scheduled",
          ),
    channels,
    brandProfileId: post.brand_profile_id,
    post,
  };
}

/**
 * Projects a calendar event into a row when its Post is outside the loaded Post
 * page. The entry carries only the event's own outcome and no caption or media
 * claim, so an unloaded range degrades to real calendar data instead of
 * inventing Post content.
 */
function toEventRow(event: CalendarEvent, integrationById: IntegrationById): PostRow {
  const integration = event.platform_account_id
    ? integrationById.get(event.platform_account_id)
    : undefined;
  return {
    id: event.post_id,
    date: calendarEventDate(event),
    status: event.status,
    brandProfileId: event.brand_profile_id,
    channels: [
      {
        id: event.id,
        postId: event.post_id,
        publishDate: calendarEventDate(event),
        status: event.status,
        integration,
        content: [],
        attachments: [],
        calendarEvent: event,
      },
    ],
  };
}

/**
 * Folds calendar events onto Post identity for the month grid: events of one
 * Post that land on the same day collapse into a single row, and a Post whose
 * Channels publish on different days appears once per affected day. Because
 * `post_id` is the fold key, differing publication times never fragment one
 * composition, and two separately created Posts never merge.
 */
function toCalendarRows(
  events: CalendarEvent[],
  postById: Map<string, Post>,
  integrationById: IntegrationById,
): PostRow[] {
  const rows = new Map<string, PostRow>();
  for (const event of events) {
    const date = calendarEventDate(event);
    const dayKey = toLocalDateKey(date);
    if (rows.has(`${event.post_id}::${dayKey}`)) continue;
    const post = postById.get(event.post_id);
    rows.set(`${event.post_id}::${dayKey}`, {
      ...(post ? toPostRow(post, integrationById) : toEventRow(event, integrationById)),
      date,
    });
  }
  return [...rows.values()];
}

/**
 * Unified Posts page over one durable Post pipeline and three real collection
 * views. `usePosts` supplies each Post, its ordered attachments, targets, and
 * independent Channel outcomes; `useCalendar` folds events by Post identity
 * without merging or splitting compositions. Status filters derive from those
 * outcomes; provider status is observed, never locally edited.
 *
 * Table and Grid share Post selection and action callbacks;
 * Calendar day detail uses the same identity map. Selection snapshots each
 * owner's `brand_profile_id`, survives view/filter/group changes within its
 * scope, clears on scope changes, and is pruned when settled data no longer
 * contains an entry. Bulk deletion confirms a fixed target snapshot, removes
 * successes immediately, retains failures for retry, and reports real counts.
 *
 * The view renders directly with no snapshot or route-transition layer.
 * Composer code loads only when editing begins; its local Suspense boundary
 * leaves navigation and collection controls usable while that chunk downloads.
 *
 * @param props - Initial view mode, default status filter, Post id to edit,
 * and workspace navigation callback.
 * @returns Complete unified Posts page with responsive collection controls.
 */
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
  /**
   * One selected profile remains the mutation/composer owner. Zero or several
   * profiles query the aggregate scope and filter locally without inventing a
   * multi-owner Post; external scope changes replace this collection selection.
   */
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
  const [editingPostId, setEditingPostId] = useState<string | undefined>(initialPostId);
  const [schedulingDate, setSchedulingDate] = useState<Date | undefined>(undefined);
  const [composerKey, setComposerKey] = useState<number>(0);
  /** Composition lives in the shared drawer, seeded by a compose deep link. */
  const [composerOpen, setComposerOpen] = useState<boolean>(
    initialComposerOpen || Boolean(initialPostId),
  );

  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date());
  const [detailPostId, setDetailPostId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PostDestructiveRequest | null>(null);

  /**
   * Multi-select identity map: `Post.id` → owning-profile snapshot. Deletion
   * authorizes per entry (`brand_profile_id`), so the set may span profiles in
   * the aggregate view. Retained across view/filter changes inside one scope;
   * cleared on scope switch and pruned to loaded data once queries settle.
   */
  const [selectedPosts, setSelectedPosts] = useState<ReadonlyMap<string, PostSelectionEntry>>(
    new Map(),
  );
  /** Snapshot handed to the bulk-delete CenterAlertDialog so confirmation deletes exactly what the user confirmed. */
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<PostSelectionEntry[] | null>(null);
  /** True while the sequential bulk-delete batch runs; disables every selection control and the bar. */
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  /** Last confirmation contents, rendered through each dialog's exit so its text never changes while closing. */
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

  /**
   * Mutation scope key: the selection, open confirmations, and latched
   * snapshots authorize against owning profiles captured under one scope, so a
   * workspace or Brand Profile switch drops them instead of letting a stale
   * identity act in the new scope. Same render-phase adjustment pattern as
   * `prevInputs` above — no effect round-trip, no one-frame stale UI.
   */
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
    // Cover full month plus padding from adjacent months displayed in the 7-column grid
    const start = new Date(y, m - 1, 20, 0, 0, 0, 0);
    const end = new Date(y, m + 1, 15, 23, 59, 59, 999);
    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }, [calendarMonth]);

  const isDraftFilter = statusFilter.length === 1 && statusFilter[0] === "draft";
  const isCalendarMode = viewMode === "calendar";

  /**
   * Query params for the Post page. The draft filter is the only bucket the API
   * can select itself; every other bucket needs the full page because a Post can
   * hold published, pending, and failed Channels at once and must stay findable
   * under each of them.
   */
  const postParams = useMemo<PostQueryParams>(
    () =>
      isDraftFilter ? { limit: POSTS_PAGE_LIMIT, status: "draft" } : { limit: POSTS_PAGE_LIMIT },
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

  const integrationById = useMemo<IntegrationById>(() => {
    const map: IntegrationById = new Map();
    for (const integration of integrations) map.set(integration.id, integration);
    return map;
  }, [integrations]);

  const loadedPosts = useMemo(() => postsQuery.data?.posts ?? [], [postsQuery.data]);

  const postById = useMemo(() => {
    const map = new Map<string, Post>();
    for (const post of loadedPosts) map.set(post.id, post);
    return map;
  }, [loadedPosts]);

  /**
   * Raw Post rows for the active mode: calendar events folded onto `post_id`
   * for the month grid, or one row per loaded Post in Table and Grid. Drafts are
   * stored Posts, so the draft filter needs no client-side reconstruction of
   * "content without outcomes".
   */
  const posts = useMemo<PostRow[]>(() => {
    if (isCalendarMode) {
      return toCalendarRows(calendarQuery.data ?? [], postById, integrationById);
    }
    return loadedPosts.map((post) => toPostRow(post, integrationById));
  }, [isCalendarMode, calendarQuery.data, loadedPosts, postById, integrationById]);

  /** True when a row reached or is attempting a Provider and deletion is Admin-only. */
  const hasPublishedDistribution = useCallback(
    (row: PostRow) =>
      row.channels.some((channel) =>
        isPublishedDistributionStatus(channel.distribution?.status ?? channel.status),
      ),
    [],
  );

  /**
   * Shared by single delete, detail delete, and bulk selection. Viewers never
   * delete; Editors may delete drafts and scheduled Posts; Admins may also
   * delete Posts with published work.
   */
  const canDeletePost = useCallback(
    (row: PostRow) => canWriteContent && (isAdmin || !hasPublishedDistribution(row)),
    [canWriteContent, hasPublishedDistribution, isAdmin],
  );

  /**
   * Distinct Brand Profile ids carried by the rendered Post rows, forwarded to
   * the toolbar's profile checklist as `unresolvedProfileIds`. The checklist
   * keeps only ids missing from `brandProfiles` and renders them as name-only
   * "Unknown profile" rows, so posts whose owning profile was deleted or left
   * scope keep their profile selectable instead of silently dropping out of the
   * filter. Derived from the unfiltered `posts` collection — matching the
   * Channels convention — so the dropdown's own selection can never shrink its
   * options and strand a persisted unknown selection.
   */
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

  /**
   * Loaded identity→profile pairs pruning can prove: the Post page plus, while
   * the month grid feeds rows, the fetched calendar events that carry `post_id`
   * and `brand_profile_id` for Posts outside the page. Events are excluded in
   * list/grid modes — they hold no live data for the Post page, so a post id
   * still cached there must not shield a deleted Post from pruning.
   */
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

  /**
   * Prunes selected ids that loaded data no longer contains, once every feeding
   * query is settled — mid-flight refetches can still list a just-deleted Post
   * or transiently omit a failed one, so nothing is dropped off a moving
   * target. Render-phase adjustment like `prevInputs`; the helper returns the
   * same map identity when nothing changed, so `setSelectedPosts` short-circuits.
   */
  const dataSettled = !postsQuery.isFetching && !calendarQuery.isFetching;
  if (selectedPosts.size > 0) {
    const pruned = prunePostSelection(selectedPosts, selectionData, {
      dataSettled,
      draftFilter: isDraftFilter,
    });
    if (pruned !== selectedPosts) setSelectedPosts(pruned);
  }

  /**
   * Refetches whichever queries feed the active mode after an error or mutation.
   */
  const refetchActive = useCallback(() => {
    const tasks: Promise<unknown>[] = [postsQuery.refetch()];
    if (isCalendarMode) tasks.push(calendarQuery.refetch());
    return Promise.all(tasks);
  }, [postsQuery, calendarQuery, isCalendarMode]);

  // Deep link: `?date=YYYY-MM-DD` opens the calendar day dialog for that date.
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

  /**
   * Requests deletion for a Post row. The contract's Post deletion soft-deletes
   * the composition and stops its pending Channels, so it is offered even for a
   * fully published Post and the confirmation states plainly that live platform
   * copies are not removed. The owning profile is captured from the row at
   * request time — never the active scope — so aggregate-view deletions resolve
   * the right profile and a scope switch while the dialog is open cannot
   * redirect the call.
   */
  const handleDeletePostAction = useCallback(
    (postId: string) => {
      const row = posts.find((r) => r.id === postId);
      if (!row || !canDeletePost(row)) return;
      setPendingAction({
        kind: "delete-post",
        postId,
        brandProfileId: row.brandProfileId,
        distributionIds: [],
      });
    },
    [posts, canDeletePost],
  );

  /**
   * Executes the confirmed destructive action: cancel only the selected pending
   * Channel outcomes, or delete the Post, then close the detail dialog if it was
   * showing that Post.
   */
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
        // Sileo toasts only expand when they carry a description: success copies
        // the affected Post's caption or the cancelled-channel count so the
        // feedback names what changed; failures reuse the shared recovery line.
        const row = posts.find((r) => r.id === action.postId);
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
  }, [pendingAction, deletePost, cancelDistribution, posts, t]);

  /**
   * Routes a dialog request into the shared confirmation: `cancel-channels` for
   * the Channels the caller selected, `delete-post` for the composition itself.
   */
  const handleModalRequestDelete = useCallback((request: PostDestructiveRequest) => {
    setPendingAction(request);
  }, []);

  /**
   * Toggles one rendered row's membership. The entry snapshots the owning
   * profile (the deletion authorization) and draft flag (the draft-filter
   * pruning escape) from the row at click time, so a later profile reassign or
   * filter change cannot silently retarget the pending deletion.
   */
  const handleTogglePostSelection = useCallback(
    (postId: string) => {
      setSelectedPosts((prev) => {
        const next = new Map(prev);
        if (next.has(postId)) {
          next.delete(postId);
        } else {
          const row = posts.find((r) => r.id === postId);
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
    [posts, postById, canDeletePost],
  );

  /**
   * Applies membership to a set of visible rows — the select-all control's
   * contract. Selecting adds only rows still resolvable in the loaded data
   * (same snapshot fields as the single toggle); deselecting removes exactly
   * the listed ids, leaving hidden-by-filter selections untouched so select-all
   * never silently clears work the user cannot see.
   */
  const handleSetPostSelection = useCallback(
    (postIds: string[], selected: boolean) => {
      setSelectedPosts((prev) => {
        const next = new Map(prev);
        const rowsById = new Map(posts.map((row) => [row.id, row]));
        for (const postId of postIds) {
          if (selected) {
            const row = rowsById.get(postId);
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
    [posts, postById, canDeletePost],
  );

  /** Clears the whole selection — the bulk bar's Deselect action. */
  const handleClearPostSelection = useCallback(() => {
    setSelectedPosts(new Map());
  }, []);

  /**
   * Opens the bulk-delete confirmation with an exact snapshot of the currently
   * selected entries. The snapshot (not the live map) is what the confirmed
   * batch deletes, so toggles made while the dialog is open never widen or
   * shrink the confirmed set.
   */
  const openBulkDelete = useCallback(() => {
    const targets = [...selectedPosts.values()].filter((entry) => {
      const row = posts.find((candidate) => candidate.id === entry.id);
      return row !== undefined && canDeletePost(row);
    });
    if (targets.length === 0) return;
    setBulkDeleteTargets(targets);
  }, [selectedPosts, posts, canDeletePost]);

  /**
   * Executes the confirmed bulk delete over the snapshot latched when the
   * dialog opened — entries added to the selection afterwards are not
   * deletable through this dialog. The batch hook issues bounded-concurrency
   * requests and invalidates the affected caches once after the batch settles,
   * instead of refetching Posts, Distributions, and Calendar after every item.
   * Successful identities leave the selection together; failures stay selected
   * for retry. The dialog stays open (and every selection control disabled)
   * until all attempts settle, then the toast reports the real counts.
   */
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

  /**
   * Opens the composer drawer for a Post that still has an editable surface: a
   * stored draft, or a Post with at least one pending Channel whose targets can
   * still be added, removed, or rescheduled. Increments the composer session key
   * so an existing composer instance resets and hydrates the selected Post
   * identity. The drawer replaces the inspection rather than navigating away.
   */
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

  /**
   * Presents the live composition when inspection interrupted it; otherwise
   * starts a fresh Post session. A background inspection never discards drafts.
   */
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

  /** Moves the query anchor by local calendar weeks, including DST and month boundaries. */
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

  const rowByPostId = useMemo(() => {
    const map = new Map<string, PostRow>();
    for (const row of posts) map.set(row.id, row);
    return map;
  }, [posts]);

  /** Selected `Post.id`s projected for the checkbox surfaces; the entry map stays the source of truth. */
  const selectedIds = useMemo(() => new Set(selectedPosts.keys()), [selectedPosts]);

  /** Post row currently shown in the inspector surface, resolved live so mutations refresh it. */
  const detailPost = detailPostId ? (rowByPostId.get(detailPostId) ?? null) : null;

  // The panel presents one surface at a time: composing and inspecting share it,
  // so a click that asks for the other swaps content in place. Handlers declared
  // below are called through closures so the descriptors stay declaration-ordered.
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

  /**
   * Post rows matching the selected calendar day, derived from the processed list
   * so the day-detail dialog always reflects active filters.
   */
  const calendarDatePosts = useMemo(() => {
    if (!selectedCalendarDate) return [];
    const targetKey = toLocalDateKey(selectedCalendarDate);
    return processedPosts.filter((r) => toLocalDateKey(r.date) === targetKey);
  }, [processedPosts, selectedCalendarDate]);

  const handleCalendarCellClick = useCallback((date: Date) => {
    setSelectedCalendarDate(date);
  }, []);

  const handleCloseCalendarDialog = useCallback(() => {
    setSelectedCalendarDate(null);
  }, []);

  /** Opens a fresh composition in the drawer, seeded with a calendar slot. */
  const handleScheduleCalendarDate = useCallback((date: Date) => {
    setDetailPostId(null);
    setSchedulingDate(date);
    setSelectedCalendarDate(null);
    setEditingPostId(undefined);
    setComposerKey((key) => key + 1);
    setComposerOpen(true);
  }, []);

  /** Uses the same calendar composer entrypoint from the selectable day-detail list. */
  const handleScheduleNewFromCalendar = useCallback(() => {
    if (selectedCalendarDate) handleScheduleCalendarDate(selectedCalendarDate);
  }, [selectedCalendarDate, handleScheduleCalendarDate]);

  /**
   * Opens the inspector surface. The panel shows one surface at a time, so an
   * in-progress composition steps aside rather than stacking a second drawer;
   * its target, session key, and recoverable draft are kept, so returning to it
   * resumes the same composition.
   */
  const handleViewDetails = useCallback((postId: string) => {
    setDetailPostId(postId);
  }, []);

  /** Closes the post detail dialog without mutating anything. */
  const handleCloseDetail = useCallback(() => {
    setDetailPostId(null);
  }, []);

  /** Builds Monday-first 35/42-day month rows, including the reference's inset adjacent dates. */
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
        posts={processedPosts}
        isLoading={isLoading}
        gridColumnClass={gridColumnClass}
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
            values={{ count: <RollingCount value={processedPosts.length} /> }}
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
      {queryError && (
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

      {/* The open panel covers the page's create action, so the drawer carries it
          in its own toolbar: an icon-only control beside the record actions, which
          leaves the breadcrumb intact. While composing, the panel is already
          creating, so the affordance steps aside. */}
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
