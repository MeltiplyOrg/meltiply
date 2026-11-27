import type { components } from "@meltiply/contracts/schema";

import type {
  InstagramPostType,
  InstagramPublishOptions,
  InstagramTrialGraduation,
} from "../types";
import { codePointLength, record, secureUrl } from "../values";

/** Instagram Login metadata; Facebook-Login-only music, shopping, and partnership APIs are absent. */
export type InstagramContentOptions = components["schemas"]["InstagramContentOptions"];

export type InstagramMediaKind = "image" | "video" | null;

export interface ResolvedInstagramOptions {
  postType: InstagramPostType;
  trialGraduation: InstagramTrialGraduation;
  trialReel: boolean;
}

export const INSTAGRAM_POST_TYPES: readonly InstagramPostType[] = ["feed", "reel", "story"];
export const INSTAGRAM_TRIAL_GRADUATIONS: readonly InstagramTrialGraduation[] = [
  "manual",
  "performance",
];
const stringFieldLimits: ReadonlyMap<string, number> = new Map([
  ["alt_text", 1000],
  ["audio_name", 255],
  ["cover_url", 2048],
  ["location_id", 200],
]);
const usernamePattern = /^[A-Za-z0-9._]{1,30}$/;
const locationIdPattern = /^[0-9]+$/;
const maxCollaborators = 3;
const maxUserTags = 20;
const maxUsernameChars = 30;

function validUserTag(tag: unknown): boolean {
  const item = record(tag);
  return (
    !!item &&
    Object.keys(item).every((key) => key === "username" || key === "x" || key === "y") &&
    typeof item.username === "string" &&
    item.username.length <= maxUsernameChars &&
    [item.x, item.y].every(
      (coordinate) =>
        coordinate === undefined ||
        (typeof coordinate === "number" &&
          Number.isFinite(coordinate) &&
          coordinate >= 0 &&
          coordinate <= 1),
    )
  );
}

/** Exact-key, bounded draft metadata; publication additionally applies `instagramContentIssue`. */
export function parseInstagramContent(value: unknown): InstagramContentOptions | null {
  const fields = record(value);
  if (!fields) return null;
  for (const [key, field] of Object.entries(fields)) {
    const stringLimit = stringFieldLimits.get(key);
    const valid =
      stringLimit !== undefined
        ? typeof field === "string" && codePointLength(field) <= stringLimit
        : key === "share_to_feed" || key === "is_ai_generated"
          ? typeof field === "boolean"
          : key === "thumb_offset"
            ? typeof field === "number" && Number.isSafeInteger(field) && field >= 0
            : key === "collaborators"
              ? Array.isArray(field) &&
                field.length <= maxCollaborators &&
                new Set(field).size === field.length &&
                field.every((name) => typeof name === "string" && name.length <= maxUsernameChars)
              : key === "user_tags"
                ? Array.isArray(field) && field.length <= maxUserTags && field.every(validUserTag)
                : false;
    if (!valid) return null;
  }
  return fields;
}

function instagramContentIssue(
  options: InstagramContentOptions | undefined,
  kind: InstagramMediaKind,
  postType: InstagramPostType,
  child = false,
): string | null {
  if (!options) return null;
  if (!parseInstagramContent(options)) return "Instagram content metadata is invalid.";
  if (child && Object.keys(options).some((key) => key !== "alt_text" && key !== "user_tags"))
    return "Carousel item metadata supports only alt text and user tags.";
  if (postType === "story" && Object.keys(options).some((key) => key !== "user_tags"))
    return "Stories support user mentions, not feed metadata, captions, or Reel cover options.";
  if (options.alt_text !== undefined && kind !== "image")
    return "Alt text requires an image; carousel images use their per-item metadata.";
  if (
    (options.cover_url !== undefined ||
      options.audio_name !== undefined ||
      options.share_to_feed !== undefined) &&
    postType !== "reel"
  )
    return "Cover images, original-audio names, and share-to-feed apply only to Reels.";
  if (options.thumb_offset !== undefined && kind !== "video")
    return "Thumbnail offset requires a video.";
  if (options.cover_url !== undefined && !secureUrl(options.cover_url))
    return "The Reel cover must be a credential-free HTTPS image URL.";
  if (options.audio_name !== undefined && !options.audio_name.trim())
    return "The original-audio name cannot be blank.";
  if (options.location_id !== undefined && !locationIdPattern.test(options.location_id))
    return "Instagram requires a numeric Facebook location ID.";
  if (options.collaborators?.some((name) => !usernamePattern.test(name)))
    return "Collaborators require valid Instagram usernames.";
  if (
    options.user_tags?.some(
      (tag) =>
        !usernamePattern.test(tag.username) ||
        (kind === "image" && postType !== "story" && (tag.x === undefined || tag.y === undefined)),
    )
  )
    return "Image user tags require a username and normalized x/y coordinates.";
  return null;
}

export function applyInstagramContent(
  parameters: URLSearchParams,
  options: InstagramContentOptions | undefined,
): void {
  if (!options) return;
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined)
      parameters.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

export function defaultInstagramPostType(kinds: readonly InstagramMediaKind[]): InstagramPostType {
  return kinds.length === 1 && kinds[0] === "video" ? "reel" : "feed";
}

export function resolveInstagramPlacement(
  options: InstagramPublishOptions | undefined,
  kinds: readonly InstagramMediaKind[],
): ResolvedInstagramOptions | null {
  const [only] = kinds;
  const postType = options?.postType ?? defaultInstagramPostType(kinds);
  const trialReel = options?.trialReel ?? false;
  const trialGraduation = options?.trialGraduation ?? "manual";
  if (
    !INSTAGRAM_POST_TYPES.includes(postType) ||
    (postType === "reel" && (kinds.length !== 1 || only !== "video")) ||
    (postType === "story" && kinds.length !== 1) ||
    (trialReel && postType !== "reel") ||
    (options?.trialGraduation !== undefined && !trialReel) ||
    !INSTAGRAM_TRIAL_GRADUATIONS.includes(trialGraduation)
  ) {
    return null;
  }
  return { postType, trialGraduation, trialReel };
}

export function resolveInstagramOptions(
  options: InstagramPublishOptions | undefined,
  kinds: readonly InstagramMediaKind[],
): ResolvedInstagramOptions | null {
  const placement = resolveInstagramPlacement(options, kinds);
  if (!placement) return null;
  const { postType } = placement;
  const [only] = kinds;
  if (
    kinds.length === 0 ||
    (options?.mediaOptions && options.mediaOptions.length > kinds.length) ||
    instagramContentIssue(options?.content, kinds.length === 1 ? (only ?? null) : null, postType) ||
    options?.mediaOptions?.some((metadata, index) =>
      instagramContentIssue(metadata, kinds[index] ?? null, postType, kinds.length > 1),
    )
  ) {
    return null;
  }
  return placement;
}
