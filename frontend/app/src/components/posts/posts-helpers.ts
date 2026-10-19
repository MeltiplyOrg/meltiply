import type { Distribution, Post, PostAttachment, PostTarget } from "@/types";
import type { ChannelMediaItem, FilterCriteria, PostRow, PostSelectionEntry } from "./types";

/**
 * Normalizes the lifecycle status of a Post row consistently across all views and dialogs.
 *
 * Reads the row aggregate first and falls back to its first channel entry, so a
 * row always reports the same status regardless of which surface renders it.
 *
 * @param row - The Post row to inspect.
 * @returns Lowercase normalized status string (e.g. 'published', 'scheduled', 'draft', 'failed').
 */
export function normalizePostStatus(row: PostRow): string {
  return (row.status || row.channels?.[0]?.status || "").toLowerCase();
}

/**
 * Channel outcomes that still accept `cancel`/`reschedule` mutations.
 * Terminal states (published, failed, cancelled) and in-flight cancel requests are excluded
 * so action affordances only appear where the contract can honor them.
 */
const CANCELLABLE_STATUSES: Record<string, true> = {
  scheduled: true,
  queued: true,
  processing: true,
  awaiting_provider: true,
  needs_reconciliation: true,
};

/**
 * Reports whether a contract `DistributionStatus` still accepts cancel/reschedule mutations.
 * Shared by the posts view and detail modal so action affordances stay consistent.
 *
 * @param status - Raw distribution status string.
 * @returns True when the distribution is pending and can be cancelled or rescheduled.
 */
export function isCancellableStatus(status: string): boolean {
  return status in CANCELLABLE_STATUSES;
}

/**
 * Aggregates independent Channel outcomes into one worst-case display status.
 *
 * Priority order surfaces actionable states first: failures and reconciliation
 * needs outrank in-flight work, which outranks pending schedules, which outrank
 * terminal published/cancelled states. Every value comes from the channel
 * outcomes alone, so partial success still reads as the actionable failure it is
 * rather than a flattened global success flag.
 *
 * @param statuses - Status strings of the row's channel outcomes.
 * @param fallback - Status reported when the row has no channel outcome at all.
 * @returns The highest-priority status for badge display.
 */
export function summarizeChannelStatuses(statuses: string[], fallback = "draft"): string {
  const order = [
    "failed",
    "needs_reconciliation",
    "processing",
    "awaiting_provider",
    "queued",
    "scheduled",
    "cancel_requested",
    "cancelled",
    "published",
  ];
  const present = new Set(statuses);
  for (const status of order) {
    if (present.has(status)) return status;
  }
  return statuses[0] ?? fallback;
}

/**
 * Resolves the single display instant and sort key of a Post row.
 *
 * Drafts sort by creation; an active Post sorts by its earliest scheduled slot
 * so a long calendar range reads chronologically, falling back to its most
 * recent publication and finally to creation. Only the row's date changes with
 * its outcome — never its `Post.id` identity.
 *
 * @param post - Durable Post whose outcomes supply the instants.
 * @returns ISO timestamp used for row display, ordering, and day bucketing.
 */
export function resolvePostDisplayDate(post: Post): string {
  if (post.status === "draft") return post.created_at;
  let scheduled: string | null = null;
  let published: string | null = null;
  for (const distribution of post.distributions) {
    const slot = distribution.scheduled_at;
    if (slot && (scheduled === null || slot < scheduled)) scheduled = slot;
    const sent = distribution.published_at;
    if (sent && (published === null || sent > published)) published = sent;
  }
  return scheduled ?? published ?? post.created_at;
}

/**
 * Resolves the ordered media one Channel publishes, in delivered order.
 *
 * A claimed Distribution's frozen `publication.media` is authoritative, so
 * later Post edits never rewrite what a published Channel displays; a frozen
 * Asset detached from the Post keeps its slot with `attachment` undefined and
 * its frozen facts on the item. An unclaimed Channel reflects live
 * composition: `null` `attachment_ids` inherits the Post order, `[]` is
 * text-only, and a list overrides membership and order.
 *
 * @param post - Durable Post owning the ordered attachments.
 * @param target - Saved per-Channel settings, when the Post carries one.
 * @param distribution - Outcome backing the Channel; its frozen publication
 *   governs media once a Provider attempt claimed it.
 * @returns Media items in publication order; empty for text-only Channels.
 */
export function resolveChannelMedia(
  post: Post,
  target: Pick<PostTarget, "attachment_ids"> | undefined,
  distribution: Pick<Distribution, "publication"> | undefined,
): ChannelMediaItem[] {
  const publication = distribution?.publication;
  if (publication) {
    const attachmentByAssetId = new Map(post.attachments.map((a) => [a.asset_id, a]));
    return publication.media.map((frozen) => ({
      assetId: frozen.asset_id,
      assetType: frozen.asset_type,
      attachment: attachmentByAssetId.get(frozen.asset_id),
      contentType: frozen.content_type,
      durationSec: frozen.duration_sec,
      fileSize: frozen.file_size,
      height: frozen.height,
      position: frozen.position,
      width: frozen.width,
    }));
  }
  const selection = target?.attachment_ids ?? null;
  if (selection === null) {
    return post.attachments.map((attachment) => ({
      assetId: attachment.asset_id,
      assetType: attachment.asset.asset_type,
      attachment,
      position: attachment.position,
    }));
  }
  const byAssetId = new Map(post.attachments.map((a) => [a.asset_id, a]));
  const ordered: ChannelMediaItem[] = [];
  for (const [position, assetId] of selection.entries()) {
    const attachment = byAssetId.get(assetId);
    if (attachment) {
      ordered.push({
        assetId: attachment.asset_id,
        assetType: attachment.asset.asset_type,
        attachment,
        position,
      });
    }
  }
  return ordered;
}

/**
 * Resolves the caption a Channel shows in a row preview.
 *
 * A claimed Distribution's frozen `publication` is authoritative — `title`,
 * then `text` — so a published Channel keeps displaying the caption it
 * delivered after later Post or override edits. Unclaimed Channels resolve
 * `title_override` → `description_override` → the Post's `default_text`.
 *
 * @param post - Durable Post holding the default caption.
 * @param overrides - Channel entry supplying `title_override`/`description_override`.
 * @param publication - Frozen publication of the Channel's claimed attempt, when one exists.
 * @returns Caption preview text for the Channel; empty for media-only frozen publications.
 */
export function resolveChannelText(
  post: Post,
  overrides: { title_override?: string | null; description_override?: string | null },
  publication?: Distribution["publication"] | null,
): string {
  if (publication) return publication.title || publication.text;
  return overrides.title_override ?? overrides.description_override ?? post.default_text;
}

/**
 * Picks the attachment a list/grid/card preview renders: the first media item
 * of the row's first Channel that still has a live Post attachment. A claimed
 * Channel whose frozen media is no longer renderable contributes nothing —
 * but never falls back to media the Channel did not publish.
 *
 * @param row - Post row to inspect.
 * @returns Attachment to preview, or `null` when nothing renderable remains.
 */
export function resolveRowPreviewAttachment(row: PostRow): PostAttachment | null {
  for (const channel of row.channels) {
    const preview = channel.attachments.find((m) => m.attachment)?.attachment;
    if (channel.distribution?.publication) return preview ?? null;
    if (preview) return preview;
  }
  return row.post?.attachments[0] ?? null;
}

/**
 * Resolves a row's caption preview for Table, Grid, Calendar, and Details.
 *
 * A frozen publication supplies its own caption, so a published Channel
 * displays what it delivered rather than text reconstructed from the edited
 * Post; a frozen media-only publication yields no text instead of claiming the
 * Post's revised caption. Unclaimed Channels resolve their pending caption,
 * then the Post's default text or label; a calendar row whose Post is outside
 * the loaded page uses the event's `post_title`.
 *
 * @param row - Post row to inspect.
 * @returns Resolved Channel caption, else the Post's label or calendar title.
 */
export function resolveRowCaption(row: PostRow): string {
  let sawFrozenChannel = false;
  for (const channel of row.channels) {
    if (channel.distribution?.publication) {
      sawFrozenChannel = true;
      const publication = channel.distribution.publication;
      const text = publication.title || publication.text;
      if (text) return text;
    } else {
      const text = channel.content[0]?.content;
      if (text) return text;
    }
  }
  if (!sawFrozenChannel && row.post) return row.post.default_text || row.post.title;
  for (const channel of row.channels) {
    if (channel.calendarEvent?.post_title) return channel.calendarEvent.post_title;
  }
  return "";
}

/**
 * Collects the distinct Platform providers a Post row targets, from the loaded
 * workspace channel integrations with the contract platform as fallback so a
 * disconnected account still renders its provider icon.
 *
 * @param row - Post row to inspect.
 * @returns Unique provider identifiers for the row's platforms cell.
 */
export function resolveRowProviders(row: PostRow): string[] {
  const providers = new Set<string>();
  for (const channel of row.channels) {
    const provider = channel.integration?.providerIdentifier ?? channel.distribution?.platform;
    if (provider) providers.add(provider);
  }
  return [...providers];
}

/**
 * Collects every Channel entry of a Post that still accepts cancel/reschedule
 * mutations, as the Distribution ids the destructive confirmation acts on.
 *
 * @param row - Post row to inspect.
 * @returns Distribution ids of pending outcomes; empty when nothing is cancellable.
 */
export function resolveCancellableDistributionIds(row: PostRow): string[] {
  return row.channels
    .filter((c) => c.distribution && isCancellableStatus(c.distribution.status))
    .map((c) => c.distribution!.id);
}

/**
 * Converts a Date object or ISO timestamp string into a local 'YYYY-MM-DD' calendar key.
 *
 * Uses the local browser timezone rather than UTC string slicing to ensure consistent day grouping
 * and cell highlighting across positive and negative UTC offset regions.
 *
 * @param d - Date object or ISO timestamp string.
 * @returns Formatted date key in local calendar time (e.g. '2026-09-11'), or empty string on invalid date.
 *
 * @example
 * ```ts
 * toLocalDateKey(new Date(2026, 8, 11)) // '2026-09-11'
 * ```
 */
export function toLocalDateKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Outcome buckets that keep a Post under the "scheduled" toolbar filter. */
const PENDING_OUTCOMES: Record<string, true> = {
  scheduled: true,
  queued: true,
  processing: true,
  awaiting_provider: true,
  cancel_requested: true,
};

/** Outcome buckets that keep a Post under the "failed" toolbar filter. */
const FAILED_OUTCOMES: Record<string, true> = {
  failed: true,
  needs_reconciliation: true,
};

/**
 * Filters and sorts Post rows by status, selected platforms, profile, search
 * query, and date.
 *
 * Buckets other than `draft` are derived from the row's Channel outcomes, since
 * one Post can hold published, pending, and failed Channels at the same time and
 * still needs to be findable under each of them.
 *
 * @param posts - Complete list of Post rows.
 * @param filters - Active criteria; empty arrays mean all, values within a field
 * are OR-matched, and separate fields are AND-matched.
 * @returns Filtered and sorted Post rows array.
 */
export function filterAndSortPosts(posts: PostRow[], filters: FilterCriteria): PostRow[] {
  let list = [...posts];

  if (filters.statusFilter.length > 0) {
    const includeDrafts = filters.statusFilter.includes("draft");
    const includePublished = filters.statusFilter.includes("published");
    const includeScheduled = filters.statusFilter.includes("scheduled");
    const includeFailed = filters.statusFilter.includes("failed");
    list = list.filter((row) => {
      if (row.status === "draft" || row.post?.status === "draft") {
        return includeDrafts;
      }
      return row.channels.some(
        (channel) =>
          (includePublished && channel.distribution?.status === "published") ||
          (includeScheduled && PENDING_OUTCOMES[channel.status] === true) ||
          (includeFailed && FAILED_OUTCOMES[channel.status] === true),
      );
    });
  }

  if (filters.platformFilter.length > 0) {
    const platformTargets = new Set(
      filters.platformFilter.map((platform) => platform.toLowerCase()),
    );
    list = list.filter((row) =>
      row.channels.some((c) => {
        const provider = c.integration?.providerIdentifier?.toLowerCase();
        return provider ? platformTargets.has(provider) : false;
      }),
    );
  }

  if (filters.profileFilter.length > 0) {
    const profileIds = new Set(filters.profileFilter);
    list = list.filter((row) => profileIds.has(row.brandProfileId));
  }

  if (filters.searchQuery.trim()) {
    const q = filters.searchQuery.toLowerCase();
    list = list.filter((row) => {
      const content = resolveRowCaption(row).toLowerCase();
      return content.includes(q) || row.id.toLowerCase().includes(q);
    });
  }

  if (filters.dateFilter === "today") {
    const todayStr = toLocalDateKey(new Date());
    list = list.filter((row) => toLocalDateKey(row.date) === todayStr);
  } else if (filters.dateFilter === "next7") {
    const now = Date.now();
    const in7 = now + 7 * 24 * 60 * 60 * 1000;
    list = list.filter((row) => {
      const t = new Date(row.date).getTime();
      return t >= now && t <= in7;
    });
  } else if (filters.dateFilter === "past30") {
    const now = Date.now();
    const past30 = now - 30 * 24 * 60 * 60 * 1000;
    list = list.filter((row) => {
      const t = new Date(row.date).getTime();
      return t >= past30 && t <= now;
    });
  }

  list.sort((a, b) => {
    const timeA = new Date(a.date).getTime();
    const timeB = new Date(b.date).getTime();

    if (filters.sortKey === "date-asc") return timeA - timeB;
    return timeB - timeA;
  });

  return list;
}

/**
 * Drops selection entries whose Post is absent from the loaded data once that
 * data is authoritative, so a Post deleted elsewhere (or pushed out of the
 * loaded page) cannot linger in the selection and later receive a doomed
 * mutation. Two escape hatches keep pruning honest:
 *
 * - `dataSettled` is false while any feeding query is loading or refetching —
 *   mid-flight invalidation snapshots may still list a just-deleted Post or
 *   transiently omit a failed one, so nothing is pruned off a moving target.
 * - `draftFilter` narrows the Post query to drafts only, making non-draft
 *   selection unverifiable; the helper then retains entries without a loaded
 *   row (a row present as a draft stays prunable when it disappears, since
 *   under the draft filter it can only ever have been a draft).
 *
 * The union of the loaded Post page and the fetched calendar events covers
 * calendar rows whose Post fell outside the page, and refreshes each retained
 * entry's `brandProfileId` so deletion always authorizes against the latest
 * owning profile.
 *
 * @param selection - Selected entries keyed by `Post.id`.
 * @param known - Loaded Posts plus calendar events that carry
 *   `post_id`/`brand_profile_id`.
 * @param options - `dataSettled` marks loaded data authoritative;
 *   `draftFilter` marks the draft-only Post query.
 * @returns The same map when nothing changed (stable identity for state
 *   comparisons), otherwise a pruned/refreshed copy.
 */
export function prunePostSelection(
  selection: ReadonlyMap<string, PostSelectionEntry>,
  known: readonly { id: string; brandProfileId: string | null }[],
  options: { dataSettled: boolean; draftFilter: boolean },
): ReadonlyMap<string, PostSelectionEntry> {
  if (selection.size === 0 || !options.dataSettled) return selection;
  const profileById = new Map<string, string>();
  for (const item of known) {
    if (item.brandProfileId) profileById.set(item.id, item.brandProfileId);
  }
  const next = new Map<string, PostSelectionEntry>();
  for (const [id, entry] of selection) {
    const profileId = profileById.get(id);
    if (profileId) {
      next.set(id, { id, brandProfileId: profileId, isDraft: entry.isDraft });
    } else if (options.draftFilter && !entry.isDraft) {
      next.set(id, entry);
    }
  }
  if (next.size === selection.size) {
    let identical = true;
    for (const [id, entry] of next) {
      const prev = selection.get(id);
      if (!prev || prev.brandProfileId !== entry.brandProfileId) {
        identical = false;
        break;
      }
    }
    if (identical) return selection;
  }
  return next;
}
