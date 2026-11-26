import { rejected } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import type { ProviderMedia, PublishInput } from "../types";
import { codePointLength, normalizeContentType, secureUrl, validFileSize } from "../values";
import { parseThreadsOptions, threadsOptionsIssue, type ThreadsPublishOptions } from "./options";

const limits = PROVIDER_LIMITS.threads;
export const imageTypes = ["image/jpeg", "image/png"];
export const videoTypes = ["video/mp4", "video/quicktime"];

export interface ThreadsAttachment {
  kind: "image" | "video";
  url: string;
}

export function threadsAttachment(media: ProviderMedia): ThreadsAttachment {
  if (media.mode !== "remote_ingest") throw rejected("threads_remote_media_required");
  const url = secureUrl(media.url)?.href;
  if (!url) throw rejected("threads_media_url_invalid");
  const contentType = normalizeContentType(media.contentType);
  const kind = imageTypes.includes(contentType)
    ? "image"
    : videoTypes.includes(contentType)
      ? "video"
      : undefined;
  if (
    !kind ||
    !validFileSize(media.fileSize, kind === "image" ? limits.maxImageBytes : limits.maxVideoBytes)
  ) {
    throw rejected("threads_media_invalid");
  }
  return { kind, url };
}

export function threadsMediaParameters(item: ThreadsAttachment): Record<string, string> {
  return item.kind === "image"
    ? { media_type: "IMAGE", image_url: item.url }
    : { media_type: "VIDEO", video_url: item.url };
}

export function threadsTextParameters(
  text: string,
  options: ThreadsPublishOptions,
): URLSearchParams {
  if (!text && !options.gif_attachment && !options.text_attachment) {
    throw rejected("threads_text_invalid");
  }
  return new URLSearchParams({ ...(text ? { text } : {}), media_type: "TEXT" });
}

export function threadsPublishPlan(input: PublishInput): {
  attachments: ThreadsAttachment[];
  options: ThreadsPublishOptions;
  text: string;
} {
  if (input.media.length > limits.maxCarouselItems) throw rejected("threads_carousel_too_large");
  const attachments = input.media.map(threadsAttachment);
  const text = input.caption.trim();
  if (codePointLength(text) > limits.maxCaptionCodePoints)
    throw rejected("threads_content_invalid");
  const options = parseThreadsOptions(input.providerOptions?.threads ?? {});
  if (!options || threadsOptionsIssue(options, text, attachments.length)) {
    throw rejected("threads_publish_options_invalid");
  }
  return { attachments, options, text };
}

export function threadsPublishWarnings(
  body: Record<string, unknown>,
): ["instagram_crossshare_failed"] | undefined {
  return body.crossreshare_to_ig_status === "FAILED" ? ["instagram_crossshare_failed"] : undefined;
}
