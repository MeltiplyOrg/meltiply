import type { Language } from "@/lib/i18n";
import { platformDisplayName } from "@/lib/platforms";
import {
  isCancellablePublicationStatus,
  publicationStatusFilterBucket,
  resolvePublicationStatus,
  type PublicationStatus,
} from "@/lib/publication-status";
import type { Distribution, Platform, Post, PostAttachment, PostTarget } from "@/types";
import type { ChannelMediaItem, FilterCriteria, PostRow, PostSelectionEntry } from "./types";

export function normalizePostStatus(row: PostRow): PublicationStatus {
  return resolvePublicationStatus(row.status || row.channels?.[0]?.status);
}

const POST_ANALYTICS_COUNTERS = [
  "likes",
  "comments",
  "shares",
  "saves",
  "clicks",
  "views",
  "impressions",
  "reach",
] as const satisfies readonly (keyof NonNullable<Post["analytics"]>)[];

interface PostAnalyticsMetric {
  id: keyof NonNullable<Post["analytics"]>;
  value: number;
}

interface PostChannelAnalytics {
  id: string;
  platform: Platform;
  label: string;
  analytics: NonNullable<Post["analytics"]>;
}

export interface PostAnalyticsSummary {
  visible: boolean;
  awaiting: boolean;
  metrics: readonly PostAnalyticsMetric[];
  channels: readonly PostChannelAnalytics[];
  untracked: readonly PostAnalyticsMetric["id"][];
}

export function resolvePostAnalytics(row: PostRow): PostAnalyticsSummary {
  const visible =
    Boolean(row.post) && row.channels.some((channel) => channel.status === "published");
  const analytics = row.post?.analytics ?? null;
  const metrics: PostAnalyticsMetric[] = [];
  const untracked: PostAnalyticsMetric["id"][] = [];
  for (const id of POST_ANALYTICS_COUNTERS) {
    const value = analytics?.[id] ?? null;
    if (value === null) untracked.push(id);
    else metrics.push({ id, value });
  }
  const channels: PostChannelAnalytics[] = (row.post?.distribution_analytics ?? []).map((item) => {
    const outcome = row.channels.find(
      (channel) => channel.distribution?.id === item.distribution_id,
    );
    return {
      id: item.distribution_id,
      platform: item.platform,
      label: outcome?.integration?.name ?? platformDisplayName(item.platform),
      analytics: item.analytics,
    };
  });
  return {
    awaiting: visible && metrics.length === 0,
    channels,
    metrics,
    untracked,
    visible,
  };
}

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

export function resolveChannelText(
  post: Post,
  overrides: { title_override?: string | null; description_override?: string | null },
  publication?: Distribution["publication"] | null,
): string {
  if (publication) return publication.title || publication.text;
  return overrides.title_override ?? overrides.description_override ?? post.default_text;
}

export function resolveRowPreviewAttachment(row: PostRow): PostAttachment | null {
  for (const channel of row.channels) {
    const preview = channel.attachments.find((m) => m.attachment)?.attachment;
    if (channel.distribution?.publication) return preview ?? null;
    if (preview) return preview;
  }
  return row.post?.attachments[0] ?? null;
}

export function formatPostDate(
  value: string | null | undefined,
  timeZone: string,
  language: Language,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleString(language, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone,
  });
}

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

export function resolveRowProviders(row: PostRow): string[] {
  const providers = new Set<string>();
  for (const channel of row.channels) {
    const provider = channel.integration?.providerIdentifier ?? channel.distribution?.platform;
    if (provider) providers.add(provider);
  }
  return [...providers];
}

export function resolveCancellableDistributionIds(row: PostRow): string[] {
  return row.channels
    .filter((c) => c.distribution && isCancellablePublicationStatus(c.distribution.status))
    .map((c) => c.distribution!.id);
}

export function toLocalDateKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function filterAndSortPosts(posts: PostRow[], filters: FilterCriteria): PostRow[] {
  let list = [...posts];

  if (filters.statusFilter.length > 0) {
    const statuses = new Set(filters.statusFilter);
    list = list.filter((row) => {
      if (row.status === "draft" || row.post?.status === "draft") {
        return statuses.has("draft");
      }
      return row.channels.some((channel) => {
        const bucket = publicationStatusFilterBucket(channel.status);
        return bucket !== null && statuses.has(bucket);
      });
    });
  }

  if (filters.platformFilter.length > 0) {
    const platformTargets = new Set(
      filters.platformFilter.map((platform) => platform.toLowerCase()),
    );
    list = list.filter((row) =>
      row.channels.some((c) => {
        const provider = c.integration?.providerIdentifier ?? c.distribution?.platform;
        return provider ? platformTargets.has(provider.toLowerCase()) : false;
      }),
    );
  }

  if (filters.profileFilter.length > 0) {
    const profileIds = new Set(filters.profileFilter);
    list = list.filter((row) => profileIds.has(row.brandProfileId));
  }

  const q = filters.searchQuery.trim().toLowerCase();
  if (q) {
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
