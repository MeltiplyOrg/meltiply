import type { components } from "@meltiply/contracts/schema";

/** Matches `.`, `..`, slashes, and control characters, which no single path segment may contain. */
export const UNSAFE_PATH_SEGMENT_PATTERN = /(^\.{1,2}$)|[\\/\u0000-\u001f\u007f]/;

/** The message of a non-empty `Error`, otherwise `fallback`. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export * from "./due-work";
export * from "./capabilities";
export * from "./effect";

export const rateLimitBudgetFreshSeconds = 2 * 60 * 60;

export type PlatformCapability = components["schemas"]["PlatformCapability"];
export type Platform = components["schemas"]["Platform"];
export type AssetStatus = components["schemas"]["AssetStatus"];
export type AssetType = components["schemas"]["AssetType"];
export type DistributionStatus = components["schemas"]["DistributionStatus"];
export type Post = components["schemas"]["Post"];
export type PostStatus = components["schemas"]["PostStatus"];
export type PostAttachment = components["schemas"]["PostAttachment"];
export type PostTarget = components["schemas"]["PostTarget"];
export type ReplyStatus = components["schemas"]["ReplyStatus"];

export const PLATFORM_IDS: readonly Platform[] = [
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "threads",
];

const PLATFORM_ID_SET: ReadonlySet<string> = new Set(PLATFORM_IDS);

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORM_ID_SET.has(value);
}

/** OAuth callback path shared by Provider redirect URIs and route registration. */
export function oauthCallbackPath(platform: Platform): string {
  return `/api/v1/platforms/${platform}/callback`;
}

/** One fully disabled capability row per Platform, reported while a Provider is unconfigured. */
export function unavailableCapabilities(): PlatformCapability[] {
  return PLATFORM_IDS.map((platform) => ({
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    connect_available: false,
    max_caption_length: null,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: 0,
    multi_asset_types: [],
    notes: ["Provider configuration and live capability acceptance are pending."],
    platform,
    publish: false,
    reply: false,
  }));
}

/**
 * Minimum age before an upload no retained Post references may be reclaimed. The clock starts at
 * finalization and restarts when the last retained attachment is removed.
 */
export const assetOrphanGraceSeconds = 7 * 24 * 60 * 60;

export const ASSET_UPLOAD_POLICY = {
  maxParallelParts: 4,
  maxPartUrlBatch: 100,
  multipartPartSizeBytes: 8 * 1024 * 1024,
  multipartThresholdBytes: 25 * 1024 * 1024,
  sessionTtlSeconds: 24 * 60 * 60,
  signedUrlTtlSeconds: 15 * 60,
} as const;

/** Resource ceilings; `null` leaves that resource unrestricted. */
interface CommunityLimits {
  readonly max_distributions: number | null;
  readonly max_platforms: number | null;
  readonly max_storage_bytes: number | null;
  readonly max_uploads: number | null;
}

export const COMMUNITY_LIMITS: CommunityLimits = Object.freeze({
  max_distributions: null,
  max_platforms: null,
  max_storage_bytes: null,
  max_uploads: null,
});

export function isoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Throws `RangeError` for an unparseable value. */
export function isoDateTime(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

const mediaRules = {
  "image/gif": {
    assetType: "image",
    extensions: ["gif"],
    maximum: 25 * 1024 * 1024,
  },
  "image/jpeg": {
    assetType: "image",
    extensions: ["jpg", "jpeg"],
    maximum: 25 * 1024 * 1024,
  },
  "image/png": {
    assetType: "image",
    extensions: ["png"],
    maximum: 25 * 1024 * 1024,
  },
  "image/webp": {
    assetType: "image",
    extensions: ["webp"],
    maximum: 25 * 1024 * 1024,
  },
  "video/mp4": {
    assetType: "video",
    extensions: ["mp4"],
    maximum: 500 * 1024 * 1024,
  },
  "video/quicktime": {
    assetType: "video",
    extensions: ["mov"],
    maximum: 500 * 1024 * 1024,
  },
} as const;

type AcceptedMediaType = keyof typeof mediaRules;

export function isAcceptedMediaType(
  contentType: string | null | undefined,
): contentType is AcceptedMediaType {
  return typeof contentType === "string" && Object.hasOwn(mediaRules, contentType);
}

export function mediaUploadMaximum(contentType: string | null | undefined): number | null {
  if (!isAcceptedMediaType(contentType)) return null;
  return mediaRules[contentType].maximum;
}

export function mediaUploadExtension(contentType: string): string | null {
  if (!isAcceptedMediaType(contentType)) return null;
  return mediaRules[contentType].extensions[0];
}

export class AssetPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid_filename"
      | "payload_too_large"
      | "unsupported_media_type"
      | "validation_error",
    message: string,
  ) {
    super(message);
    this.name = "AssetPolicyError";
  }
}

interface ValidatedUpload {
  assetType: "image" | "video";
  contentType: AcceptedMediaType;
  fileSize: number;
  filename: string;
}

interface MultipartLayout {
  maxParallelParts: number;
  partCount: number;
  partSize: number;
  strategy: "multipart";
}

interface SingleLayout {
  strategy: "single";
}

/** Normalizes and checks an upload request; throws `AssetPolicyError` on any policy violation. */
export function validateUpload(input: {
  assetType: string;
  contentType: string;
  fileSize: number;
  filename: string;
}): ValidatedUpload {
  const filename = input.filename.trim();
  if (!filename || filename.length > 255 || UNSAFE_PATH_SEGMENT_PATTERN.test(filename)) {
    throw new AssetPolicyError(
      "invalid_filename",
      "filename must be a safe single path segment of at most 255 characters",
    );
  }
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize < 1) {
    throw new AssetPolicyError("validation_error", "file_size must be a positive safe integer");
  }
  const contentType = (input.contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (!isAcceptedMediaType(contentType)) {
    throw new AssetPolicyError("unsupported_media_type", "content_type is not supported");
  }
  const rule = mediaRules[contentType];
  if (input.assetType !== rule.assetType) {
    throw new AssetPolicyError("unsupported_media_type", "asset_type does not match content_type");
  }
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  if (!rule.extensions.some((accepted) => accepted === extension)) {
    throw new AssetPolicyError(
      "unsupported_media_type",
      "filename extension does not match content_type",
    );
  }
  if (input.fileSize > rule.maximum) {
    throw new AssetPolicyError(
      "payload_too_large",
      `${rule.assetType} uploads cannot exceed ${rule.maximum} bytes`,
    );
  }
  return {
    assetType: rule.assetType,
    contentType,
    fileSize: input.fileSize,
    filename,
  };
}

/** Chooses single PUT or multipart upload; throws `AssetPolicyError` past the 10,000-part object-store ceiling. */
export function uploadLayout(fileSize: number): SingleLayout | MultipartLayout {
  if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
    throw new AssetPolicyError("validation_error", "file size must be a positive safe integer");
  }
  if (fileSize <= ASSET_UPLOAD_POLICY.multipartThresholdBytes) {
    return { strategy: "single" };
  }
  const partCount = Math.ceil(fileSize / ASSET_UPLOAD_POLICY.multipartPartSizeBytes);
  if (partCount > 10_000) {
    throw new AssetPolicyError("payload_too_large", "multipart upload would exceed 10000 parts");
  }
  return {
    maxParallelParts: ASSET_UPLOAD_POLICY.maxParallelParts,
    partCount,
    partSize: ASSET_UPLOAD_POLICY.multipartPartSizeBytes,
    strategy: "multipart",
  };
}
