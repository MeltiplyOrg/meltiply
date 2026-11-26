import type { Platform } from "@meltiply/domain";

const assetVideoMaxBytes = 500 * 1024 * 1024;
const metaTokenLifetimeMaxSeconds = 90 * 24 * 60 * 60;
const tiktokTokenLifetimeMaxSeconds = 2 * 24 * 60 * 60;
const googleTokenLifetimeMaxSeconds = 24 * 60 * 60;
const strictTokenMaxChars = 16_000;

export const OAUTH_TOKEN_MAX_CHARS = 16_384;

/** Platform content, media, and token ceilings; capabilities and validators read only these. */
export const PROVIDER_LIMITS = {
  facebook: {
    maxCaptionCodePoints: null,
    maxHashtags: null,
    maxImageBytes: 10_000_000,
    maxMediaCount: null,
    maxReelDurationSeconds: 90,
    maxStoryDurationSeconds: 60,
    maxVideoBytes: assetVideoMaxBytes,
    minReelStoryDurationSeconds: 3,
    tokenLifetimeMaxSeconds: metaTokenLifetimeMaxSeconds,
    tokenMaxChars: strictTokenMaxChars,
  },
  instagram: {
    maxCaptionCodePoints: 2_200,
    maxCarouselItems: 20,
    maxHashtags: 30,
    maxImageBytes: 8 * 1024 * 1024,
    maxReelBytes: 300_000_000,
    maxReelDurationSeconds: 900,
    maxStoryBytes: 100_000_000,
    maxStoryDurationSeconds: 60,
    maxVideoBytes: assetVideoMaxBytes,
    minReelStoryDurationSeconds: 3,
    tokenLifetimeMaxSeconds: metaTokenLifetimeMaxSeconds,
    tokenMaxChars: OAUTH_TOKEN_MAX_CHARS,
  },
  threads: {
    maxCaptionCodePoints: 500,
    maxCarouselItems: 20,
    maxHashtags: null,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: assetVideoMaxBytes,
    maxVideoDurationSeconds: 300,
    tokenLifetimeMaxSeconds: metaTokenLifetimeMaxSeconds,
    tokenMaxChars: OAUTH_TOKEN_MAX_CHARS,
  },
  tiktok: {
    maxCaptionCodePoints: 4_000,
    maxHashtags: 30,
    maxImageBytes: 20 * 1024 * 1024,
    maxPhotoImages: 35,
    maxPhotoShortSidePx: 1_080,
    maxPhotoTitleChars: 90,
    maxVideoBytes: assetVideoMaxBytes,
    maxVideoCaptionCodePoints: 2_200,
    maxVideoDimensionPx: 4_096,
    maxVideoDurationSeconds: 600,
    minVideoDimensionPx: 360,
    tokenLifetimeMaxSeconds: tiktokTokenLifetimeMaxSeconds,
    tokenMaxChars: strictTokenMaxChars,
  },
  youtube: {
    maxCaptionCodePoints: 5_000,
    maxHashtags: 15,
    maxHashtagsJoinedChars: 500,
    maxMediaCount: 1,
    maxTitleCodePoints: 100,
    maxVideoBytes: assetVideoMaxBytes,
    maxVideoDurationSeconds: 12 * 60 * 60,
    tokenLifetimeMaxSeconds: googleTokenLifetimeMaxSeconds,
    tokenMaxChars: strictTokenMaxChars,
  },
} as const satisfies Record<Platform, Record<string, number | null>>;
