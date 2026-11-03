import type { PlatformCapability, ValidationIssue } from "@meltiply/contracts";

import { resolveInstagramOptions } from "./instagram-options";
import { resolveFacebookPostType } from "./facebook-options";
import { parseThreadsOptions, threadsOptionsIssue } from "./threads-options";
import type { PublishInput } from "./types";

export type { ValidationIssue } from "@meltiply/contracts";

/**
 * Counts Unicode codepoints in a post caption using character iteration.
 * Accurately measures multi-byte UTF-16 surrogate pairs and emoji sequences to enforce provider limits.
 * Returns the non-negative integer count of Unicode codepoints in text.
 */
export function captionLength(text: string): number {
  return [...text].length;
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
 * Composes the normalized caption sent to a provider from Post title/body, the
 * target's overrides, the resolved signature snapshot, and hashtags.
 * Deduplicates title and body when identical, appends the signature as its own
 * paragraph, and appends space-separated hashtags. Pure function reused across
 * pre-flight validation and publishing to guarantee character count parity.
 * @param source - Post title/default text, optional target overrides, signature, and hashtags.
 * @returns The formatted multi-line caption string, empty when nothing is set.
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

/**
 * Maps a normalized MIME type to the attachable media kind it belongs to.
 * The top-level `image/` and `video/` prefixes are the whole mapping: an
 * unrecognized prefix yields null so the caller reports an unsupported media
 * type instead of guessing a kind.
 */
function mediaKind(contentType: string): "image" | "video" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return null;
}

/**
 * Evaluates one ordered attachment against the platform capability.
 * Validates the MIME type, that its kind is attachable, the file size bound,
 * and — for video — the duration ceiling; an unknown video duration is an
 * issue because it cannot be shown to fit.
 * @param capability - Target platform capability authority.
 * @param input - Publish input owning the ordered attachment array.
 * @param index - Attachment position, used for actionable field names.
 * @returns Issues for this attachment only; empty when it is fully acceptable.
 */
function attachmentIssues(
  capability: PlatformCapability,
  input: PublishInput,
  index: number,
): ValidationIssue[] {
  const media = input.media[index]!;
  const field = `media[${index}]`;
  const contentType = media.contentType.split(";", 1)[0]!.trim().toLowerCase();
  const kind = mediaKind(contentType);
  const issues: ValidationIssue[] = [];

  if (
    !contentType ||
    !capability.accepted_mime_types.map((value) => value.toLowerCase()).includes(contentType)
  ) {
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
    // An unknown duration cannot be shown to fit, so it fails the duration
    // constraint rather than passing unchecked.
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

/**
 * Evaluates the ordered attachment set against the capability's attachment
 * count and combination rules.
 * Enforces the platform minimum (so a media-required platform rejects a
 * text-only attempt), the maximum, and that every attachment of a
 * multi-attachment publication is a kind the platform combines.
 * @param capability - Target platform capability authority.
 * @param input - Publish input owning the ordered attachment array.
 * @returns Count and combination issues; empty when the set shape is accepted.
 */
function attachmentSetIssues(
  capability: PlatformCapability,
  input: PublishInput,
): ValidationIssue[] {
  const count = input.media.length;
  const issues: ValidationIssue[] = [];
  // null means the capability carries no usable bound, which only happens for
  // unconfigured adapters that cannot publish at all.
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
    // null and [] both mean the platform publishes no multi-attachment
    // composition, so either way a set of two or more is rejected here.
    const combined = capability.multi_asset_types ?? [];
    const unsupported =
      combined.length === 0 ||
      input.media.some((media) => {
        const kind = mediaKind(media.contentType.split(";", 1)[0]!.trim().toLowerCase());
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
 * @param capability - Target platform capability authority.
 * @param input - Composed caption plus the Post's ordered attachments.
 * @returns Issues in field order: attachments, then text, then provider options.
 * Empty when the payload is publishable for this target.
 */
export function validatePublishInput(
  capability: PlatformCapability,
  input: PublishInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...attachmentSetIssues(capability, input),
    ...input.media.flatMap((_, index) => attachmentIssues(capability, input, index)),
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
      ? Math.min(capability.max_caption_length ?? 2_200, 2_200)
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
    for (let index = 0; index < input.media.length; index += 1) {
      const media = input.media[index]!;
      const kind = mediaKind(media.contentType);
      if (kind === "image" && media.fileSize > 10_000_000) {
        issues.push({
          constraint: "provider_file_size_limit",
          field: `media[${index}].fileSize`,
          actual: media.fileSize,
          limit: 10_000_000,
          message: "Facebook photos cannot exceed 10 MB.",
        });
      }
      if (kind === "video" && (method === "reel" || method === "story")) {
        const duration = media.metadata?.durationSeconds;
        const maximum = method === "story" ? 60 : 90;
        if (
          duration === undefined ||
          !Number.isFinite(duration) ||
          duration < 3 ||
          duration > maximum
        ) {
          issues.push({
            constraint: "provider_video_duration_limit",
            field: "providerOptions.facebook.postType",
            ...(duration !== undefined ? { actual: duration } : {}),
            limit: maximum,
            message: `Facebook ${method} videos require a duration from 3 to ${maximum} seconds.`,
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
    const method =
      input.providerOptions?.instagram?.postType ??
      (input.media.length === 1 && mediaKind(input.media[0]!.contentType) === "video"
        ? "reel"
        : "feed");
    for (let index = 0; index < input.media.length; index += 1) {
      const item = input.media[index]!;
      const kind = mediaKind(item.contentType);
      const maximum =
        kind === "image"
          ? 8 * 1024 * 1024
          : method === "story"
            ? 100_000_000
            : method === "reel"
              ? 300_000_000
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
        const limit = method === "story" ? 60 : 900;
        if (
          duration === undefined ||
          duration < 3 ||
          duration > limit ||
          !Number.isFinite(duration)
        ) {
          issues.push({
            constraint: "provider_video_duration_limit",
            field: "providerOptions.instagram.postType",
            ...(duration !== undefined ? { actual: duration } : {}),
            limit,
            message: `Instagram ${method} requires video from 3 to ${limit} seconds.`,
          });
        }
      }
    }
    const options = input.providerOptions?.instagram;
    if (options) {
      const kinds = input.media.map((media) =>
        mediaKind(media.contentType.split(";", 1)[0]!.trim().toLowerCase()),
      );
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
