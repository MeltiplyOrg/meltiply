import type { Platform } from "@meltiply/domain";

/** Shared Meltiply upload ceiling across video-capable platforms (500 MiB). */
const PLATFORM_VIDEO_MAX_BYTES = 500 * 1024 * 1024;

/** Maximum character length accepted for opaque OAuth access/refresh tokens. */
export const OAUTH_TOKEN_MAX_CHARS = 16_384;

/** Maximum character length for Meta long-lived/page token strings and Google/TikTok tokens. */
const OAUTH_STRICT_TOKEN_MAX_CHARS = 16_000;

/** Maximum character length for Meta/TikTok/YouTube idempotency keys. */
export const IDEMPOTENCY_KEY_MAX_CHARS = 255;

/** Maximum character length for OAuth state parameters. */
export const OAUTH_STATE_MAX_CHARS = 1_024;

/** Maximum lifetime in seconds for Meta long-lived OAuth tokens (90 days). */
const META_TOKEN_LIFETIME_MAX_SECONDS = 90 * 24 * 60 * 60;

/** Maximum lifetime in seconds for TikTok OAuth access tokens (48 hours). */
const TIKTOK_TOKEN_LIFETIME_MAX_SECONDS = 2 * 24 * 60 * 60;

/** Maximum lifetime in seconds for Google OAuth access tokens (24 hours). */
const GOOGLE_TOKEN_LIFETIME_MAX_SECONDS = 24 * 60 * 60;

/** Shared Meta Graph API version for Facebook and Instagram endpoints. */
export const META_GRAPH_API_VERSION = "v25.0";

/** Platform-specific content, media, and token ceilings owned in one place. */
export const PROVIDER_LIMITS = {
  facebook: {
    maxCaptionCodePoints: null,
    maxHashtags: null,
    maxImageBytes: 10_000_000,
    maxMediaCount: null,
    maxReelDurationSeconds: 90,
    maxStoryDurationSeconds: 60,
    maxVideoBytes: PLATFORM_VIDEO_MAX_BYTES,
    minReelStoryDurationSeconds: 3,
    tokenLifetimeMaxSeconds: META_TOKEN_LIFETIME_MAX_SECONDS,
    tokenMaxChars: OAUTH_STRICT_TOKEN_MAX_CHARS,
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
    maxVideoBytes: PLATFORM_VIDEO_MAX_BYTES,
    minReelStoryDurationSeconds: 3,
    tokenLifetimeMaxSeconds: META_TOKEN_LIFETIME_MAX_SECONDS,
    tokenMaxChars: OAUTH_TOKEN_MAX_CHARS,
  },
  threads: {
    maxCaptionCodePoints: 500,
    maxCarouselItems: 20,
    maxHashtags: null,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: PLATFORM_VIDEO_MAX_BYTES,
    maxVideoDurationSeconds: 300,
    tokenLifetimeMaxSeconds: META_TOKEN_LIFETIME_MAX_SECONDS,
    tokenMaxChars: OAUTH_TOKEN_MAX_CHARS,
  },
  tiktok: {
    maxCaptionCodePoints: 4_000,
    maxHashtags: 30,
    maxImageBytes: 20 * 1024 * 1024,
    maxPhotoImages: 35,
    maxPhotoShortSidePx: 1_080,
    maxPhotoTitleChars: 90,
    maxVideoBytes: PLATFORM_VIDEO_MAX_BYTES,
    maxVideoCaptionCodePoints: 2_200,
    maxVideoDimensionPx: 4_096,
    maxVideoDurationSeconds: 600,
    minVideoDimensionPx: 360,
    tokenLifetimeMaxSeconds: TIKTOK_TOKEN_LIFETIME_MAX_SECONDS,
    tokenMaxChars: OAUTH_STRICT_TOKEN_MAX_CHARS,
  },
  youtube: {
    maxCaptionCodePoints: 5_000,
    maxHashtags: 15,
    maxHashtagsJoinedChars: 500,
    maxMediaCount: 1,
    maxTitleCodePoints: 100,
    maxVideoBytes: PLATFORM_VIDEO_MAX_BYTES,
    maxVideoDurationSeconds: 12 * 60 * 60,
    tokenLifetimeMaxSeconds: GOOGLE_TOKEN_LIFETIME_MAX_SECONDS,
    tokenMaxChars: OAUTH_STRICT_TOKEN_MAX_CHARS,
  },
} as const satisfies Record<Platform, Record<string, number | null>>;
