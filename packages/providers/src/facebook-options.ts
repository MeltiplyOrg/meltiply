import type { components } from "@meltiply/contracts/schema";
import type { FacebookOptimizationGoal, FacebookPostType, FacebookPublishOptions } from "./types";
import { providerIdentifier } from "./meta-common";

const postTypes: readonly FacebookPostType[] = [
  "feed",
  "video",
  "reel",
  "story",
  "slideshow",
  "crosspost",
  "ab_test",
  "live",
];

/** Meta's documented goals for Page video/Reel experiments. */
export const facebookOptimizationGoals: readonly FacebookOptimizationGoal[] = [
  "AVG_TIME_WATCHED",
  "COMMENTS",
  "IMPRESSIONS",
  "IMPRESSIONS_UNIQUE",
  "LINK_CLICKS",
  "REACTIONS",
  "REELS_PLAYS",
  "SHARES",
  "VIDEO_VIEWS_60S",
];

/** Bounds credential-free Page links and HTTPS card artwork before Meta fetches them. */
function pageLink(value: unknown, httpsOnly = false): boolean {
  if (typeof value !== "string" || !value || value.length > 2048 || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:"))
  );
}

/**
 * Resolves the Page publishing method against the target's ordered attachments.
 * One video defaults to a Reel; text and photos default to feed. Explicit
 * methods never fall back to another method or discard an attachment/link.
 * Returns null for incompatible choices; media facts are validated separately.
 */
export function resolveFacebookPostType(
  options: FacebookPublishOptions | undefined,
  kinds: readonly ("image" | "video" | null)[],
): FacebookPostType | null {
  const postType =
    options?.postType ?? (kinds.length === 1 && kinds[0] === "video" ? "reel" : "feed");
  if (!postTypes.includes(postType) || kinds.includes(null)) return null;
  if (postType === "feed" && kinds.some((kind) => kind !== "image")) return null;
  if ((postType === "video" || postType === "reel") && (kinds.length !== 1 || kinds[0] !== "video"))
    return null;
  if (postType === "story" && kinds.length !== 1) return null;
  if (["live", "crosspost", "ab_test"].includes(postType) && kinds.length !== 0) return null;
  if (
    postType === "slideshow" &&
    (kinds.length < 3 || kinds.length > 7 || kinds.some((kind) => kind !== "image"))
  )
    return null;
  if (postType === "crosspost" && !providerIdentifier(options?.crosspostedVideoId)) return null;
  if (options?.crosspostedVideoId !== undefined && postType !== "crosspost") return null;
  if (options?.abTest !== undefined && postType !== "ab_test") return null;
  if (options?.deliveryMode !== undefined && !["publish", "draft"].includes(options.deliveryMode))
    return null;
  if (options?.deliveryMode === "draft" && ["story", "live", "ab_test"].includes(postType))
    return null;
  if (postType === "ab_test") {
    const test = options?.abTest;
    const ids = test?.experimentVideoIds;
    if (
      !test?.name?.trim() ||
      test.name.length > 200 ||
      !test.controlVideoId ||
      !providerIdentifier(test.controlVideoId) ||
      !test.optimizationGoal ||
      !facebookOptimizationGoals.includes(test.optimizationGoal) ||
      !ids ||
      ids.length < 2 ||
      ids.length > 4 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !providerIdentifier(id)) ||
      !ids.includes(test.controlVideoId) ||
      (test.durationSeconds !== undefined &&
        (!Number.isInteger(test.durationSeconds) ||
          test.durationSeconds < 1800 ||
          test.durationSeconds > 604800))
    )
      return null;
  }
  if (options?.link !== undefined && !pageLink(options.link)) return null;
  if (
    options?.linkCards?.some(
      (card) =>
        !pageLink(card.link) ||
        !pageLink(card.picture, true) ||
        (card.name !== undefined && card.name.length > 200) ||
        (card.description !== undefined && card.description.length > 5000),
    )
  )
    return null;
  if ((options?.link || options?.linkCards) && (postType !== "feed" || kinds.length !== 0))
    return null;
  if (
    options?.linkCards &&
    (!options.link || options.linkCards.length < 2 || options.linkCards.length > 5)
  )
    return null;
  return postType;
}

/**
 * Projects saved or frozen Page options to the public wire contract without
 * substituting answers for incomplete experiment drafts or changing order.
 */
export function facebookOptionsToWire(
  options: FacebookPublishOptions,
): components["schemas"]["FacebookPublishOptions"] {
  const test = options.abTest;
  return {
    ...(options.postType !== undefined ? { post_type: options.postType } : {}),
    ...(options.deliveryMode !== undefined ? { delivery_mode: options.deliveryMode } : {}),
    ...(options.link !== undefined ? { link: options.link } : {}),
    ...(options.linkCards !== undefined ? { link_cards: options.linkCards } : {}),
    ...(options.crosspostedVideoId !== undefined
      ? { crossposted_video_id: options.crosspostedVideoId }
      : {}),
    ...(test
      ? {
          ab_test: {
            ...(test.name !== undefined ? { name: test.name } : {}),
            ...(test.controlVideoId !== undefined ? { control_video_id: test.controlVideoId } : {}),
            ...(test.experimentVideoIds !== undefined
              ? { experiment_video_ids: test.experimentVideoIds }
              : {}),
            ...(test.optimizationGoal !== undefined
              ? { optimization_goal: test.optimizationGoal }
              : {}),
            ...(test.durationSeconds !== undefined
              ? { duration_seconds: test.durationSeconds }
              : {}),
          },
        }
      : {}),
  };
}
