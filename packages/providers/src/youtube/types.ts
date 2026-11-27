import { malformed, requiredIdentifier } from "../failures";
import type { ProviderErrorDiagnosis, ProviderHttpRequest, ProviderHttpResponse } from "../http";
import { PROVIDER_LIMITS } from "../limits";
import type { ProviderCredentials, ProviderRequestContext } from "../types";
import { boundedString, providerIdentifier, record, secureUrl } from "../values";

export const YOUTUBE_API_ORIGIN = "https://www.googleapis.com";
export const YOUTUBE_ANALYTICS_ORIGIN = "https://youtubeanalytics.googleapis.com";
export const YOUTUBE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
export const YOUTUBE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";

const maximumOperationIdLength = 512;
const maximumSessionUriLength =
  maximumOperationIdLength -
  `submitted:${PROVIDER_LIMITS.youtube.maxVideoBytes}:${PROVIDER_LIMITS.youtube.maxVideoBytes}:`
    .length;

const videoOperationPattern = /^video:(.+)$/;
const broadcastOperationPattern = /^(live|ended_live):(.+)$/;
const sessionOperationPattern = /^(session|submitted):([1-9]\d*):(?:(\d+):)?(https:\/\/.+)$/;
const invalidOperationCharactersPattern = /[\u0000-\u001f\u007f\s]/;

/** Upload and channel identity are required to connect; the remaining scopes are optional. */
export const YOUTUBE_PUBLISHING_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const YOUTUBE_CONFIGURED_SCOPES = [
  ...YOUTUBE_PUBLISHING_SCOPES,
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export type GoogleRequest = (
  context: ProviderRequestContext,
  request: Omit<ProviderHttpRequest, "classifyErrorBody">,
) => Promise<ProviderHttpResponse>;

export type YouTubeOperation =
  | { id: string; phase: "video" }
  | { fileSize: number; sessionUri: string; phase: "session" }
  | { acknowledged: number; fileSize: number; sessionUri: string; phase: "submitted" };

export function youtubeAccountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "youtube_channel_required");
}

export function youtubeWatchUrl(id: string): string {
  return `https://youtu.be/${encodeURIComponent(id)}`;
}

/** Google 403s carry quota and rate-limit reasons that must not classify as auth failures. */
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

/** Google's resumable `Location` URI is opaque; it is validated, never reconstructed. */
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

export function youtubeOperationId(operation: YouTubeOperation): string {
  return operation.phase === "video"
    ? `video:${operation.id}`
    : operation.phase === "session"
      ? `session:${operation.fileSize}:${operation.sessionUri}`
      : `submitted:${operation.fileSize}:${operation.acknowledged}:${operation.sessionUri}`;
}

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
    fileSize > PROVIDER_LIMITS.youtube.maxVideoBytes ||
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

export function youtubeVideoId(value: unknown, sideEffectPossible = false): string {
  const id = providerIdentifier(record(value)?.id);
  if (!id) throw malformed(sideEffectPossible);
  return id;
}

/** `live:` is an open broadcast; `ended_live:` is the terminal identity kept after it ends. */
export interface BroadcastOperation {
  id: string;
  phase: "live" | "ended_live";
}

export function broadcastOperationId(operation: BroadcastOperation): string {
  return `${operation.phase}:${operation.id}`;
}

export function parseBroadcastOperationId(value: unknown): BroadcastOperation | undefined {
  const match = typeof value === "string" ? value.trim().match(broadcastOperationPattern) : null;
  const id = providerIdentifier(match?.[2]);
  const phase = match?.[1];
  return id && (phase === "live" || phase === "ended_live") ? { id, phase } : undefined;
}
