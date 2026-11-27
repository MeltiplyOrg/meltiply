import { rejected } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import type {
  ProviderMedia,
  PublishInput,
  TikTokPublicationRequirements,
  TikTokPublishOptions,
} from "../types";
import {
  codePointLength,
  firstNonEmptyLine,
  mediaKind,
  normalizeContentType,
  required,
  secureUrl,
  validFileSize,
} from "../values";
import { isPrivacyLevel } from "./responses";

const limits = PROVIDER_LIMITS.tiktok;
const videoTypes = ["video/mp4", "video/quicktime", "video/webm"];
const imageTypes = ["image/jpeg", "image/webp"];

export interface PullMedia {
  contentType: string;
  fileSize: number;
  metadata: ProviderMedia["metadata"];
  url: string;
}

export function configuredMediaPrefix(value: string): URL {
  const url = new URL(required("mediaUrlPrefix", value, 2_048));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    !url.pathname.endsWith("/")
  ) {
    throw new TypeError("mediaUrlPrefix must be an exact HTTPS directory prefix");
  }
  return url;
}

export function pullMedia(media: ProviderMedia, mediaPrefix: URL): PullMedia {
  const url = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
  if (!url) throw rejected("tiktok_pull_media_required");
  if (url.origin !== mediaPrefix.origin || !url.pathname.startsWith(mediaPrefix.pathname)) {
    throw rejected("tiktok_media_prefix_invalid");
  }
  return {
    contentType: normalizeContentType(media.contentType),
    fileSize: media.fileSize,
    metadata: media.metadata,
    url: url.href,
  };
}

function publishOptions(input: PublishInput): TikTokPublishOptions {
  const value = input.providerOptions?.tiktok;
  if (
    !value ||
    value.musicUsageConfirmed !== true ||
    (value.postMode !== "inbox" && !isPrivacyLevel(value.privacyLevel)) ||
    (value.postMode !== undefined && value.postMode !== "direct" && value.postMode !== "inbox") ||
    [
      value.allowComment,
      value.allowDuet,
      value.allowStitch,
      value.brandContent,
      value.brandOrganic,
      value.isAiGenerated,
    ].some((choice) => typeof choice !== "boolean") ||
    (value.autoAddMusic !== undefined && typeof value.autoAddMusic !== "boolean") ||
    (value.postMode !== "inbox" && value.brandContent && value.privacyLevel === "SELF_ONLY")
  ) {
    throw rejected("tiktok_publish_options_invalid");
  }
  return value;
}

function positiveInteger(value: number | undefined, minimum: number, maximum: number): boolean {
  return value !== undefined && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function videoInvalid(media: PullMedia, maxDuration: number): boolean {
  const { durationSeconds, height, width } = media.metadata ?? {};
  return (
    !videoTypes.includes(media.contentType) ||
    !validFileSize(media.fileSize, limits.maxVideoBytes) ||
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maxDuration ||
    !positiveInteger(width, limits.minVideoDimensionPx, limits.maxVideoDimensionPx) ||
    !positiveInteger(height, limits.minVideoDimensionPx, limits.maxVideoDimensionPx)
  );
}

function photoInvalid(media: PullMedia): boolean {
  const { height, width } = media.metadata ?? {};
  return (
    !imageTypes.includes(media.contentType) ||
    !validFileSize(media.fileSize, limits.maxImageBytes) ||
    width === undefined ||
    height === undefined ||
    !positiveInteger(width, 1, Number.MAX_SAFE_INTEGER) ||
    !positiveInteger(height, 1, Number.MAX_SAFE_INTEGER) ||
    Math.min(width, height) > limits.maxPhotoShortSidePx
  );
}

export interface TikTokPublishPlan {
  choices: TikTokPublishOptions;
  first: PullMedia;
  inbox: boolean;
  isVideo: boolean;
  media: PullMedia[];
}

export function tiktokPublishPlan(input: PublishInput, mediaPrefix: URL): TikTokPublishPlan {
  if (input.hashtags.length > limits.maxHashtags) throw rejected("tiktok_hashtags_invalid");
  const media = input.media.map((attachment) => pullMedia(attachment, mediaPrefix));
  const kinds = input.media.map((attachment) => mediaKind(attachment.contentType));
  const [first] = media;
  if (!first) throw rejected("tiktok_pull_media_required");
  if (kinds.some((kind) => kind === null)) throw rejected("tiktok_asset_type_invalid");
  if (kinds.some((kind) => kind !== kinds[0])) throw rejected("tiktok_mixed_media_unsupported");
  const isVideo = kinds[0] === "video";
  const choices = publishOptions(input);
  if (isVideo && choices.autoAddMusic === true) {
    throw rejected("tiktok_auto_music_video_unsupported");
  }
  return { choices, first, inbox: choices.postMode === "inbox", isVideo, media };
}

export function creatorChoiceUnavailable(
  choices: TikTokPublishOptions,
  requirements: TikTokPublicationRequirements,
): boolean {
  return (
    !choices.privacyLevel ||
    !requirements.privacyLevels.includes(choices.privacyLevel) ||
    (choices.allowComment && !requirements.commentAllowed) ||
    (choices.allowDuet && !requirements.duetAllowed) ||
    (choices.allowStitch && !requirements.stitchAllowed)
  );
}

export function tiktokPublishRequest(
  { choices, first, inbox, isVideo, media }: TikTokPublishPlan,
  rawCaption: string,
  requirements: TikTokPublicationRequirements | undefined,
): { path: string; body: Record<string, unknown> } {
  const caption = rawCaption.trim();
  const directPost = {
    brand_content_toggle: choices.brandContent,
    brand_organic_toggle: choices.brandOrganic,
    disable_comment: !choices.allowComment,
    privacy_level: choices.privacyLevel,
  };
  if (isVideo) {
    if (
      media.length !== 1 ||
      (!inbox && codePointLength(caption) > limits.maxVideoCaptionCodePoints) ||
      videoInvalid(first, requirements?.maxVideoDurationSeconds ?? limits.maxVideoDurationSeconds)
    ) {
      throw rejected("tiktok_video_invalid");
    }
    const source_info = { source: "PULL_FROM_URL", video_url: first.url };
    return {
      path: `/v2/post/publish/${inbox ? "inbox/video" : "video"}/init/`,
      body: inbox
        ? { source_info }
        : {
            post_info: {
              ...directPost,
              disable_duet: !choices.allowDuet,
              disable_stitch: !choices.allowStitch,
              is_aigc: choices.isAiGenerated,
              title: caption,
            },
            source_info,
          },
    };
  }
  const title = firstNonEmptyLine(caption);
  if (
    !title ||
    codePointLength(title) > limits.maxPhotoTitleChars ||
    codePointLength(caption) > limits.maxCaptionCodePoints ||
    (!inbox && (choices.allowDuet || choices.allowStitch)) ||
    media.length > limits.maxPhotoImages ||
    media.some(photoInvalid)
  ) {
    throw rejected("tiktok_photo_invalid");
  }
  return {
    path: "/v2/post/publish/content/init/",
    body: {
      media_type: "PHOTO",
      is_aigc: choices.isAiGenerated,
      post_info: inbox
        ? { title, description: caption }
        : {
            ...directPost,
            auto_add_music: choices.autoAddMusic === true,
            description: caption,
            title,
          },
      post_mode: inbox ? "MEDIA_UPLOAD" : "DIRECT_POST",
      source_info: {
        photo_cover_index: 0,
        photo_images: media.map((attachment) => attachment.url),
        source: "PULL_FROM_URL",
      },
    },
  };
}
