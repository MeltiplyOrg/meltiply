import { malformed, requiredIdentifier } from "../adapter-helpers";
import type { ProviderErrorDiagnosis, ProviderHttpRequest, ProviderHttpResponse } from "../http";
import { PROVIDER_LIMITS } from "../limits";
import { boundedString, providerIdentifier, record, secureUrl } from "../meta-common";
import type { ProviderCredentials, ProviderRequestContext } from "../types";

export const YOUTUBE_API_ORIGIN = "https://www.googleapis.com";
export const YOUTUBE_ANALYTICS_ORIGIN = "https://youtubeanalytics.googleapis.com";
export const YOUTUBE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
export const YOUTUBE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
export const YOUTUBE_VIDEO_ORIGIN = "https://youtu.be";
export const YOUTUBE_LIMITS = PROVIDER_LIMITS.youtube;

/** Leave room for both byte offsets within the Worker's 512-character operation identity limit. */
const maximumOperationIdLength = 512;
const maximumSessionUriLength =
  maximumOperationIdLength -
  `submitted:${YOUTUBE_LIMITS.maxVideoBytes}:${YOUTUBE_LIMITS.maxVideoBytes}:`.length;

const videoOperationPattern = /^video:(.+)$/;
const sessionOperationPattern = /^(session|submitted):([1-9]\d*):(?:(\d+):)?(https:\/\/.+)$/;
const invalidOperationCharactersPattern = /[\u0000-\u001f\u007f\s]/;

/** Upload and channel identity are required; Analytics access is optional. */
export const YOUTUBE_PUBLISHING_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

const analyticsScopes = ["https://www.googleapis.com/auth/yt-analytics.readonly"] as const;

export const YOUTUBE_CONFIGURED_SCOPES = [
  ...YOUTUBE_PUBLISHING_SCOPES,
  ...analyticsScopes,
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export type GoogleRequest = <T = unknown>(
  context: ProviderRequestContext,
  request: Omit<ProviderHttpRequest, "classifyErrorBody">,
) => Promise<ProviderHttpResponse<T>>;

export type YouTubeOperation =
  | { id: string; phase: "video" }
  | { fileSize: number; sessionUri: string; phase: "session" }
  | { acknowledged: number; fileSize: number; sessionUri: string; phase: "submitted" };

/** Extracts and validates the required YouTube channel identifier from credentials. */
export function youtubeAccountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "youtube_channel_required");
}

/**
 * Extracts a safe failure diagnosis from a parsed Google API error body.
 * Quota reasons map to `youtube_quota_exceeded` (non-retryable quota); per-user
 * rate reasons map to `youtube_rate_limited`. Raw payloads never leave here.
 */
export function googleErrorDiagnosis(
  _status: number,
  body: unknown,
): ProviderErrorDiagnosis | undefined {
  const errors = record(record(body)?.error)?.errors;
  if (!Array.isArray(errors)) return undefined;
  const reasons = new Set(
    errors
      .map((entry) => boundedString(record(entry)?.reason, 128))
      .filter((reason): reason is string => reason !== undefined),
  );
  if (["quotaExceeded", "dailyLimitExceeded"].some((reason) => reasons.has(reason))) {
    return { code: "youtube_quota_exceeded", quotaExceeded: true };
  }
  if (["rateLimitExceeded", "userRateLimitExceeded"].some((reason) => reasons.has(reason))) {
    return { code: "youtube_rate_limited", rateLimited: true };
  }
  return undefined;
}

/**
 * Validates Google's opaque resumable `Location` URI without reconstructing its
 * query. Returns the canonical session URI string bounded so every retained
 * offset fits inside the Worker's 512-character operation identity limit.
 */
export function validateSessionUri(value: string | null): string {
  const url = secureUrl(value);
  if (!url) throw malformed();
  const normalized = url.href;
  const ids = url.searchParams.getAll("upload_id");
  if (
    normalized.length > maximumSessionUriLength ||
    url.origin !== YOUTUBE_API_ORIGIN ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    ids.length !== 1 ||
    !ids[0]
  ) {
    throw malformed();
  }
  return normalized;
}

/**
 * Formats a durable upload identity with its phase, byte size/offset and
 * Google's complete session URI, or the final video ID.
 */
export function youtubeOperationId(operation: YouTubeOperation): string {
  return operation.phase === "video"
    ? `video:${operation.id}`
    : operation.phase === "session"
      ? `session:${operation.fileSize}:${operation.sessionUri}`
      : `submitted:${operation.fileSize}:${operation.acknowledged}:${operation.sessionUri}`;
}

/**
 * Parses a durable upload identity, validating byte bounds and the retained
 * Google session URI before any recovery request.
 */
export function parseYouTubeOperationId(value: unknown): YouTubeOperation | undefined {
  const normalized = boundedString(value, maximumOperationIdLength);
  if (!normalized || invalidOperationCharactersPattern.test(normalized)) return undefined;
  const video = normalized.match(videoOperationPattern);
  const videoId = providerIdentifier(video?.[1]);
  if (videoId) return { id: videoId, phase: "video" };
  const session = normalized.match(sessionOperationPattern);
  const rawUri = session?.[4];
  if (!session || !rawUri || (session[1] === "submitted") !== (session[3] !== undefined)) {
    return undefined;
  }
  const fileSize = Number(session[2]);
  const acknowledged = Number(session[3] ?? 0);
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize > YOUTUBE_LIMITS.maxVideoBytes ||
    !Number.isSafeInteger(acknowledged) ||
    acknowledged > fileSize
  ) {
    return undefined;
  }
  try {
    const sessionUri = validateSessionUri(rawUri);
    return session[1] === "session"
      ? { fileSize, sessionUri, phase: "session" }
      : { acknowledged, fileSize, sessionUri, phase: "submitted" };
  } catch {
    return undefined;
  }
}

/** Extracts and validates a YouTube video identifier from a videos.insert or videos.list body. */
export function youtubeVideoId(value: unknown, sideEffectPossible = false): string {
  const id = providerIdentifier(record(value)?.id);
  if (!id) throw malformed(sideEffectPossible);
  return id;
}
