import type { ChannelIntegration, MediaItem } from "@/api/types";
import type { Distribution, Post, PostTarget } from "@/types";
import type { ChannelMediaItem, PostDetailItem, PostRow } from "./types";
import {
  resolveChannelMedia,
  resolveChannelText,
  resolvePostDisplayDate,
  summarizeChannelStatuses,
} from "./posts-helpers";

type IntegrationById = Map<string, ChannelIntegration>;
/**
 * Resolves the display instant for a distribution: the scheduled slot when set,
 * otherwise the actual publish time, otherwise creation time.
 */
function distributionDate(d: Distribution): string {
  return d.scheduled_at ?? d.published_at ?? d.created_at;
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
