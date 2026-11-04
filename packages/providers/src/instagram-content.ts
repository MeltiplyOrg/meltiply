import type { components } from "@meltiply/contracts/schema";
import { record, secureUrl } from "./meta-common";

/** Instagram-Login content metadata; Facebook-Login-only music, shopping and partnership APIs are deliberately absent. */
export type InstagramContentOptions = components["schemas"]["InstagramContentOptions"];

/** Validates exact-key bounded draft metadata, including at most three collaborators; publishing requires nonblank identities and valid URLs. */
export function parseInstagramContent(value: unknown): InstagramContentOptions | null {
  const fields = record(value);
  if (!fields) return null;
  for (const [key, field] of Object.entries(fields)) {
    if (["alt_text", "cover_url", "audio_name", "location_id"].includes(key)) {
      const maximum =
        key === "alt_text" ? 1000 : key === "cover_url" ? 2048 : key === "audio_name" ? 255 : 200;
      if (typeof field !== "string" || [...field].length > maximum) return null;
    } else if (["share_to_feed", "is_ai_generated"].includes(key)) {
      if (typeof field !== "boolean") return null;
    } else if (key === "thumb_offset") {
      if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) return null;
    } else if (key === "collaborators") {
      if (
        !Array.isArray(field) ||
        field.length > 3 ||
        new Set(field).size !== field.length ||
        field.some((name) => typeof name !== "string" || name.length > 30)
      )
        return null;
    } else if (key === "user_tags") {
      if (
        !Array.isArray(field) ||
        field.length > 20 ||
        field.some((tag) => {
          const item = record(tag);
          return (
            !item ||
            Object.keys(item).some((key) => !["username", "x", "y"].includes(key)) ||
            typeof item.username !== "string" ||
            item.username.length > 30 ||
            [item.x, item.y].some(
              (coordinate) =>
                coordinate !== undefined &&
                (typeof coordinate !== "number" ||
                  !Number.isFinite(coordinate) ||
                  coordinate < 0 ||
                  coordinate > 1),
            )
          );
        })
      )
        return null;
    } else return null;
  }
  return fields;
}

/** Rejects metadata that the selected endpoint cannot accept rather than silently discarding it. */
export function instagramContentIssue(
  options: InstagramContentOptions | undefined,
  kind: "image" | "video" | null,
  postType: "feed" | "reel" | "story",
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
  if (options.location_id !== undefined && !/^[0-9]+$/.test(options.location_id))
    return "Instagram requires a numeric Facebook location ID.";
  if (options.collaborators?.some((name) => !/^[A-Za-z0-9._]{1,30}$/.test(name)))
    return "Collaborators require valid Instagram usernames.";
  if (
    options.user_tags?.some(
      (tag) =>
        !/^[A-Za-z0-9._]{1,30}$/.test(tag.username) ||
        (kind === "image" && postType !== "story" && (tag.x === undefined || tag.y === undefined)),
    )
  )
    return "Image user tags require a username and normalized x/y coordinates.";
  return null;
}

/** Writes validated provider-native metadata on exactly the container that owns it. */
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
