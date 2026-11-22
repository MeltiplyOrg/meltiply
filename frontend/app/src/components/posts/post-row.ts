import type { ChannelIntegration, MediaItem } from "@/api/types";
import type { CalendarEvent, Distribution, Post, PostTarget } from "@/types";
import { summarizePublicationStatuses } from "@/lib/publication-status";
import type { ChannelMediaItem, PostDetailItem, PostRow } from "./types";
import { calendarDateKey } from "./calendar-dates";
import { resolveChannelMedia, resolveChannelText, resolvePostDisplayDate } from "./posts-helpers";

type IntegrationById = Map<string, ChannelIntegration>;
function distributionDate(d: Distribution): string {
  return d.scheduled_at ?? d.published_at ?? d.created_at;
}

function toPreviewImages(media: ChannelMediaItem[]): MediaItem[] {
  const images: MediaItem[] = [];
  for (const item of media) {
    const path = item.attachment?.asset.thumbnail_url ?? item.attachment?.asset.download_url;
    if (path) images.push({ id: item.assetId, path });
  }
  return images;
}

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

export function toPostRow(post: Post, integrationById: IntegrationById): PostRow {
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
    status:
      post.status === "draft"
        ? "draft"
        : summarizePublicationStatuses(
            channels.filter((c) => c.distribution !== undefined).map((c) => c.status),
            "scheduled",
          ),
    channels,
    brandProfileId: post.brand_profile_id,
    post,
  };
}

function calendarEventDate(e: CalendarEvent): string {
  return e.scheduled_at ?? e.published_at ?? e.updated_at;
}

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

export function toCalendarRows(
  events: CalendarEvent[],
  postById: Map<string, Post>,
  integrationById: IntegrationById,
  timeZone: string,
): PostRow[] {
  const rows = new Map<string, PostRow>();
  for (const event of events) {
    const date = calendarEventDate(event);
    const dayKey = calendarDateKey(date, timeZone);
    if (rows.has(`${event.post_id}::${dayKey}`)) continue;
    const post = postById.get(event.post_id);
    rows.set(`${event.post_id}::${dayKey}`, {
      ...(post ? toPostRow(post, integrationById) : toEventRow(event, integrationById)),
      date,
    });
  }
  return [...rows.values()];
}
