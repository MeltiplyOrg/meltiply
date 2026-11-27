import type { components } from "@meltiply/contracts/schema";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";

import {
  FACEBOOK_OPTION_LIMITS,
  FACEBOOK_POST_TYPES,
  facebookOptimizationGoals,
  facebookOptionsToWire,
} from "./facebook/options";
import {
  INSTAGRAM_POST_TYPES,
  INSTAGRAM_TRIAL_GRADUATIONS,
  parseInstagramContent,
  resolveInstagramPlacement,
} from "./instagram/options";
import { PROVIDER_LIMITS } from "./limits";
import {
  parseThreadsOptions,
  parseThreadsPostOptions,
  type ThreadsPostOptions,
} from "./threads/options";
import {
  TIKTOK_PRIVACY_LEVELS,
  YOUTUBE_PRIVACY_STATUSES,
  type FacebookPostType,
  type FacebookPublishOptions,
  type InstagramPostType,
  type InstagramPublishOptions,
  type InstagramTrialGraduation,
  type ProviderPublishOptions,
  type TikTokPrivacyLevel,
  type TikTokPublishOptions,
  type YouTubePrivacyStatus,
  type YouTubePublishOptions,
} from "./types";
import { record } from "./values";

type Schemas = components["schemas"];

export interface ParsedPostProviderOptions {
  facebook?: FacebookPublishOptions;
  instagram?: InstagramPublishOptions;
  threads?: ThreadsPostOptions;
  tiktok?: TikTokPublishOptions & { discloseCommercialContent?: boolean };
  youtube?: Omit<YouTubePublishOptions, "madeForKids"> & { madeForKids?: boolean };
}

export type WireOptionsParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const facebookPostTypeSet: ReadonlySet<string> = new Set(FACEBOOK_POST_TYPES);
const facebookOptimizationGoalSet: ReadonlySet<string> = new Set(facebookOptimizationGoals);
const instagramPostTypeSet: ReadonlySet<string> = new Set(INSTAGRAM_POST_TYPES);
const instagramTrialGraduationSet: ReadonlySet<string> = new Set(INSTAGRAM_TRIAL_GRADUATIONS);

const unknownFieldMessage = "The request contains an unknown field.";

function hasUnknownKey(object: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(object).some((key) => !allowedSet.has(key));
}

function fail<T>(message: string): WireOptionsParseResult<T> {
  return { ok: false, message };
}

function parseFacebookABTestWireOptions(
  value: unknown,
): WireOptionsParseResult<NonNullable<FacebookPublishOptions["abTest"]>> {
  const test = record(value);
  if (!test) return fail("ab_test must be an object.");
  if (
    hasUnknownKey(test, [
      "name",
      "control_video_id",
      "experiment_video_ids",
      "optimization_goal",
      "duration_seconds",
    ])
  )
    return fail(unknownFieldMessage);
  if (test.name !== undefined && typeof test.name !== "string") {
    return fail("name must be a string.");
  }
  if (test.control_video_id !== undefined && typeof test.control_video_id !== "string") {
    return fail("control_video_id must be a string.");
  }
  if (test.experiment_video_ids !== undefined) {
    if (
      !Array.isArray(test.experiment_video_ids) ||
      test.experiment_video_ids.some((entry) => typeof entry !== "string")
    ) {
      return fail("experiment_video_ids must be an array of strings.");
    }
  }
  if (test.optimization_goal !== undefined && typeof test.optimization_goal !== "string") {
    return fail("optimization_goal must be a string.");
  }
  if (
    test.optimization_goal !== undefined &&
    !facebookOptimizationGoalSet.has(test.optimization_goal)
  ) {
    return fail("optimization_goal is invalid.");
  }
  if (
    test.duration_seconds !== undefined &&
    (typeof test.duration_seconds !== "number" ||
      !Number.isSafeInteger(test.duration_seconds) ||
      test.duration_seconds < 1)
  ) {
    return fail("duration_seconds must be a positive safe integer.");
  }
  const name = test.name;
  const controlVideoId = test.control_video_id;
  const experimentVideoIds = test.experiment_video_ids as string[] | undefined;
  const optimizationGoal = test.optimization_goal as
    | NonNullable<FacebookPublishOptions["abTest"]>["optimizationGoal"]
    | undefined;
  const durationSeconds = test.duration_seconds;
  if (
    (name !== undefined && name.length > FACEBOOK_OPTION_LIMITS.maxAbTestNameChars) ||
    (controlVideoId !== undefined && controlVideoId.length > 255) ||
    (experimentVideoIds !== undefined &&
      (experimentVideoIds.length > FACEBOOK_OPTION_LIMITS.maxExperimentVideos ||
        experimentVideoIds.some((id) => id.length > 255))) ||
    (durationSeconds !== undefined &&
      durationSeconds > FACEBOOK_OPTION_LIMITS.maxAbTestDurationSeconds)
  ) {
    return fail("The A/B test options are invalid.");
  }
  return {
    ok: true,
    value: {
      ...(name !== undefined ? { name } : {}),
      ...(controlVideoId !== undefined ? { controlVideoId } : {}),
      ...(experimentVideoIds !== undefined ? { experimentVideoIds } : {}),
      ...(optimizationGoal !== undefined ? { optimizationGoal } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    },
  };
}

function parseFacebookWireOptions(value: unknown): WireOptionsParseResult<FacebookPublishOptions> {
  const facebook = record(value);
  if (!facebook) return fail("provider_options.facebook must be an object.");
  if (
    hasUnknownKey(facebook, [
      "post_type",
      "delivery_mode",
      "link",
      "link_cards",
      "crossposted_video_id",
      "ab_test",
    ])
  )
    return fail(unknownFieldMessage);
  if (facebook.post_type !== undefined) {
    if (typeof facebook.post_type !== "string") return fail("post_type must be a string.");
    if (!facebookPostTypeSet.has(facebook.post_type)) return fail("post_type is invalid.");
  }
  const postType = facebook.post_type as FacebookPostType | undefined;
  const cards = facebook.link_cards;
  if (
    cards !== undefined &&
    (!Array.isArray(cards) || cards.length > FACEBOOK_OPTION_LIMITS.maxLinkCards)
  ) {
    return fail("link_cards must contain at most five draft cards.");
  }
  if (facebook.delivery_mode !== undefined) {
    if (typeof facebook.delivery_mode !== "string") return fail("delivery_mode must be a string.");
    if (facebook.delivery_mode !== "publish" && facebook.delivery_mode !== "draft") {
      return fail("delivery_mode is invalid.");
    }
  }
  const deliveryMode = facebook.delivery_mode;
  if (
    facebook.crossposted_video_id !== undefined &&
    typeof facebook.crossposted_video_id !== "string"
  ) {
    return fail("crossposted_video_id must be a string.");
  }
  const crosspostedVideoId = facebook.crossposted_video_id;
  if (crosspostedVideoId !== undefined && crosspostedVideoId.length > 255) {
    return fail("crossposted_video_id is invalid.");
  }
  if (facebook.link !== undefined && typeof facebook.link !== "string") {
    return fail("link must be a string.");
  }
  const link = facebook.link;
  if (link !== undefined && link.length > FACEBOOK_OPTION_LIMITS.maxUrlChars)
    return fail("The Page link is too long.");

  let abTest: FacebookPublishOptions["abTest"];
  if (facebook.ab_test !== undefined) {
    const parsed = parseFacebookABTestWireOptions(facebook.ab_test);
    if (!parsed.ok) return parsed;
    abTest = parsed.value;
  }

  let linkCards: FacebookPublishOptions["linkCards"];
  if (Array.isArray(cards)) {
    linkCards = [];
    for (const rawCard of cards) {
      const card = record(rawCard);
      if (!card) return fail("Each link card must be an object.");
      if (hasUnknownKey(card, ["link", "picture", "name", "description"])) {
        return fail(unknownFieldMessage);
      }
      if (card.name !== undefined && typeof card.name !== "string") {
        return fail("name must be a string.");
      }
      if (card.description !== undefined && typeof card.description !== "string") {
        return fail("description must be a string.");
      }
      if (card.link !== undefined && typeof card.link !== "string") {
        return fail("link must be a string.");
      }
      if (card.picture !== undefined && typeof card.picture !== "string") {
        return fail("picture must be a string.");
      }
      const cardLink = card.link ?? "";
      const picture = card.picture ?? "";
      if (
        cardLink.length > FACEBOOK_OPTION_LIMITS.maxUrlChars ||
        picture.length > FACEBOOK_OPTION_LIMITS.maxUrlChars
      ) {
        return fail("The link card URL is too long.");
      }
      if (
        (card.name !== undefined && card.name.length > FACEBOOK_OPTION_LIMITS.maxCardNameChars) ||
        (card.description !== undefined &&
          card.description.length > FACEBOOK_OPTION_LIMITS.maxCardDescriptionChars)
      ) {
        return fail("The link card text is too long.");
      }
      linkCards.push({
        link: cardLink,
        picture,
        ...(card.name !== undefined ? { name: card.name } : {}),
        ...(card.description !== undefined ? { description: card.description } : {}),
      });
    }
  }

  return {
    ok: true,
    value: {
      ...(postType !== undefined ? { postType } : {}),
      ...(deliveryMode !== undefined ? { deliveryMode } : {}),
      ...(crosspostedVideoId !== undefined ? { crosspostedVideoId } : {}),
      ...(abTest !== undefined ? { abTest } : {}),
      ...(link !== undefined ? { link } : {}),
      ...(linkCards !== undefined ? { linkCards } : {}),
    },
  };
}

function parseInstagramWireOptions(
  value: unknown,
): WireOptionsParseResult<InstagramPublishOptions> {
  const instagram = record(value);
  if (!instagram) return fail("provider_options.instagram must be an object.");
  if (
    hasUnknownKey(instagram, [
      "post_type",
      "trial_reel",
      "trial_graduation",
      "content",
      "media_options",
    ])
  )
    return fail(unknownFieldMessage);
  const content =
    instagram.content === undefined ? undefined : parseInstagramContent(instagram.content);
  const mediaOptions =
    instagram.media_options === undefined
      ? undefined
      : Array.isArray(instagram.media_options) &&
          instagram.media_options.length <= PROVIDER_LIMITS.instagram.maxCarouselItems
        ? instagram.media_options.map(parseInstagramContent)
        : null;
  if (content === null || mediaOptions === null || mediaOptions?.some((item) => item === null)) {
    return fail("Instagram content metadata is invalid.");
  }
  const postType = instagram.post_type;
  const trialGraduation = instagram.trial_graduation;
  if (
    (postType !== undefined &&
      (typeof postType !== "string" || !instagramPostTypeSet.has(postType))) ||
    (instagram.trial_reel !== undefined && typeof instagram.trial_reel !== "boolean") ||
    (trialGraduation !== undefined &&
      (typeof trialGraduation !== "string" || !instagramTrialGraduationSet.has(trialGraduation)))
  ) {
    return fail("provider_options.instagram is invalid.");
  }
  return {
    ok: true,
    value: {
      ...(content !== undefined ? { content } : {}),
      ...(mediaOptions ? { mediaOptions: mediaOptions.filter((item) => item !== null) } : {}),
      ...(postType !== undefined ? { postType: postType as InstagramPostType } : {}),
      ...(instagram.trial_reel !== undefined ? { trialReel: instagram.trial_reel } : {}),
      ...(trialGraduation !== undefined
        ? { trialGraduation: trialGraduation as InstagramTrialGraduation }
        : {}),
    },
  };
}

function parseTikTokWireOptions(
  value: unknown,
): WireOptionsParseResult<NonNullable<ParsedPostProviderOptions["tiktok"]>> {
  const tiktok = record(value);
  if (!tiktok) return fail("provider_options.tiktok must be an object.");
  if (
    hasUnknownKey(tiktok, [
      "privacy_level",
      "post_mode",
      "allow_comment",
      "allow_duet",
      "allow_stitch",
      "brand_content",
      "brand_organic",
      "is_ai_generated",
      "music_usage_confirmed",
      "disclose_commercial_content",
      "auto_add_music",
    ])
  )
    return fail(unknownFieldMessage);
  if (tiktok.post_mode !== undefined) {
    if (typeof tiktok.post_mode !== "string") return fail("post_mode must be a string.");
    if (tiktok.post_mode !== "direct" && tiktok.post_mode !== "inbox") {
      return fail("post_mode is invalid.");
    }
  }
  const postMode = tiktok.post_mode;
  const privacyLevel = tiktok.privacy_level;
  const booleanKeys = [
    "allow_comment",
    "allow_duet",
    "allow_stitch",
    "brand_content",
    "brand_organic",
    "is_ai_generated",
  ] as const;
  if (
    (privacyLevel !== undefined &&
      (typeof privacyLevel !== "string" ||
        !TIKTOK_PRIVACY_LEVELS.has(privacyLevel as TikTokPrivacyLevel))) ||
    (tiktok.disclose_commercial_content !== undefined &&
      typeof tiktok.disclose_commercial_content !== "boolean") ||
    (tiktok.auto_add_music !== undefined && typeof tiktok.auto_add_music !== "boolean") ||
    booleanKeys.some((key) => typeof tiktok[key] !== "boolean") ||
    tiktok.music_usage_confirmed !== true
  ) {
    return fail("provider_options.tiktok is invalid.");
  }
  return {
    ok: true,
    value: {
      ...(postMode !== undefined ? { postMode } : {}),
      allowComment: tiktok.allow_comment as boolean,
      allowDuet: tiktok.allow_duet as boolean,
      allowStitch: tiktok.allow_stitch as boolean,
      brandContent: tiktok.brand_content as boolean,
      brandOrganic: tiktok.brand_organic as boolean,
      isAiGenerated: tiktok.is_ai_generated as boolean,
      musicUsageConfirmed: true,
      ...(typeof tiktok.auto_add_music === "boolean"
        ? { autoAddMusic: tiktok.auto_add_music }
        : {}),
      ...(privacyLevel !== undefined ? { privacyLevel: privacyLevel as TikTokPrivacyLevel } : {}),
      ...(typeof tiktok.disclose_commercial_content === "boolean"
        ? { discloseCommercialContent: tiktok.disclose_commercial_content }
        : {}),
    },
  };
}

function parseYouTubeWireOptions(
  value: unknown,
): WireOptionsParseResult<NonNullable<ParsedPostProviderOptions["youtube"]>> {
  const youtube = record(value);
  if (!youtube) return fail("provider_options.youtube must be an object.");
  if (hasUnknownKey(youtube, ["made_for_kids", "privacy_status", "post_type"]))
    return fail(unknownFieldMessage);
  const privacyStatus = youtube.privacy_status;
  if (
    (youtube.post_type !== undefined &&
      youtube.post_type !== "video" &&
      youtube.post_type !== "live") ||
    (youtube.made_for_kids !== undefined && typeof youtube.made_for_kids !== "boolean") ||
    (privacyStatus !== undefined &&
      (typeof privacyStatus !== "string" ||
        !YOUTUBE_PRIVACY_STATUSES.has(privacyStatus as YouTubePrivacyStatus)))
  ) {
    return fail("provider_options.youtube is invalid.");
  }
  return {
    ok: true,
    value: {
      ...(youtube.post_type === "video" || youtube.post_type === "live"
        ? { postType: youtube.post_type }
        : {}),
      ...(typeof youtube.made_for_kids === "boolean" ? { madeForKids: youtube.made_for_kids } : {}),
      ...(privacyStatus !== undefined
        ? { privacyStatus: privacyStatus as YouTubePrivacyStatus }
        : {}),
    },
  };
}

export function parseProviderWireOptions(
  value: unknown,
): WireOptionsParseResult<ParsedPostProviderOptions> {
  const options = record(value);
  if (!options) return fail("provider_options must be an object.");
  if (hasUnknownKey(options, PLATFORM_IDS)) return fail(unknownFieldMessage);
  const result: ParsedPostProviderOptions = {};
  if (options.threads !== undefined) {
    const threads = parseThreadsPostOptions(options.threads);
    if (threads === null) return fail("provider_options.threads is invalid.");
    result.threads = threads;
  }
  if (options.facebook !== undefined) {
    const facebook = parseFacebookWireOptions(options.facebook);
    if (!facebook.ok) return facebook;
    result.facebook = facebook.value;
  }
  if (options.instagram !== undefined) {
    const instagram = parseInstagramWireOptions(options.instagram);
    if (!instagram.ok) return instagram;
    result.instagram = instagram.value;
  }
  if (options.tiktok !== undefined) {
    const tiktok = parseTikTokWireOptions(options.tiktok);
    if (!tiktok.ok) return tiktok;
    result.tiktok = tiktok.value;
  }
  if (options.youtube !== undefined) {
    const youtube = parseYouTubeWireOptions(options.youtube);
    if (!youtube.ok) return youtube;
    result.youtube = youtube.value;
  }
  return { ok: true, value: result };
}

function mapInstagramOptionsToWire(
  instagram: NonNullable<ParsedPostProviderOptions["instagram"]>,
): NonNullable<Schemas["PostProviderOptions"]["instagram"]> {
  return {
    ...(instagram.content ? { content: instagram.content } : {}),
    ...(instagram.mediaOptions ? { media_options: instagram.mediaOptions } : {}),
    ...(instagram.postType !== undefined ? { post_type: instagram.postType } : {}),
    ...(instagram.trialReel !== undefined ? { trial_reel: instagram.trialReel } : {}),
    ...(instagram.trialGraduation !== undefined
      ? { trial_graduation: instagram.trialGraduation }
      : {}),
  };
}

function mapTikTokBaseOptionsToWire(tiktok: NonNullable<ParsedPostProviderOptions["tiktok"]>) {
  return {
    ...(tiktok.postMode !== undefined ? { post_mode: tiktok.postMode } : {}),
    allow_comment: tiktok.allowComment,
    allow_duet: tiktok.allowDuet,
    allow_stitch: tiktok.allowStitch,
    brand_content: tiktok.brandContent,
    brand_organic: tiktok.brandOrganic,
    is_ai_generated: tiktok.isAiGenerated,
    music_usage_confirmed: tiktok.musicUsageConfirmed,
    ...(tiktok.autoAddMusic !== undefined ? { auto_add_music: tiktok.autoAddMusic } : {}),
  };
}

function mapYouTubeBaseOptionsToWire(youtube: NonNullable<ParsedPostProviderOptions["youtube"]>) {
  return {
    ...(youtube.postType ? { post_type: youtube.postType } : {}),
    ...(youtube.privacyStatus ? { privacy_status: youtube.privacyStatus } : {}),
  };
}

export function toWireProviderOptions(
  options: ProviderPublishOptions | null,
): Schemas["ProviderPublishOptions"] | null {
  if (!options) return null;
  const { facebook, instagram, threads, tiktok, youtube } = options;
  if (!tiktok && !youtube && !instagram && !facebook && !threads) return null;
  return {
    ...(threads ? { threads } : {}),
    ...(facebook ? { facebook: facebookOptionsToWire(facebook) } : {}),
    ...(instagram ? { instagram: mapInstagramOptionsToWire(instagram) } : {}),
    ...(tiktok
      ? {
          tiktok: {
            ...mapTikTokBaseOptionsToWire(tiktok),
            privacy_level: tiktok.privacyLevel,
          },
        }
      : {}),
    ...(youtube
      ? {
          youtube: {
            ...mapYouTubeBaseOptionsToWire(youtube),
            made_for_kids: youtube.madeForKids,
          },
        }
      : {}),
  };
}

export function toWirePostProviderOptions(
  options: ParsedPostProviderOptions | null,
): Schemas["PostProviderOptions"] | null {
  if (!options) return null;
  const { facebook, instagram, threads, tiktok, youtube } = options;
  if (!tiktok && !youtube && !instagram && !facebook && !threads) return null;
  return {
    ...(threads ? { threads } : {}),
    ...(facebook ? { facebook: facebookOptionsToWire(facebook) } : {}),
    ...(instagram ? { instagram: mapInstagramOptionsToWire(instagram) } : {}),
    ...(tiktok
      ? {
          tiktok: {
            ...mapTikTokBaseOptionsToWire(tiktok),
            ...(tiktok.discloseCommercialContent !== undefined
              ? { disclose_commercial_content: tiktok.discloseCommercialContent }
              : {}),
            ...(tiktok.privacyLevel !== undefined ? { privacy_level: tiktok.privacyLevel } : {}),
          },
        }
      : {}),
    ...(youtube
      ? {
          youtube: {
            ...mapYouTubeBaseOptionsToWire(youtube),
            ...(youtube.madeForKids !== undefined ? { made_for_kids: youtube.madeForKids } : {}),
          },
        }
      : {}),
  };
}

export function resolvePublishProviderOptions(
  options: ParsedPostProviderOptions | undefined,
  platform: Platform,
  mediaKinds: readonly ("image" | "video" | null)[],
): WireOptionsParseResult<ProviderPublishOptions | undefined> {
  if (!options && platform !== "youtube" && platform !== "tiktok") {
    return { ok: true, value: undefined };
  }
  const result: ProviderPublishOptions = {};
  if (options?.threads) {
    if (platform !== "threads") return fail("Threads options require a Threads Channel.");
    const threads = parseThreadsOptions(options.threads);
    if (!threads) return fail("Complete the Threads publication choices before sending.");
    result.threads = threads;
  }
  if (platform === "youtube" || options?.youtube) {
    const madeForKids = options?.youtube?.madeForKids;
    const privacyStatus = options?.youtube?.privacyStatus;
    if (madeForKids === undefined) {
      return fail("Choose whether the YouTube video is made for kids before publishing.");
    }
    if (privacyStatus === undefined) {
      return fail("Choose a YouTube visibility before publishing.");
    }
    result.youtube = {
      madeForKids,
      privacyStatus,
      ...(options?.youtube?.postType ? { postType: options.youtube.postType } : {}),
    };
  }
  if (options?.tiktok) {
    const { privacyLevel, discloseCommercialContent, ...choices } = options.tiktok;
    if (privacyLevel === undefined && choices.postMode !== "inbox") {
      return fail("Choose a TikTok privacy level before publishing.");
    }
    if (
      choices.postMode !== "inbox" &&
      discloseCommercialContent &&
      !choices.brandContent &&
      !choices.brandOrganic
    ) {
      return fail("Choose a TikTok commercial content subtype before publishing.");
    }
    result.tiktok = { ...choices, privacyLevel };
  }
  if (options?.instagram) {
    if (platform !== "instagram") {
      return fail("Instagram provider options require an Instagram account.");
    }
    result.instagram = { ...options.instagram };
  }
  if (options?.facebook) {
    if (platform !== "facebook") return fail("Facebook options require a Facebook Page.");
    result.facebook = { ...options.facebook };
  }
  if (result.tiktok && platform !== "tiktok") {
    return fail("TikTok provider options require a TikTok account.");
  }
  if (platform === "tiktok") {
    const tiktok = result.tiktok;
    if (!tiktok || tiktok.musicUsageConfirmed !== true) {
      return fail("TikTok publishing choices and music-usage confirmation are required.");
    }
    const publishesPhoto = mediaKinds.includes("image");
    const publishesVideo = mediaKinds.includes("video");
    if (tiktok.postMode !== "inbox" && publishesPhoto && (tiktok.allowDuet || tiktok.allowStitch)) {
      return fail("TikTok photo posts do not support Duet or Stitch.");
    }
    if (publishesVideo && tiktok.autoAddMusic === true) {
      return fail("TikTok automatic music applies to photo posts only.");
    }
    if (tiktok.postMode !== "inbox" && tiktok.brandContent && tiktok.privacyLevel === "SELF_ONLY") {
      return fail("TikTok branded content cannot use private visibility.");
    }
  }
  if (result.instagram && !resolveInstagramPlacement(result.instagram, mediaKinds)) {
    return fail(
      "The selected Instagram post type or trial Reel does not apply to this attachment set.",
    );
  }
  return { ok: true, value: result };
}
