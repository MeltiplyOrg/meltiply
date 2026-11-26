/** Matches `.`, `..`, slashes, and control characters, which no single path segment may contain. */
export const UNSAFE_PATH_SEGMENT_PATTERN = /(^\.{1,2}$)|[\\/\u0000-\u001f\u007f]/;

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
