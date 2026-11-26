import {
  classifyProviderFailure,
  malformed,
  ProviderAdapterError,
  rejected,
  rejection,
} from "../failures";
import { addSeconds } from "../oauth";
import { confirmedFailure } from "../results";
import type {
  OAuthConnection,
  ProviderMedia,
  ProviderPublicationStatus,
  ProviderStreamMedia,
  PublishInput,
  YouTubePrivacyStatus,
} from "../types";
import {
  boundedString,
  boundedText,
  codePointLength,
  firstNonEmptyLine,
  metricValue,
  normalizeContentType,
  providerIdentifier,
  record,
  required,
  requireIdempotencyKey,
  secureUrl,
} from "../values";
import { YOUTUBE_LIMITS, YOUTUBE_PUBLISHING_SCOPES, youtubeWatchUrl } from "./types";

const pkcePattern = /^[A-Za-z0-9_-]{43,128}$/;
const whitespacePattern = /\s+/;
const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const handlePrefixPattern = /^@/;
const handlePattern = /^[A-Za-z0-9_.-]{1,100}$/;
const angleBracketsPattern = /[<>]/;
const uploadRangePattern = /^bytes=0-(\d+)$/;
const utf8Encoder = new TextEncoder();
const privacyStatuses = ["public", "private", "unlisted"] as const;
const lifecycleStatuses = new Set([
  "created",
  "ready",
  "testing",
  "live",
  "complete",
  "revoked",
  "testStarting",
  "liveStarting",
]);
const maxIngestChars = 2048;

interface GoogleTokenResponse<RequireRefresh extends boolean> {
  accessToken: string;
  expiresAt: string;
  refreshToken: RequireRefresh extends true ? string : string | undefined;
  scopes?: string[];
}

interface UploadInput {
  contentType: string;
  description: string;
  fileSize: number;
  madeForKids?: boolean;
  media: ProviderStreamMedia;
  privacyStatus: YouTubePrivacyStatus;
  tags: string[];
  title: string;
}

interface YouTubeLivePlan {
  description: string;
  madeForKids: boolean;
  privacyStatus: YouTubePrivacyStatus;
  title: string;
}

export function pkce(name: string, value: string): string {
  const normalized = required(name, value, 128);
  if (!pkcePattern.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function scopeSet(value: unknown): Set<string> | undefined {
  const normalized = boundedString(value, 4_096);
  if (!normalized) return undefined;
  const scopes = normalized.split(whitespacePattern);
  if (
    scopes.length > 20 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !scopePattern.test(scope))
  ) {
    return undefined;
  }
  return new Set(scopes);
}

export function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: true,
): GoogleTokenResponse<true>;
export function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: false,
): GoogleTokenResponse<false>;
export function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: boolean,
): GoogleTokenResponse<boolean> {
  const body = record(value);
  const accessToken = boundedString(body?.access_token, YOUTUBE_LIMITS.tokenMaxChars);
  const refreshToken = boundedString(body?.refresh_token, YOUTUBE_LIMITS.tokenMaxChars);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  const scopes = scopeSet(body?.scope);
  if (
    !accessToken ||
    tokenType !== "bearer" ||
    (requireRefreshToken && !refreshToken) ||
    (body?.scope !== undefined && !scopes) ||
    (scopes && YOUTUBE_PUBLISHING_SCOPES.some((scope) => !scopes.has(scope)))
  ) {
    throw malformed();
  }
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, YOUTUBE_LIMITS.tokenLifetimeMaxSeconds),
    refreshToken,
    ...(scopes ? { scopes: [...scopes] } : {}),
  };
}

function youtubeHandle(customUrl: unknown): string | undefined {
  if (typeof customUrl !== "string") return undefined;
  const normalized = customUrl.trim().replace(handlePrefixPattern, "");
  return normalized && handlePattern.test(normalized) ? normalized : undefined;
}

export function youtubeChannelAccount(value: unknown): OAuthConnection["account"] {
  const channelBody = record(value);
  if (
    !Array.isArray(channelBody?.items) ||
    channelBody.items.length !== 1 ||
    channelBody.nextPageToken !== undefined
  ) {
    throw rejected("youtube_channel_selection_required", 409);
  }
  const channel = record(channelBody.items[0]);
  const snippet = record(channel?.snippet);
  const thumbnails = record(snippet?.thumbnails);
  const thumbnail = record(thumbnails?.default);
  const id = providerIdentifier(channel?.id);
  const displayName = boundedText(snippet?.title, 500);
  const avatarUrl = thumbnail?.url === undefined ? undefined : secureUrl(thumbnail.url)?.href;
  const username = youtubeHandle(snippet?.customUrl);
  if (!id || !displayName || (thumbnail?.url !== undefined && !avatarUrl)) {
    throw malformed();
  }
  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    displayName,
    id,
    ...(username ? { username } : {}),
  };
}

export function youtubeAccountStatistics(value: unknown): { followers: number; posts?: number } {
  const items = record(value)?.items;
  if (!Array.isArray(items) || items.length !== 1) throw malformed();
  const statistics = record(record(items[0])?.statistics);
  if (statistics?.hiddenSubscriberCount === true) throw malformed();
  const followers = Number(statistics?.subscriberCount);
  const posts = Number(statistics?.videoCount);
  if (!Number.isSafeInteger(followers) || followers < 0) throw malformed();
  return {
    followers,
    ...(Number.isSafeInteger(posts) && posts >= 0 ? { posts } : {}),
  };
}

export function youtubeAnalyticsReport(
  value: unknown,
): { comments: number; likes: number; shares: number; views: number } | undefined {
  const body = record(value);
  const columnHeaders = body?.columnHeaders;
  if (!Array.isArray(columnHeaders)) throw malformed();
  const rows = body?.rows;
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows)) throw malformed();
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (rows.length !== 1 || !Array.isArray(row) || row.length !== columnHeaders.length) {
    throw malformed();
  }
  const metrics = new Map<string, number>();
  for (const [index, header] of columnHeaders.entries()) {
    const name = boundedString(record(header)?.name, 64);
    const metric = metricValue(row[index]);
    if (!name || metric === undefined || metrics.has(name)) throw malformed();
    metrics.set(name, metric);
  }
  const views = metrics.get("views");
  const likes = metrics.get("likes");
  const comments = metrics.get("comments");
  const shares = metrics.get("shares");
  if (
    views === undefined ||
    likes === undefined ||
    comments === undefined ||
    shares === undefined
  ) {
    throw malformed();
  }
  return { comments, likes, shares, views };
}

function onlyResource(value: unknown, id: string): Record<string, unknown> {
  const items = record(value)?.items;
  if (!Array.isArray(items) || items.length !== 1) throw malformed();
  const item = record(items[0]);
  if (!item || item.id !== id) throw malformed();
  return item;
}

export function youtubeLivePlan(input: PublishInput): YouTubeLivePlan {
  const options = input.providerOptions?.youtube;
  if (
    input.media.length ||
    typeof options?.madeForKids !== "boolean" ||
    !options.privacyStatus ||
    !privacyStatuses.includes(options.privacyStatus)
  ) {
    throw rejected("youtube_live_options_invalid");
  }
  const description = input.caption.trim();
  const title = required(
    "title",
    firstNonEmptyLine(description) ?? "",
    YOUTUBE_LIMITS.maxTitleCodePoints,
  );
  return {
    description,
    madeForKids: options.madeForKids,
    privacyStatus: options.privacyStatus,
    title,
  };
}

export function youtubeBroadcastRecord(
  value: unknown,
  id: string,
  expectedChannelId: string | undefined,
): { broadcast: Record<string, unknown>; lifecycle: string } {
  const broadcast = onlyResource(value, id);
  if (record(broadcast.snippet)?.channelId !== expectedChannelId) throw malformed();
  const lifecycle = record(broadcast.status)?.lifeCycleStatus;
  if (typeof lifecycle !== "string" || !lifecycleStatuses.has(lifecycle)) throw malformed();
  return { broadcast, lifecycle };
}

export function youtubeStreamIngest(
  value: unknown,
  streamId: string,
): { ingestUrl: string; streamKey: string } {
  const ingest = record(record(onlyResource(value, streamId).cdn)?.ingestionInfo);
  const ingestUrl = boundedString(ingest?.rtmpsIngestionAddress, maxIngestChars);
  const streamKey = boundedString(ingest?.streamName, maxIngestChars);
  if (
    !ingestUrl ||
    !URL.canParse(ingestUrl) ||
    new URL(ingestUrl).protocol !== "rtmps:" ||
    !streamKey
  ) {
    throw malformed();
  }
  return { ingestUrl, streamKey };
}

export function parseYouTubeUploadInput(input: PublishInput): UploadInput {
  requireIdempotencyKey(input.idempotencyKey);
  const description = input.caption.trim();
  const title = firstNonEmptyLine(description);
  const [media] = input.media;
  const metadata = media?.metadata;
  const duration = metadata?.durationSeconds;
  const width = metadata?.width;
  const height = metadata?.height;
  if (
    input.media.length !== 1 ||
    !media ||
    media.mode !== "resumable_upload" ||
    !title ||
    codePointLength(title) > YOUTUBE_LIMITS.maxTitleCodePoints ||
    utf8Encoder.encode(description).byteLength > YOUTUBE_LIMITS.maxCaptionCodePoints ||
    angleBracketsPattern.test(title) ||
    angleBracketsPattern.test(description) ||
    input.hashtags.length > YOUTUBE_LIMITS.maxHashtags ||
    input.hashtags.join(",").length > YOUTUBE_LIMITS.maxHashtagsJoinedChars ||
    duration === undefined ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > YOUTUBE_LIMITS.maxVideoDurationSeconds ||
    width === undefined ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    height === undefined ||
    !Number.isSafeInteger(height) ||
    height < 1
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "youtube_video_invalid",
        status: 400,
      }),
    );
  }
  const contentType = normalizeContentType(media.contentType);
  if (
    !["video/mp4", "video/quicktime"].includes(contentType) ||
    !Number.isSafeInteger(media.fileSize) ||
    media.fileSize < 1 ||
    media.fileSize > YOUTUBE_LIMITS.maxVideoBytes
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "youtube_media_invalid",
        status: 400,
      }),
    );
  }
  const providerOptions = input.providerOptions?.youtube;
  const privacyStatus = providerOptions?.privacyStatus ?? "public";
  if (
    providerOptions !== undefined &&
    (typeof providerOptions.madeForKids !== "boolean" ||
      !["private", "public", "unlisted"].includes(privacyStatus))
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "youtube_publish_options_invalid",
        status: 400,
      }),
    );
  }
  return {
    contentType,
    description,
    fileSize: media.fileSize,
    ...(providerOptions ? { madeForKids: providerOptions.madeForKids } : {}),
    media,
    privacyStatus,
    tags: [...input.hashtags],
    title,
  };
}

export function acknowledgedOffset(headers: Headers, fileSize: number, absent: number): number {
  const range = headers.get("Range");
  if (range === null) return absent;
  const lastByte = Number(range.match(uploadRangePattern)?.[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte + 1 > fileSize) {
    throw malformed();
  }
  return lastByte + 1;
}

export function youtubeVideoStatus(
  value: unknown,
  id: string,
  expectedChannelId: string,
  retainedOperationId: string,
): ProviderPublicationStatus {
  const body = record(value);
  if (!Array.isArray(body?.items) || body.items.length > 1 || body.nextPageToken !== undefined) {
    throw malformed();
  }
  if (body.items.length === 0) return { state: "not_found" };
  const video = record(body.items[0]);
  const snippet = record(video?.snippet);
  const status = record(video?.status);
  const processing = record(video?.processingDetails);
  const returnedId = providerIdentifier(video?.id);
  const channelId = providerIdentifier(snippet?.channelId);
  const uploadStatus = boundedString(status?.uploadStatus, 32)?.toLowerCase();
  const privacyStatus = boundedString(status?.privacyStatus, 32)?.toLowerCase();
  const processingStatus = boundedString(processing?.processingStatus, 32)?.toLowerCase();
  if (returnedId !== id || !channelId || !uploadStatus || !privacyStatus || !processingStatus) {
    throw malformed();
  }
  if (channelId !== expectedChannelId) {
    return {
      result: confirmedFailure(rejection("youtube_channel_mismatch", 409), retainedOperationId),
      state: "failed",
    };
  }
  if (["deleted", "failed", "rejected"].includes(uploadStatus) || processingStatus === "failed") {
    return {
      result: confirmedFailure(
        rejection("youtube_video_processing_failed", 422),
        retainedOperationId,
      ),
      state: "failed",
    };
  }
  if (uploadStatus === "processed" && ["succeeded", "terminated"].includes(processingStatus)) {
    if (!["private", "public", "unlisted"].includes(privacyStatus)) {
      throw malformed();
    }
    return {
      result: {
        outcome: "confirmed_success",
        providerOperationId: retainedOperationId,
        providerPostId: id,
        providerUrl: youtubeWatchUrl(id),
      },
      state: "published",
    };
  }
  return { providerOperationId: retainedOperationId, state: "processing" };
}

export function youtubeContinuationMedia(
  media: ProviderMedia,
  fileSize: number,
): { contentType: string; media: ProviderStreamMedia } | undefined {
  const contentType = normalizeContentType(media.contentType);
  if (
    media.mode === "remote_ingest" ||
    media.fileSize !== fileSize ||
    !["video/mp4", "video/quicktime"].includes(contentType)
  ) {
    return undefined;
  }
  return { contentType, media };
}
