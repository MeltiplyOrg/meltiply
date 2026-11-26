import type { PlatformCapability, ValidationIssue } from "@meltiply/contracts";

import { resolveFacebookPostType } from "./facebook/options";
import { resolveInstagramOptions } from "./instagram/options";
import { PROVIDER_LIMITS } from "./limits";
import { parseThreadsOptions, threadsOptionsIssue } from "./threads/options";
import type { PublishInput } from "./types";
import { codePointLength, mediaKind, normalizeContentType } from "./values";

export type { ValidationIssue } from "@meltiply/contracts";

/** Counts Unicode codepoints in a post caption without allocating an intermediate array. */
export function captionLength(text: string): number {
  return codePointLength(text);
}

/**
 * Post and per-target content a caption is composed from. `descriptionOverride`
 * is a target's saved body override and wins over the Post's `defaultText`, so
 * one Post can carry channel-specific captions without a second identity.
 */
export interface CaptionSource {
  defaultText: string | null;
  descriptionOverride: string | null;
  hashtags: readonly string[];
  signature?: string | null;
  title: string;
  titleOverride: string | null;
}

/**
 * Composes the normalized caption sent to a provider from Post title/body,
 * target overrides, signature snapshot, and hashtags.
 */
export function composeCaption(source: CaptionSource): string {
  const title = (source.titleOverride ?? source.title).trim();
  const body = (source.descriptionOverride ?? source.defaultText ?? "").trim();
  const signature = (source.signature ?? "").trim();
  const content = [title, body, signature]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n\n");
  const tags = source.hashtags.map((tag) => `#${tag}`).join(" ");
  return [content, tags].filter(Boolean).join("\n\n");
}

function attachmentIssues(
  capability: PlatformCapability,
  acceptedMimeTypes: ReadonlySet<string>,
  media: PublishInput["media"][number],
  index: number,
): ValidationIssue[] {
  const field = `media[${index}]`;
  const contentType = normalizeContentType(media.contentType);
  const kind = mediaKind(contentType);
  const issues: ValidationIssue[] = [];

  if (!contentType || !acceptedMimeTypes.has(contentType)) {
    issues.push({
      constraint: "unsupported_media_type",
      field: `${field}.contentType`,
      message: `${capability.platform} does not accept media type '${media.contentType}'`,
    });
  }
  if (kind !== null && !capability.asset_types.includes(kind)) {
    issues.push({
      constraint: "unsupported_asset_type",
      field: `${field}.contentType`,
      message: `${capability.platform} does not accept ${kind} media`,
    });
  }

  if (!Number.isSafeInteger(media.fileSize) || media.fileSize < 1) {
    issues.push({
      actual: media.fileSize,
      constraint: "provider_file_size_limit",
      field: `${field}.fileSize`,
      message: "media file size must be a positive safe integer",
    });
  } else if (capability.max_file_size !== null && media.fileSize > capability.max_file_size) {
    issues.push({
      actual: media.fileSize,
      constraint: "provider_file_size_limit",
      field: `${field}.fileSize`,
      limit: capability.max_file_size,
      message: `attachment ${index + 1} exceeds the ${capability.platform} limit of ${capability.max_file_size} bytes`,
    });
  }

  const durationLimit = capability.max_video_duration_sec;
  if (kind === "video" && durationLimit !== null) {
    const duration = media.metadata?.durationSeconds;
    if (duration === undefined) {
      issues.push({
        constraint: "provider_video_duration_limit",
        field: `${field}.metadata.durationSeconds`,
        limit: durationLimit,
        message: `${capability.platform} needs a known video duration to enforce its ${durationLimit} second limit`,
      });
    } else if (duration > durationLimit) {
      issues.push({
        actual: duration,
        constraint: "provider_video_duration_limit",
        field: `${field}.metadata.durationSeconds`,
        limit: durationLimit,
        message: `attachment ${index + 1} exceeds the ${capability.platform} limit of ${durationLimit} seconds`,
      });
    }
  }

  return issues;
}

function attachmentSetIssues(
  capability: PlatformCapability,
  input: PublishInput,
): ValidationIssue[] {
  const count = input.media.length;
  const issues: ValidationIssue[] = [];
  const minimum =
    capability.platform === "youtube" && input.providerOptions?.youtube?.postType === "live"
      ? 0
      : (capability.min_media_count ?? 0);

  if (count === 0 && minimum > 0) {
    issues.push({
      constraint: "provider_media_required",
      field: "media",
      limit: minimum,
      message: `${capability.platform} requires at least ${minimum} attachment${minimum === 1 ? "" : "s"}; remove the caption-only target or add media`,
    });
  }
  if (capability.max_media_count !== null && count > capability.max_media_count) {
    issues.push({
      actual: count,
      constraint: "provider_media_count_limit",
      field: "media",
      limit: capability.max_media_count,
      message: `${capability.platform} accepts at most ${capability.max_media_count} attachment${capability.max_media_count === 1 ? "" : "s"}; remove ${count - capability.max_media_count} for this target`,
    });
  }
  if (count > 1) {
    const combined = capability.multi_asset_types ?? [];
    const unsupported =
      combined.length === 0 ||
      input.media.some((media) => {
        const kind = mediaKind(normalizeContentType(media.contentType));
        return kind === null || !combined.includes(kind);
      });
    if (unsupported) {
      issues.push({
        constraint: "unsupported_media_combination",
        field: "media",
        message:
          combined.length === 0
            ? `${capability.platform} cannot publish more than one attachment per post`
            : `${capability.platform} cannot combine these attachments; a multi-attachment post accepts ${combined.join(" or ")} media only`,
      });
    }
  }

  return issues;
}

/**
 * Checks a publish payload against platform capabilities and returns every unmet constraint.
 * Pure: no I/O, no provider calls, and no mutation; runs identically in API checks, queue jobs, and UI preview.
 * Validates the ordered attachment set (count bounds, combination rules, per-attachment
 * MIME type, kind, file size, and video duration), codepoint caption length, hashtag
 * count, an empty-publication guard, and provider-option platform compatibility.
 */
export function validatePublishInput(
  capability: PlatformCapability,
  input: PublishInput,
): ValidationIssue[] {
  const acceptedMimeTypes = new Set(
    capability.accepted_mime_types.map((value) => value.toLowerCase()),
  );
  const issues: ValidationIssue[] = [
    ...attachmentSetIssues(capability, input),
    ...input.media.flatMap((media, index) =>
      attachmentIssues(capability, acceptedMimeTypes, media, index),
    ),
  ];

  const story =
    (capability.platform === "instagram" &&
      input.providerOptions?.instagram?.postType === "story") ||
    (capability.platform === "facebook" && input.providerOptions?.facebook?.postType === "story");
  if (story && (input.caption.trim() || input.hashtags.length)) {
    issues.push({
      constraint: "story_caption_unsupported",
      field: "caption",
      message:
        "Stories do not accept captions or signatures; remove this Channel's text before publishing.",
    });
  }
  const facebook = input.providerOptions?.facebook;
  const externalContent =
    (capability.platform === "facebook" &&
      (facebook?.link || ["crosspost", "ab_test", "live"].includes(facebook?.postType ?? ""))) ||
    (capability.platform === "youtube" && input.providerOptions?.youtube?.postType === "live") ||
    (capability.platform === "threads" &&
      !!(
        input.providerOptions?.threads?.repost_id ||
        input.providerOptions?.threads?.gif_attachment?.gif_id ||
        input.providerOptions?.threads?.text_attachment?.plaintext
      ));
  if (
    input.media.length === 0 &&
    !input.caption.trim() &&
    input.hashtags.length === 0 &&
    !externalContent
  ) {
    issues.push({
      constraint: "provider_empty_publish",
      field: "caption",
      message: `${capability.platform} cannot publish an empty post; add caption text, hashtags, or an attachment`,
    });
  }

  const maximumCaption =
    capability.platform === "tiktok" &&
    input.providerOptions?.tiktok?.postMode !== "inbox" &&
    input.media.some((media) => mediaKind(media.contentType) === "video")
      ? Math.min(
          capability.max_caption_length ?? PROVIDER_LIMITS.tiktok.maxVideoCaptionCodePoints,
          PROVIDER_LIMITS.tiktok.maxVideoCaptionCodePoints,
        )
      : capability.max_caption_length;
  if (maximumCaption !== null) {
    const length = captionLength(input.caption);
    if (length > maximumCaption) {
      issues.push({
        actual: length,
        constraint: "provider_caption_limit",
        field: "caption",
        limit: maximumCaption,
        message: `caption exceeds the ${capability.platform} limit of ${maximumCaption} characters`,
      });
    }
  }

  if (capability.max_hashtags !== null && input.hashtags.length > capability.max_hashtags) {
    issues.push({
      actual: input.hashtags.length,
      constraint: "provider_hashtag_limit",
      field: "hashtags",
      limit: capability.max_hashtags,
      message: `${capability.platform} accepts at most ${capability.max_hashtags} hashtags`,
    });
  }

  if (capability.platform === "tiktok" && !input.providerOptions?.tiktok) {
    issues.push({
      constraint: "tiktok_publish_options_required",
      field: "providerOptions.tiktok",
      message: "TikTok requires creator publish options on every publish",
    });
  }

  if (capability.platform !== "youtube" && input.providerOptions?.youtube) {
    issues.push({
      constraint: "unsupported_provider_options",
      field: "providerOptions.youtube",
      message: `${capability.platform} does not accept YouTube publish options`,
    });
  }

  if (capability.platform !== "tiktok" && input.providerOptions?.tiktok) {
    issues.push({
      constraint: "unsupported_provider_options",
      field: "providerOptions.tiktok",
      message: `${capability.platform} does not accept TikTok publish options`,
    });
  }

  if (capability.platform !== "instagram" && input.providerOptions?.instagram) {
    issues.push({
      constraint: "unsupported_provider_options",
      field: "providerOptions.instagram",
      message: `${capability.platform} does not accept Instagram publish options`,
    });
  }

  if (capability.platform !== "facebook" && facebook) {
    issues.push({
      constraint: "unsupported_provider_options",
      field: "providerOptions.facebook",
      message: `${capability.platform} does not accept Facebook publish options`,
    });
  }
  if (capability.platform === "facebook") {
    const method = resolveFacebookPostType(
      facebook,
      input.media.map((media) => mediaKind(media.contentType)),
    );
    if (!method) {
      issues.push({
        constraint: "facebook_post_options_invalid",
        field: "providerOptions.facebook",
        message: "The selected Facebook method does not apply to this content.",
      });
    }
    const {
      maxImageBytes,
      maxReelDurationSeconds,
      maxStoryDurationSeconds,
      minReelStoryDurationSeconds,
    } = PROVIDER_LIMITS.facebook;
    for (const [index, media] of input.media.entries()) {
      const kind = mediaKind(media.contentType);
      if (kind === "image" && media.fileSize > maxImageBytes) {
        issues.push({
          constraint: "provider_file_size_limit",
          field: `media[${index}].fileSize`,
          actual: media.fileSize,
          limit: maxImageBytes,
          message: "Facebook photos cannot exceed 10 MB.",
        });
      }
      if (kind === "video" && (method === "reel" || method === "story")) {
        const duration = media.metadata?.durationSeconds;
        const maximum = method === "story" ? maxStoryDurationSeconds : maxReelDurationSeconds;
        if (
          duration === undefined ||
          !Number.isFinite(duration) ||
          duration < minReelStoryDurationSeconds ||
          duration > maximum
        ) {
          issues.push({
            constraint: "provider_video_duration_limit",
            field: "providerOptions.facebook.postType",
            ...(duration !== undefined ? { actual: duration } : {}),
            limit: maximum,
            message: `Facebook ${method} videos require a duration from ${minReelStoryDurationSeconds} to ${maximum} seconds.`,
          });
        }
      }
    }
  }

  if (input.providerOptions?.threads) {
    const options = parseThreadsOptions(input.providerOptions.threads);
    const message =
      capability.platform !== "threads"
        ? "Threads options require a Threads Channel."
        : !options
          ? "Threads options are invalid."
          : threadsOptionsIssue(options, input.caption, input.media.length);
    if (message)
      issues.push({
        constraint: "threads_post_options_invalid",
        field: "providerOptions.threads",
        message,
      });
  }
  if (capability.platform === "instagram") {
    const [firstMedia] = input.media;
    const method =
      input.providerOptions?.instagram?.postType ??
      (input.media.length === 1 && firstMedia && mediaKind(firstMedia.contentType) === "video"
        ? "reel"
        : "feed");
    const {
      maxImageBytes,
      maxReelBytes,
      maxReelDurationSeconds,
      maxStoryBytes,
      maxStoryDurationSeconds,
      minReelStoryDurationSeconds,
    } = PROVIDER_LIMITS.instagram;
    for (const item of input.media) {
      const kind = mediaKind(item.contentType);
      const maximum =
        kind === "image"
          ? maxImageBytes
          : method === "story"
            ? maxStoryBytes
            : method === "reel"
              ? maxReelBytes
              : null;
      if (maximum !== null && item.fileSize > maximum) {
        issues.push({
          constraint: "provider_file_size_limit",
          field: "providerOptions.instagram.postType",
          actual: item.fileSize,
          limit: maximum,
          message: "The Asset exceeds this Instagram method's size limit.",
        });
      }
      if (kind === "video" && (method === "story" || method === "reel")) {
        const duration = item.metadata?.durationSeconds;
        const limit = method === "story" ? maxStoryDurationSeconds : maxReelDurationSeconds;
        if (
          duration === undefined ||
          duration < minReelStoryDurationSeconds ||
          duration > limit ||
          !Number.isFinite(duration)
        ) {
          issues.push({
            constraint: "provider_video_duration_limit",
            field: "providerOptions.instagram.postType",
            ...(duration !== undefined ? { actual: duration } : {}),
            limit,
            message: `Instagram ${method} requires video from ${minReelStoryDurationSeconds} to ${limit} seconds.`,
          });
        }
      }
    }
    const options = input.providerOptions?.instagram;
    if (options) {
      const kinds = input.media.map((media) => mediaKind(normalizeContentType(media.contentType)));
      if (!resolveInstagramOptions(options, kinds)) {
        issues.push({
          constraint: "instagram_post_options_invalid",
          field: "providerOptions.instagram",
          message:
            "The selected Instagram post type or trial Reel does not apply to this attachment set",
        });
      }
    }
  }

  return issues;
}
