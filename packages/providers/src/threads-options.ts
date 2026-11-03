import type { components } from "@meltiply/contracts/schema";
import { secureUrl } from "./meta-common";

/** Provider-native container options share the public contract rather than duplicating a large wire model. */
export type ThreadsPublishOptions = components["schemas"]["ThreadsPublishOptions"];
export type ThreadsPostOptions = components["schemas"]["ThreadsPostOptions"];

const stringLimits = new Map([
  ["repost_id", 200],
  ["quote_post_id", 200],
  ["reply_to_id", 200],
  ["link_attachment", 2048],
  ["topic_tag", 50],
  ["alt_text", 1000],
  ["location_id", 200],
]);
const flags = new Set([
  "is_ghost_post",
  "is_spoiler_media",
  "is_made_with_ai",
  "enable_reply_approvals",
  "crossreshare_to_ig",
  "crossreshare_to_ig_dark_mode",
]);
const styles = new Set(["bold", "italic", "highlight", "underline", "strikethrough"]);
const replyControls = new Set([
  "everyone",
  "accounts_you_follow",
  "mentioned_only",
  "parent_post_author_only",
  "followers_only",
]);

/** Requires a plain JSON object with only the explicit keys; used before every nested type refinement. */
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

/** Checks bounded Unicode draft text; publication additionally requires a nonempty value. */
function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.trim().length > 0) &&
    [...value].length <= maximum
  );
}

/** Validates offsets against the actual attached text; out-of-range styling/spoilers never reach Meta. */
function range(value: Record<string, unknown>, maximum: number): boolean {
  return (
    typeof value.offset === "number" &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    typeof value.length === "number" &&
    Number.isSafeInteger(value.length) &&
    value.length > 0 &&
    value.offset + value.length <= maximum
  );
}

/**
 * Validates bounded, exact-key draft intent without requiring completed poll,
 * GIF, or long-text fields. Draft URLs are inert strings: they are validated
 * before publication, never fetched while saving a partially typed draft.
 */
export function parseThreadsPostOptions(value: unknown): ThreadsPostOptions | null {
  if (
    !object(value, [
      ...stringLimits.keys(),
      ...flags,
      "post_type",
      "reply_control",
      "allowlisted_country_codes",
      "poll_attachment",
      "gif_attachment",
      "text_attachment",
      "text_entities",
    ])
  )
    return null;
  for (const [key, field] of Object.entries(value)) {
    const limit = stringLimits.get(key);
    if (limit !== undefined) {
      if (!text(field, limit, true)) return null;
    } else if (flags.has(key)) {
      if (typeof field !== "boolean") return null;
    } else if (key === "post_type") {
      if (
        typeof field !== "string" ||
        !["post", "poll", "long_text", "gif", "ghost", "quote", "reply", "repost"].includes(field)
      )
        return null;
    } else if (key === "reply_control") {
      if (typeof field !== "string" || !replyControls.has(field)) return null;
    } else if (key === "allowlisted_country_codes") {
      if (
        !Array.isArray(field) ||
        !field.length ||
        field.length > 249 ||
        new Set(field).size !== field.length ||
        field.some((code) => typeof code !== "string" || !/^[A-Z]{2}$/.test(code))
      )
        return null;
    } else if (key === "poll_attachment") {
      if (
        !object(field, ["option_a", "option_b", "option_c", "option_d"]) ||
        Object.values(field).some((option) => !text(option, 25, true))
      )
        return null;
    } else if (key === "gif_attachment") {
      if (
        !object(field, ["provider", "gif_id"]) ||
        field.provider !== "GIPHY" ||
        (field.gif_id !== undefined && !text(field.gif_id, 200, true))
      )
        return null;
    } else if (key === "text_attachment") {
      if (
        !object(field, ["plaintext", "link_attachment_url", "text_with_styling_info"]) ||
        (field.plaintext !== undefined && !text(field.plaintext, 10000, true)) ||
        (field.link_attachment_url !== undefined && !text(field.link_attachment_url, 2048, true))
      )
        return null;
      const spans = field.text_with_styling_info;
      if (
        spans !== undefined &&
        (!Array.isArray(spans) ||
          spans.length > 100 ||
          spans.some(
            (span) =>
              !object(span, ["offset", "length", "styling_info"]) ||
              !range(span, 10000) ||
              !Array.isArray(span.styling_info) ||
              !span.styling_info.length ||
              span.styling_info.length > 5 ||
              new Set(span.styling_info).size !== span.styling_info.length ||
              span.styling_info.some((style) => typeof style !== "string" || !styles.has(style)),
          ))
      )
        return null;
    } else if (key === "text_entities") {
      if (
        !Array.isArray(field) ||
        field.length > 10 ||
        field.some(
          (span) =>
            !object(span, ["entity_type", "offset", "length"]) ||
            span.entity_type !== "SPOILER" ||
            !range(span, 500),
        )
      )
        return null;
    }
  }
  // Every field, discriminant, nested key, and element has been checked above.
  return value;
}

/**
 * Refines a structurally valid draft into complete native container options.
 * Blank fields and malformed external references remain saveable draft intent
 * but cannot reach Meta. Content/attachment compatibility is checked separately.
 */
export function parseThreadsOptions(value: unknown): ThreadsPublishOptions | null {
  const options = parseThreadsPostOptions(value);
  if (!options) return null;
  for (const [key, limit] of stringLimits) {
    const field = options[key as keyof typeof options];
    if (field === undefined) continue;
    if (
      !text(field, limit) ||
      (key.endsWith("_id") && !/^[A-Za-z0-9_-]+$/.test(field)) ||
      (key === "topic_tag" && /[.&\n\t]/.test(field)) ||
      (key === "link_attachment" && !secureUrl(field))
    )
      return null;
  }
  const poll = options.poll_attachment;
  if (
    poll &&
    (!text(poll.option_a, 25) ||
      !text(poll.option_b, 25) ||
      Object.values(poll).some((option) => !text(option, 25)) ||
      (poll.option_d !== undefined && poll.option_c === undefined))
  )
    return null;
  if (options.gif_attachment && !text(options.gif_attachment.gif_id, 200)) return null;
  const attachment = options.text_attachment;
  if (
    attachment &&
    (!text(attachment.plaintext, 10000) ||
      (attachment.link_attachment_url !== undefined &&
        !secureUrl(attachment.link_attachment_url)) ||
      attachment.text_with_styling_info?.some(
        (span) => !range(span, attachment.plaintext?.length ?? 0),
      ))
  )
    return null;
  const spans = attachment?.text_with_styling_info;
  if (spans) {
    for (let index = 0; index < spans.length; index += 1) {
      const current = spans[index]!;
      for (let next = index + 1; next < spans.length; next += 1) {
        const other = spans[next]!;
        if (
          current.offset < other.offset + other.length &&
          other.offset < current.offset + current.length
        )
          return null;
      }
    }
  }
  // Required nested fields have now been refined, in addition to draft structure.
  return options as ThreadsPublishOptions;
}

/** Returns a user-visible incompatibility before creating any remote container or repost. */
export function threadsOptionsIssue(
  options: ThreadsPublishOptions,
  caption: string,
  mediaCount: number,
): string | null {
  const method = options.post_type;
  if (
    (method === "poll" && !options.poll_attachment) ||
    (method === "gif" && !options.gif_attachment) ||
    (method === "long_text" && !options.text_attachment) ||
    (method === "quote" && !options.quote_post_id) ||
    (method === "reply" && !options.reply_to_id) ||
    (method === "repost" && !options.repost_id) ||
    (method === "ghost" && options.is_ghost_post !== true)
  )
    return "Complete the selected Threads publishing method before sending.";
  if (
    options.repost_id &&
    (mediaCount ||
      caption.trim() ||
      Object.keys(options).some((key) => key !== "post_type" && key !== "repost_id"))
  )
    return "A repost requires only the source Post ID, with no caption, attachments, or other options.";
  const exclusive = [
    options.poll_attachment,
    options.gif_attachment,
    options.text_attachment,
  ].filter(Boolean).length;
  if (exclusive > 1) return "Polls, GIFs, and long-text attachments cannot be combined.";
  if (mediaCount && (exclusive || options.is_ghost_post || options.link_attachment))
    return "Polls, GIFs, long-text attachments, ghosts, and link attachments require a text-only Post.";
  if (!mediaCount && (options.alt_text || options.is_spoiler_media))
    return "Alt text and media spoilers require an image or video.";
  if (
    options.is_ghost_post &&
    (options.reply_to_id ||
      options.quote_post_id ||
      options.poll_attachment ||
      options.gif_attachment ||
      options.text_attachment)
  )
    return "A ghost Post supports only text and text spoilers, not replies, quotes, or attachments.";
  if (options.text_attachment?.link_attachment_url && options.link_attachment)
    return "Choose one link attachment, not links on both the Post and its long text.";
  if (options.crossreshare_to_ig && options.crossreshare_to_ig_dark_mode)
    return "Choose one Instagram Story cross-share appearance.";
  if (options.quote_post_id && options.reply_to_id)
    return "A Post cannot be both a reply and a quote.";
  if (options.text_entities?.some((span) => span.offset + span.length > caption.length))
    return "A spoiler range extends beyond the caption.";
  return null;
}

/** Serializes only validated options on the parent container; carousel children never receive post-level flags. */
export function applyThreadsOptions(
  parameters: URLSearchParams,
  options: ThreadsPublishOptions,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || key === "repost_id" || key === "post_type") continue;
    parameters.set(
      key,
      key === "allowlisted_country_codes" && Array.isArray(value)
        ? value.join(",")
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    );
  }
}
