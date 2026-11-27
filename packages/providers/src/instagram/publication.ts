import { rejected } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import type { ProviderMedia, PublishInput } from "../types";
import {
  codePointLength,
  mediaKind,
  normalizeContentType,
  secureUrl,
  validFileSize,
} from "../values";
import {
  defaultInstagramPostType,
  resolveInstagramOptions,
  type ResolvedInstagramOptions,
} from "./options";

const limits = PROVIDER_LIMITS.instagram;
export const videoTypes = ["video/mp4", "video/quicktime"];

export interface InstagramAttachment {
  kind: "image" | "video";
  url: string;
}

export function instagramAttachment(media: ProviderMedia, postType: string): InstagramAttachment {
  if (media.mode !== "remote_ingest") throw rejected("instagram_remote_media_required");
  const url = secureUrl(media.url)?.href;
  const contentType = normalizeContentType(media.contentType);
  const maximumVideoBytes =
    postType === "story"
      ? limits.maxStoryBytes
      : postType === "reel"
        ? limits.maxReelBytes
        : limits.maxVideoBytes;
  const kind = videoTypes.includes(contentType)
    ? "video"
    : contentType === "image/jpeg"
      ? "image"
      : undefined;
  if (
    !url ||
    !kind ||
    !validFileSize(media.fileSize, kind === "video" ? maximumVideoBytes : limits.maxImageBytes)
  ) {
    throw rejected("instagram_media_invalid");
  }
  return { kind, url };
}

export function instagramPublishPlan(input: PublishInput): {
  attachments: InstagramAttachment[];
  options: ResolvedInstagramOptions;
  text: string;
} {
  if (input.media.length === 0) throw rejected("instagram_media_required");
  if (input.media.length > limits.maxCarouselItems) throw rejected("instagram_carousel_too_large");
  const requestedPostType =
    input.providerOptions?.instagram?.postType ??
    defaultInstagramPostType(input.media.map((media) => mediaKind(media.contentType)));
  const attachments = input.media.map((media) => instagramAttachment(media, requestedPostType));
  const text = input.caption.trim();
  if (
    codePointLength(text) > limits.maxCaptionCodePoints ||
    input.hashtags.length > limits.maxHashtags
  ) {
    throw rejected("instagram_content_invalid");
  }
  const options = resolveInstagramOptions(
    input.providerOptions?.instagram,
    attachments.map((item) => item.kind),
  );
  if (!options) throw rejected("instagram_post_options_invalid");
  if (options.postType === "story" && (text || input.hashtags.length)) {
    throw rejected("instagram_story_caption_unsupported");
  }
  return { attachments, options, text };
}

export function carouselItemParameters(item: InstagramAttachment): URLSearchParams {
  return new URLSearchParams(
    item.kind === "image"
      ? { is_carousel_item: "true", image_url: item.url }
      : { is_carousel_item: "true", media_type: "VIDEO", video_url: item.url },
  );
}

export function singleParameters(
  item: InstagramAttachment,
  text: string,
  options: ResolvedInstagramOptions,
): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text && options.postType !== "story") parameters.set("caption", text);
  parameters.set(item.kind === "image" ? "image_url" : "video_url", item.url);
  if (options.postType === "story") {
    parameters.set("media_type", "STORIES");
  } else if (item.kind === "video" && options.postType === "feed") {
    parameters.set("media_type", "VIDEO");
  } else if (item.kind === "video") {
    parameters.set("media_type", "REELS");
    parameters.set("share_to_feed", "true");
    if (options.trialReel) {
      parameters.set(
        "trial_params",
        JSON.stringify({
          graduation_strategy:
            options.trialGraduation === "performance" ? "SS_PERFORMANCE" : "MANUAL",
        }),
      );
    }
  }
  return parameters;
}

const partialConfigIssues = new Set(["CAPTION_NOT_ATTACHED", "USER_TAGGING_FAILURE"]);
const partialAddOnStatuses = new Set(["POLL_CREATION_FAILURE", "PROMPT_CREATION_FAILURE"]);

export function instagramPublishWarnings(
  body: Record<string, unknown>,
): ["instagram_publish_partial"] | undefined {
  return partialConfigIssues.has(String(body.config_issue)) ||
    partialAddOnStatuses.has(String(body.caption_add_on_attachment_status))
    ? ["instagram_publish_partial"]
    : undefined;
}
