import type { components } from "@meltiply/contracts/schema";

/** Pattern rejecting empty, traversal (`.` / `..`), slash, and control characters in path segments. */
export const UNSAFE_PATH_SEGMENT_PATTERN = /(^\.{1,2}$)|[\\/\u0000-\u001f\u007f]/;

/**
 * Extracts a usable message from an unknown thrown value, falling back to `fallback`.
 *
 * @param cause - Thrown or rejected value.
 * @param fallback - Message returned when `cause` is not an `Error` with a non-empty message.
 * @returns Non-empty error message string.
 */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export {
  analyticsTerminalAgeSeconds,
  demandDrivenCommentsAgeSeconds,
  maximumDelayedDeliverySeconds,
  overdueRecoveryGraceSeconds,
} from "./due-work";
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

/**
 * Domain errors — thrown by persistence and service modules to express
 * domain-meaningful failures without coupling to HTTP semantics. The route
 * layer (or any caller) maps these to transport codes; the persistence layer
 * never mentions HTTP.
 */

export type DomainErrorCode = "active_organization_required" | "service_unavailable";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class AccessDenied extends DomainError {
  constructor(message = "Access denied.") {
    super("active_organization_required", message);
    this.name = "AccessDenied";
  }
}

export class StorageUnavailable extends DomainError {
  constructor(message = "Storage is unavailable.") {
    super("service_unavailable", message);
    this.name = "StorageUnavailable";
  }
}

export const PLATFORM_IDS: readonly Platform[] = [
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "threads",
] as const;

const PLATFORM_ID_SET: ReadonlySet<string> = new Set(PLATFORM_IDS);

/**
 * Narrows an untrusted value to a supported Meltiply Platform identifier.
 *
 * @param value - Untrusted candidate platform identifier.
 * @returns True when `value` is a member of `PLATFORM_IDS`.
 */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORM_ID_SET.has(value);
}

/**
 * Construct the OAuth callback path for a Platform. This is the canonical
 * source of the callback URL shape — providers and route registration both
 * derive from this rather than hard-coding it.
 *
 * @param platform - Target social media platform identifier.
 * @returns Relative URL callback path (e.g. "/api/v1/platforms/tiktok/callback").
 */
export function oauthCallbackPath(platform: Platform): string {
  return `/api/v1/platforms/${platform}/callback`;
}

/**
 * Constructs fallback PlatformCapability descriptors for all supported platforms
 * with publishing, connection, analytics, and comments disabled.
 * Used when provider adapters are unconfigured or live capability acceptance is pending.
 *
 * @returns List of default unconfigured PlatformCapability objects for each canonical platform.
 */
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
 * How long a completed upload with no retained Post attachment stays eligible
 * for reclamation — seven elapsed days. The clock starts at upload
 * finalization and restarts when the last retained attachment is removed, so a
 * recently detached older upload is not reclaimed immediately. Saved drafts and
 * retained scheduled or published Posts hold their attachments indefinitely;
 * this grace only governs media no retained Post references. Reclamation also
 * requires no live processing, Provider retrieval, retry, or Reconciliation
 * hold, so the deadline is an eligibility floor rather than an exact promise.
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

/** Optional resource ceilings; `null` leaves that resource unrestricted. */
export interface CommunityLimits {
  readonly max_distributions: number | null;
  readonly max_platforms: number | null;
  readonly max_storage_bytes: number | null;
  readonly max_uploads: number | null;
}

/**
 * Community deployments impose no resource quotas; `null` leaves that resource unrestricted.
 */
export const COMMUNITY_LIMITS: CommunityLimits = Object.freeze({
  max_distributions: null,
  max_platforms: null,
  max_storage_bytes: null,
  max_uploads: null,
});

/**
 * Normalizes a Date or date string to ISO-8601 UTC, returning null for nullish or invalid values.
 *
 * @param value - Date instance, date string, or null/undefined.
 * @returns ISO-8601 UTC string, or null when missing or unparseable.
 */
export function isoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Normalize database and runtime timestamps to the API's canonical ISO form.
 *
 * @param value - Date instance or ISO-compatible date string.
 * @returns Standardized ISO-8601 UTC timestamp string.
 */
export function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

export type AcceptedMediaType = keyof typeof mediaRules;

/**
 * Narrows a MIME type string to an accepted media rule key using own-property lookup.
 *
 * @param contentType - Candidate MIME type string.
 * @returns True when `contentType` is an accepted upload media type.
 */
export function isAcceptedMediaType(
  contentType: string | null | undefined,
): contentType is AcceptedMediaType {
  return typeof contentType === "string" && Object.hasOwn(mediaRules, contentType);
}

/**
 * Returns the per-file upload ceiling in bytes for one accepted media MIME
 * type (25 MiB for images, 500 MiB for video), or null when unsupported.
 *
 * @param contentType - Declared media MIME type; unvalidated input returns null.
 * @returns The maximum byte ceiling, or null for an unknown media type.
 */
export function mediaUploadMaximum(contentType: string | null | undefined): number | null {
  if (!isAcceptedMediaType(contentType)) return null;
  return mediaRules[contentType].maximum;
}

/**
 * Resolves the canonical upload extension for an accepted media MIME type.
 *
 * @param contentType - Declared media MIME type.
 * @returns Canonical extension without leading dot, or null for an unknown type.
 */
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

export interface ValidatedUpload {
  assetType: "image" | "video";
  contentType: AcceptedMediaType;
  fileSize: number;
  filename: string;
}

export interface MultipartLayout {
  maxParallelParts: number;
  partCount: number;
  partSize: number;
  strategy: "multipart";
}

export interface SingleLayout {
  strategy: "single";
}

/**
 * Validates upload parameters against canonical media MIME, extension, and file size policies.
 * Ensures filename is a safe single path segment (<= 255 chars without path traversals or control chars),
 * fileSize is a positive safe integer within the media rule's ceiling, and extension matches content type.
 *
 * @param input - Raw upload parameters (assetType, contentType, fileSize, filename).
 * @returns ValidatedUpload descriptor with normalized assetType and contentType.
 * @throws {AssetPolicyError} If filename, media type, size, or extension violates asset policy.
 */
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
  const normalizedType = (input.contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (!isAcceptedMediaType(normalizedType)) {
    throw new AssetPolicyError("unsupported_media_type", "content_type is not supported");
  }
  const contentType = normalizedType;
  const rule = mediaRules[contentType];
  if (input.assetType !== rule.assetType) {
    throw new AssetPolicyError("unsupported_media_type", "asset_type does not match content_type");
  }
  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (!(rule.extensions as readonly string[]).includes(extension)) {
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

/**
 * Determines whether an asset upload should proceed as a direct single PUT or an R2 multipart upload session.
 * Files up to 25 MiB use single PUT; larger files use 8 MiB multipart parts up to a 10,000 part ceiling.
 *
 * @param fileSize - Total asset file size in bytes (positive safe integer).
 * @returns SingleLayout or MultipartLayout descriptor including partCount and partSize.
 * @throws {AssetPolicyError} If fileSize is invalid or would exceed the 10,000 multipart parts ceiling.
 */
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
