import type {
  InstagramPostType,
  InstagramPublishOptions,
  InstagramTrialGraduation,
} from "./types";

/**
 * Attachment kind the option rules evaluate. `null` is an attachment whose
 * MIME type is not an image or video; it can never satisfy a Reel or Story
 * shape.
 */
export type InstagramMediaKind = "image" | "video" | null;

/** The validated publication shape one Instagram target will use. */
export interface ResolvedInstagramOptions {
  postType: InstagramPostType;
  trialGraduation: InstagramTrialGraduation;
  trialReel: boolean;
}

const instagramPostTypes: readonly InstagramPostType[] = ["feed", "reel", "story"];
const instagramTrialGraduations: readonly InstagramTrialGraduation[] = [
  "manual",
  "performance",
];

/**
 * Resolves and validates Instagram's publication shape against the actual
 * attachment set. A single image or video defaults to a feed post; a single
 * video defaults to a Reel. Stories and trial Reels require one attachment, and
 * a trial Reel must be a Reel. Unknown or contradictory choices fail closed
 * instead of being replaced by a default, so the composer, API pre-flight, and
 * publishing adapter all agree on the same rule.
 *
 * @param options - Creator-selected options, or undefined for the documented default.
 * @param kinds - Ordered attachment kinds; length is the attachment count.
 * @returns The resolved shape, or null when the choices cannot apply.
 */
export function resolveInstagramOptions(
  options: InstagramPublishOptions | undefined,
  kinds: readonly InstagramMediaKind[],
): ResolvedInstagramOptions | null {
  const [only] = kinds;
  const postType =
    options?.postType ?? (kinds.length === 1 && only === "video" ? "reel" : "feed");
  const trialReel = options?.trialReel ?? false;
  const trialGraduation = options?.trialGraduation ?? "manual";
  const invalid =
    !instagramPostTypes.includes(postType) ||
    kinds.length === 0 ||
    (kinds.length > 1 && postType !== "feed") ||
    (postType === "reel" && (kinds.length !== 1 || only !== "video")) ||
    (postType === "story" && kinds.length !== 1) ||
    (trialReel && postType !== "reel") ||
    (options?.trialGraduation !== undefined && !trialReel) ||
    !instagramTrialGraduations.includes(trialGraduation);
  if (invalid) return null;
  return { postType, trialGraduation, trialReel };
}
