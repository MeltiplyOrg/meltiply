import type { PlatformCapability } from "@meltiply/domain";
import { extractRateLimitBudget } from "./rate-limit";

import {
  addSeconds,
  confirmedFailure,
  isHttp404,
  malformed,
  requiredIdentifier,
  unknownResult,
} from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import {
  type ProviderErrorDiagnosis,
  ProviderHttpClient,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
} from "./http";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedString,
  boundedText,
  exactRedirectUri,
  metricValue,
  providerIdentifier,
  record,
  required,
  secureUrl,
  validatePageInput,
} from "./meta-common";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderFailure,
  ProviderMedia,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderStreamMedia,
  ProviderTokenSet,
  PublishInput,
  YouTubePrivacyStatus,
} from "./types";

const apiOrigin = "https://www.googleapis.com";
const analyticsOrigin = "https://youtubeanalytics.googleapis.com";
const tokenOrigin = "https://oauth2.googleapis.com";
const authorizationOrigin = "https://accounts.google.com";
const videoOrigin = "https://www.youtube.com";
const videoMaximumBytes = 500 * 1024 * 1024;
const tokenLifetimeMaximumSeconds = 24 * 60 * 60;

const configuredScopes = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
] as const;

/** YouTube's description ceiling remains known even before live publishing is configured. */
export const YOUTUBE_MAX_CAPTION_LENGTH = 5_000;

const capability: PlatformCapability = {
  accepted_mime_types: ["video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["video"],
  comments: false,
  connect_available: true,
  max_caption_length: YOUTUBE_MAX_CAPTION_LENGTH,
  max_file_size: videoMaximumBytes,
  max_hashtags: 15,
  max_media_count: 1,
  max_video_duration_sec: 180,
  min_media_count: 1,
  multi_asset_types: [],
  notes: [
    "Square or vertical videos up to three minutes are uploaded as YouTube Shorts candidates.",
    "One video publishes one upload; playlists and multi-video posts are not supported.",
    "MP4 or MOV media uses YouTube's resumable upload protocol without Worker buffering.",
    "Meltiply uses the first non-empty caption line as the title and category 22 by default.",
    "Analytics reads lifetime views, likes, comments, and shares from the YouTube Analytics API for the uploaded video.",
    "Existing connections must reconnect to grant the yt-analytics.readonly scope.",
    "Comments, replies, and deletion are not claimed.",
    "Google verification, YouTube API audit, quota, and live-channel acceptance remain required.",
  ],
  platform: "youtube",
  publish: true,
  reply: false,
};

type YouTubeOperation =
  | { id: string; phase: "video" }
  | { fileSize: number; id: string; phase: "session" }
  | { acknowledged: number; fileSize: number; id: string; phase: "submitted" };

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

export interface YouTubeAdapterOptions {
  categoryId?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
  /**
   * Resumable upload chunk size in bytes. Must be a positive multiple of
   * 256 KiB (Google's chunk-alignment requirement) and at most 64 MiB so each
   * chunk PUT fits inside the shared HTTP client's bounded timeout.
   * Defaults to 8 MiB.
   */
  uploadChunkBytes?: number;
}

/**
 * Extracts and validates the required YouTube channel identifier from credentials.
 * Returns the channel ID string. Throws ProviderAdapterError if absent or malformed.
 */
function accountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "youtube_channel_required");
}

/**
 * Validates a PKCE code_verifier or code_challenge parameter string according to RFC 7636.
 * Enforces unreserved URL-safe characters with length between 43 and 128 characters.
 * Returns the validated PKCE parameter string. Throws TypeError if invalid.
 */
function pkce(name: string, value: string): string {
  const normalized = required(name, value, 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

/**
 * Parses whitespace-delimited OAuth scope tokens, including Google's non-URL
 * OpenID grants combined by incremental authorization. Bounds length and unique count.
 * Returns a Set of scope tokens, or undefined if absent or malformed.
 */
function scopeSet(value: unknown): Set<string> | undefined {
  const normalized = boundedString(value, 4_096);
  if (!normalized) return undefined;
  const scopes = normalized.split(/\s+/);
  if (
    scopes.length > 20 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))
  ) {
    return undefined;
  }
  return new Set(scopes);
}

/**
 * Parses and verifies an OAuth 2.0 token response from Google's token endpoint.
 * Validates bearer token type, presence of required scopes, and expiration bounds (up to 24h).
 * Returns `{ accessToken, expiresAt, refreshToken? }` descriptor. Throws ProviderAdapterError if invalid.
 */
function tokenBody(
  value: unknown,
  now: Date,
  requireRefreshToken: boolean,
): {
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
} {
  const body = record(value);
  const accessToken = boundedString(body?.access_token, 16_000);
  const refreshToken = boundedString(body?.refresh_token, 16_000);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  const scopes = scopeSet(body?.scope);
  if (
    !accessToken ||
    tokenType !== "bearer" ||
    (requireRefreshToken && !refreshToken) ||
    (body?.scope !== undefined && !scopes) ||
    (scopes && configuredScopes.some((scope) => !scopes.has(scope)))
  ) {
    throw malformed();
  }
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, tokenLifetimeMaximumSeconds),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/**
 * Formats a composite YouTube operation identifier reflecting upload phase, file size,
 * acknowledged byte offset (for submitted sessions), and session/video ID.
 * Produces strings such as 'video:dQw4w9WgXcQ', 'session:10485760:upload_id_123',
 * or 'submitted:10485760:524288:upload_id_123'.
 * Returns formatted operation identifier string.
 */
function operationId(operation: YouTubeOperation): string {
  return operation.phase === "video"
    ? `video:${operation.id}`
    : operation.phase === "session"
      ? `session:${operation.fileSize}:${operation.id}`
      : `submitted:${operation.fileSize}:${operation.acknowledged}:${operation.id}`;
}

/**
 * Parses a composite YouTube operation identifier string into its structured YouTubeOperation representation.
 * Validates phase discriminator ('video', 'session', 'submitted'), byte size, acknowledged offset
 * (bounded by file size), and identifier characters.
 * Returns structured YouTubeOperation descriptor, or undefined if malformed.
 */
function parseOperationId(value: unknown): YouTubeOperation | undefined {
  const normalized = providerIdentifier(value);
  if (!normalized) return undefined;
  const video = normalized.match(/^video:(.+)$/);
  const videoId = providerIdentifier(video?.[1]);
  if (videoId) return { id: videoId, phase: "video" };
  const session = normalized.match(/^session:([1-9]\d*):(.+)$/);
  if (session) {
    const fileSize = Number(session[1]);
    const id = providerIdentifier(session[2]);
    return Number.isSafeInteger(fileSize) && fileSize <= videoMaximumBytes && id
      ? { fileSize, id, phase: "session" }
      : undefined;
  }
  const submitted = normalized.match(/^submitted:([1-9]\d*):(\d+):(.+)$/);
  const fileSize = Number(submitted?.[1]);
  const acknowledged = Number(submitted?.[2]);
  const id = providerIdentifier(submitted?.[3]);
  return submitted &&
    Number.isSafeInteger(fileSize) &&
    fileSize <= videoMaximumBytes &&
    Number.isSafeInteger(acknowledged) &&
    acknowledged <= fileSize &&
    id
    ? { acknowledged, fileSize, id, phase: "submitted" }
    : undefined;
}

/**
 * Parses and validates the resumable upload session Location header returned by YouTube video insert initiation.
 * Verifies exact Googleapis origin, `/upload/youtube/v3/videos` path, and expected query parameters.
 * Returns `{ id, url }` with canonical resumable upload URL. Throws ProviderAdapterError if malformed.
 */
function sessionLocation(value: string | null): {
  id: string;
  url: string;
} {
  const normalized = secureUrl(value);
  if (!normalized) throw malformed();
  const url = new URL(normalized);
  const keys = [...url.searchParams.keys()].sort();
  const id = providerIdentifier(url.searchParams.get("upload_id"));
  if (
    url.origin !== apiOrigin ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    keys.join(",") !== "part,uploadType,upload_id" ||
    url.searchParams.get("uploadType") !== "resumable" ||
    url.searchParams.get("part") !== "snippet,status" ||
    !id ||
    id.length > 180
  ) {
    throw malformed();
  }
  const canonical = new URL("/upload/youtube/v3/videos", apiOrigin);
  canonical.searchParams.set("uploadType", "resumable");
  canonical.searchParams.set("upload_id", id);
  canonical.searchParams.set("part", "snippet,status");
  return { id, url: canonical.toString() };
}

/**
 * Extracts a legitimate YouTube channel handle from snippet.customUrl.
 * Trims leading @ and verifies non-empty handle characters without path separators.
 */
function youtubeHandle(customUrl: unknown): string | undefined {
  if (typeof customUrl !== "string") return undefined;
  const normalized = customUrl.trim().replace(/^@/, "");
  return normalized && /^[A-Za-z0-9_.-]{1,100}$/.test(normalized) ? normalized : undefined;
}

/**
 * Generates the canonical resumable upload session URL on www.googleapis.com for an upload ID.
 * Appends uploadType=resumable and part=snippet,status query parameters.
 * Returns full URL string.
 */
function sessionUrl(id: string): string {
  const url = new URL("/upload/youtube/v3/videos", apiOrigin);
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("upload_id", id);
  url.searchParams.set("part", "snippet,status");
  return url.toString();
}

/**
 * Validates publication input for a YouTube Shorts candidate video upload.
 * YouTube uploads exactly one video per post, so a post carrying zero or
 * multiple attachments fails closed rather than silently uploading only the
 * first. Enforces vertical/square aspect ratio (width <= height), duration
 * <= 180s, description <= 5000 bytes, title <= 100 characters (free of HTML
 * `<>`), hashtag count <= 15, and valid MP4/MOV MIME types.
 * When `providerOptions.youtube` is present, `madeForKids` must be a boolean and
 * `privacyStatus` must be one of "private", "public", or "unlisted"; an omitted
 * `privacyStatus` defaults to "public".
 * @param input - Composed caption plus the Post's ordered attachments.
 * @returns Typed UploadInput record for the single resumable upload.
 * @throws ProviderAdapterError on validation failure.
 */
function uploadInput(input: PublishInput): UploadInput {
  required("idempotencyKey", input.idempotencyKey, 255);
  const description = input.caption.trim();
  const title = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const [media] = input.media;
  const metadata = media?.metadata;
  if (
    input.media.length !== 1 ||
    !media ||
    media.mode !== "resumable_upload" ||
    !title ||
    [...title].length > 100 ||
    new TextEncoder().encode(description).byteLength > 5_000 ||
    /[<>]/.test(title) ||
    /[<>]/.test(description) ||
    input.hashtags.length > 15 ||
    input.hashtags.join(",").length > 500 ||
    !metadata ||
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds! <= 0 ||
    metadata.durationSeconds! > 180 ||
    !Number.isSafeInteger(metadata.width) ||
    metadata.width! < 1 ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.height! < 1 ||
    metadata.width! > metadata.height!
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "youtube_short_invalid",
        status: 400,
      }),
    );
  }
  const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
  if (
    !["video/mp4", "video/quicktime"].includes(contentType) ||
    !Number.isSafeInteger(media.fileSize) ||
    media.fileSize < 1 ||
    media.fileSize > videoMaximumBytes
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

/**
 * Extracts a safe failure diagnosis from a parsed Google API error body.
 * Reads only the documented `error.errors[].reason` strings: quota reasons map to
 * `youtube_quota_exceeded` (non-retryable quota, distinct from auth), per-user rate
 * reasons map to `youtube_rate_limited`, and every other body yields no diagnosis so
 * the HTTP status classification stands. The raw body is never retained or embedded.
 * Returns a ProviderErrorDiagnosis, or undefined when no recognized reason is present.
 */
function googleErrorDiagnosis(_status: number, body: unknown): ProviderErrorDiagnosis | undefined {
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
 * Parses a resumable-upload `Range` response header into the acknowledged byte count.
 * Accepts only Google's `bytes=0-N` shape bounded by the declared file size; a missing
 * header yields `absent` (0 for status probes, the PUT's own start offset for chunk
 * acknowledgements — a 308 without Range confirms nothing beyond the request start,
 * so the chunk end must never be assumed received).
 */
function acknowledgedOffset(headers: Headers, fileSize: number, absent: number): number {
  const range = headers.get("Range");
  if (range === null) return absent;
  const lastByte = Number(range.match(/^bytes=0-(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte + 1 > fileSize) {
    throw malformed();
  }
  return lastByte + 1;
}

/**
 * Extracts and validates a YouTube video identifier from a videos.insert or videos.list API response.
 * Returns validated YouTube video ID string. Throws ProviderAdapterError if missing or malformed.
 */
function videoId(value: unknown, sideEffectPossible = false): string {
  const id = providerIdentifier(record(value)?.id);
  if (!id) throw malformed(sideEffectPossible);
  return id;
}

/**
 * Narrows a byte view to the `ArrayBuffer`-backed shape fetch BodyInit requires.
 * Stream chunks are typed over `ArrayBufferLike` because a view may sit on a
 * SharedArrayBuffer, which fetch cannot send; checking the backing buffer keeps
 * the common case a zero-copy view while callers copy anything else once via
 * slice(). Returns true when `value` is backed by a real ArrayBuffer.
 */
function isArrayBufferBacked(value: Uint8Array): value is Uint8Array<ArrayBuffer> {
  return value.buffer instanceof ArrayBuffer;
}

/**
 * Instantiates a ProviderAdapter for YouTube video and Shorts publishing via resumable uploads.
 * Handles OAuth 2.0 with PKCE, Google API quota error mapping, stream piping, and status polling.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createYouTubeAdapter(options: YouTubeAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const categoryId = required("categoryId", options.categoryId ?? "22", 3);
  if (!/^\d{1,3}$/.test(categoryId)) {
    throw new TypeError("categoryId is invalid");
  }
  const now = options.now ?? (() => new Date());
  const uploadChunkBytes = options.uploadChunkBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(uploadChunkBytes) ||
    uploadChunkBytes < 256 * 1024 ||
    uploadChunkBytes > 64 * 1024 * 1024 ||
    uploadChunkBytes % (256 * 1024) !== 0
  ) {
    throw new RangeError(
      "uploadChunkBytes must be a multiple of 256 KiB between 256 KiB and 64 MiB",
    );
  }
  const http = new ProviderHttpClient({
    allowedOrigins: [apiOrigin, analyticsOrigin, tokenOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    rateLimitBudget: (headers) => extractRateLimitBudget("youtube", headers),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  /**
   * Issues a Google API request through the shared bounded client with YouTube's
   * error-body diagnosis attached, so a 403 carrying a documented quota or
   * rate-limit reason classifies correctly instead of collapsing into 'auth'.
   * Returns the typed ProviderHttpResponse. Throws ProviderAdapterError on failure.
   */
  const googleRequest = <T>(
    context: ProviderRequestContext,
    request: Omit<ProviderHttpRequest, "classifyErrorBody">,
  ): Promise<ProviderHttpResponse<T>> =>
    http.request<T>(context, {
      ...request,
      classifyErrorBody: googleErrorDiagnosis,
    });

  /**
   * Queries a resumable upload session for Google's acknowledged byte offset.
   * Sends the protocol status probe (`Content-Range: bytes *\/size`); a 308 yields
   * the acknowledged offset from the returned Range header (0 when absent), and a
   * 2xx means the upload already completed and produced a video id.
   * Returns `{ acknowledged }` or `{ videoId }`. Throws ProviderAdapterError on failure.
   */
  const querySession = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    session: { fileSize: number; id: string },
  ): Promise<{ acknowledged: number } | { videoId: string }> => {
    const response = await googleRequest<unknown>(context, {
      acceptedStatuses: [308],
      headers: {
        ...bearer(credentials.accessToken),
        "Content-Length": "0",
        "Content-Range": `bytes */${session.fileSize}`,
      },
      method: "PUT",
      responseType: "json_or_empty",
      url: sessionUrl(session.id),
    });
    return response.status === 308
      ? {
          acknowledged: acknowledgedOffset(response.headers, session.fileSize, 0),
        }
      : { videoId: videoId(response.body, true) };
  };

  /**
   * Streams the media body to a resumable session as bounded, 256 KiB-aligned chunks.
   * Each chunk is a PUT with `Content-Range` sized to fit the shared client's bounded
   * timeout; resumability, not an unbounded request, is the reliability mechanism.
   * `startOffset` lets a reconciled session resume mid-stream: the first
   * `startOffset` stream bytes are skipped without copying so acknowledged bytes
   * are never resent. Stream bytes accumulate as a bounded part list — each read
   * appends one entry and chunk assembly copies only the bytes that chunk needs —
   * so fragmented streams never re-copy the accumulated prefix per read.
   * On a transient/timeout/ambiguous chunk failure the session is queried once per
   * resume cycle and the upload resumes exactly after Google's acknowledged Range —
   * acknowledged bytes are never resent. A 308 without a Range header acknowledges
   * only the PUT's own start offset; a 308 reporting no new progress counts as a
   * resume cycle, and each chunk permits at most three cycles before the upload
   * reports an interrupted outcome carrying the last acknowledged offset in the
   * operation identity.
   * Returns 'complete' with the video id, 'interrupted' with the failure and last
   * acknowledged offset, or 'failed' with a confirmed failure.
   */
  const uploadBytes = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    session: { fileSize: number; id: string; url: string },
    upload: { contentType: string; media: ProviderStreamMedia },
    startOffset = 0,
  ): Promise<
    | { failure: ProviderFailure; kind: "failed" }
    | { acknowledged: number; failure: ProviderFailure; kind: "interrupted" }
    | { id: string; kind: "complete" }
  > => {
    const interrupted = (failure: ProviderFailure, acknowledged: number) => ({
      acknowledged,
      failure,
      kind: "interrupted" as const,
    });
    const failed = (failure: ProviderFailure) => ({
      failure,
      kind: "failed" as const,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // `parts` holds buffered stream bytes beginning at absolute offset `offset`,
    // kept `ArrayBuffer`-backed because fetch BodyInit rejects views on any
    // other buffer; `partStart` is the index of its first live entry so
    // consumption never reindexes the array, `buffered` is the live byte total,
    // and `skipped` counts bytes discarded to reach `startOffset`. Stream byte
    // i is absolute offset i, so the next read always delivers position
    // `offset + buffered`.
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let partStart = 0;
    let buffered = 0;
    let offset = startOffset;
    let skipped = 0;
    let ended = false;
    try {
      reader = upload.media.body.getReader();
      while (offset < session.fileSize) {
        while (buffered < uploadChunkBytes && !ended) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
          } else if (value.byteLength > 0) {
            // Resume skips already-acknowledged stream bytes without copying.
            const skip = Math.min(startOffset - skipped, value.byteLength);
            if (skip > 0) skipped += skip;
            if (skip < value.byteLength) {
              const part = value.subarray(skip);
              // A non-ArrayBuffer-backed chunk is copied once; anything else
              // stays a zero-copy view into the stream's own buffer.
              parts.push(isArrayBufferBacked(part) ? part : part.slice());
              buffered += value.byteLength - skip;
            }
          }
        }
        const end = Math.min(offset + uploadChunkBytes, offset + buffered, session.fileSize);
        if (end <= offset) {
          return failed(
            classifyProviderFailure({
              code: "youtube_media_invalid",
              status: 400,
            }),
          );
        }
        const chunkLength = end - offset;
        // A single part covering the whole chunk is sent as a zero-copy view;
        // otherwise exactly the chunk bytes are assembled once.
        let chunk = parts[partStart]!.subarray(0, chunkLength);
        if (parts[partStart]!.byteLength < chunkLength) {
          const assembled = new Uint8Array(chunkLength);
          let written = 0;
          for (let index = partStart; index < parts.length; index += 1) {
            if (written >= chunkLength) break;
            const part = parts[index]!;
            const take = Math.min(part.byteLength, chunkLength - written);
            assembled.set(part.subarray(0, take), written);
            written += take;
          }
          chunk = assembled;
        }
        const chunkStart = offset;
        let start = offset;
        let resumes = 0;
        while (true) {
          let response: ProviderHttpResponse<unknown>;
          try {
            response = await googleRequest<unknown>(context, {
              acceptedStatuses: [308],
              body: chunk.subarray(start - chunkStart),
              headers: {
                ...bearer(credentials.accessToken),
                "Content-Length": String(end - start),
                "Content-Range": `bytes ${start}-${end - 1}/${session.fileSize}`,
                "Content-Type": upload.contentType,
              },
              method: "PUT",
              responseType: "json_or_empty",
              sideEffectPossible: true,
              url: session.url,
            });
          } catch (cause) {
            if (!(cause instanceof ProviderAdapterError)) throw cause;
            const failure = cause.failure;
            if (
              failure.classification !== "ambiguous" &&
              failure.classification !== "timeout" &&
              failure.classification !== "transient"
            ) {
              return failure.classification === "rate_limit"
                ? interrupted(failure, start)
                : failed(failure);
            }
            resumes += 1;
            if (resumes > 3) return interrupted(failure, start);
            let probe: { acknowledged: number } | { videoId: string };
            try {
              probe = await querySession(context, credentials, session);
            } catch (probeCause) {
              if (!(probeCause instanceof ProviderAdapterError)) {
                throw probeCause;
              }
              const probeFailure = probeCause.failure;
              if (
                probeFailure.classification === "ambiguous" ||
                probeFailure.classification === "timeout" ||
                probeFailure.classification === "transient" ||
                probeFailure.classification === "rate_limit"
              ) {
                return interrupted(probeFailure, start);
              }
              return failed(probeFailure);
            }
            if ("videoId" in probe) {
              return { id: probe.videoId, kind: "complete" };
            }
            if (probe.acknowledged < start) {
              return interrupted(
                classifyProviderFailure({
                  code: "youtube_upload_incomplete",
                  sideEffectPossible: true,
                }),
                start,
              );
            }
            if (probe.acknowledged >= end) {
              offset = end;
              break;
            }
            if (probe.acknowledged > start) start = probe.acknowledged;
            continue;
          }
          if (response.status === 308) {
            let acknowledged: number;
            try {
              // A missing Range acknowledges nothing beyond this PUT's start:
              // the chunk start is retained, never the chunk end.
              acknowledged = acknowledgedOffset(response.headers, session.fileSize, start);
            } catch (rangeCause) {
              if (!(rangeCause instanceof ProviderAdapterError)) {
                throw rangeCause;
              }
              return interrupted(rangeCause.failure, start);
            }
            if (acknowledged < start || acknowledged > end) {
              // Google reported fewer bytes than this PUT already sent, or more
              // than it could have received; the session state is inconsistent,
              // so stop rather than resend bytes the buffer no longer holds.
              return interrupted(
                classifyProviderFailure({
                  code: "youtube_upload_incomplete",
                  sideEffectPossible: true,
                }),
                start,
              );
            }
            if (acknowledged === start && start === offset) {
              // A 308 confirming no new bytes is a stalled cycle, not progress;
              // bound it like a resume cycle so a pathological session cannot
              // loop forever on unacknowledged re-sends.
              resumes += 1;
              if (resumes > 3) {
                return interrupted(
                  classifyProviderFailure({
                    code: "youtube_upload_incomplete",
                    sideEffectPossible: true,
                  }),
                  start,
                );
              }
              continue;
            }
            offset = acknowledged;
            break;
          }
          return { id: videoId(response.body, true), kind: "complete" };
        }
        // Drop the acknowledged prefix of the part list; `offset - chunkStart`
        // is bounded by `buffered` because acknowledged <= end <= offset+buffered.
        let consumed = offset - chunkStart;
        buffered -= consumed;
        while (consumed > 0) {
          const part = parts[partStart]!;
          if (part.byteLength > consumed) {
            parts[partStart] = part.subarray(consumed);
            consumed = 0;
          } else {
            partStart += 1;
            consumed -= part.byteLength;
          }
        }
        // Dead prefix entries are dropped in one splice so the part list stays
        // bounded by the live window instead of reindexing on every chunk.
        if (partStart > 0) {
          parts.splice(0, partStart);
          partStart = 0;
        }
      }
      return interrupted(
        classifyProviderFailure({
          code: "youtube_upload_incomplete",
          sideEffectPossible: true,
        }),
        offset,
      );
    } catch (cause) {
      if (cause instanceof ProviderAdapterError) {
        return interrupted(cause.failure, offset);
      }
      return failed(
        classifyProviderFailure({
          code: "youtube_media_unreadable",
          status: 400,
        }),
      );
    } finally {
      try {
        await reader?.cancel();
      } catch {
        // The media stream is already unusable; preserve the upload outcome.
      }
    }
  };

  /**
   * Polls a completed upload's video processing state through `videos.list`.
   * A 404 or empty items list is `not_found`; a channel mismatch or a failed
   * upload/processing status is a confirmed failure; a processed video with a
   * valid privacy status is `published` carrying the retained operation
   * identity and the canonical Shorts URL; anything else stays `processing`.
   * Returns the ProviderPublicationStatus. Throws ProviderAdapterError on
   * malformed responses or transport failures.
   */
  const lookupVideo = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    id: string,
    retainedOperationId: string,
  ): Promise<ProviderPublicationStatus> => {
    const url = new URL("/youtube/v3/videos", apiOrigin);
    url.searchParams.set("part", "id,snippet,status,processingDetails");
    url.searchParams.set("id", id);
    url.searchParams.set("maxResults", "1");
    let response;
    try {
      response = await googleRequest<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    const body = record(response.body);
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
    if (channelId !== accountId(credentials)) {
      return {
        result: confirmedFailure("youtube_channel_mismatch", 409, retainedOperationId),
        state: "failed",
      };
    }
    if (
      ["deleted", "failed", "rejected"].includes(uploadStatus) ||
      ["failed", "terminated"].includes(processingStatus)
    ) {
      return {
        result: confirmedFailure("youtube_video_processing_failed", 422, retainedOperationId),
        state: "failed",
      };
    }
    if (uploadStatus === "processed" && processingStatus === "succeeded") {
      if (!["private", "public", "unlisted"].includes(privacyStatus)) {
        throw malformed();
      }
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId: retainedOperationId,
          providerPostId: id,
          providerUrl: `${videoOrigin}/shorts/${encodeURIComponent(id)}`,
        },
        state: "published",
      };
    }
    return { providerOperationId: retainedOperationId, state: "processing" };
  };

  /**
   * Continues an open resumable upload session inside reconciliation using
   * replayed Asset media — the only path that can finish a persisted
   * `session:`/`submitted:` operation without a second initiation POST.
   * The media must be a replayable byte stream whose declared size and MIME
   * type match the persisted session; a mismatch is a confirmed failure
   * because resuming with different bytes would corrupt the upload. The
   * session is probed once for Google's authoritative acknowledged offset,
   * then `uploadBytes` resumes exactly after it: acknowledged bytes are never
   * resent and the retained identity never moves backward.
   * Returns 'processing' with the video identity on completion, 'unknown'
   * carrying the refreshed `submitted:` identity when interrupted, 'failed'
   * on confirmed failures, or 'not_found' when the session expired.
   */
  const continueSession = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: Extract<YouTubeOperation, { phase: "session" | "submitted" }>,
    media: ProviderMedia,
  ): Promise<ProviderPublicationStatus> => {
    const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
    if (
      media.mode === "remote_ingest" ||
      media.fileSize !== operation.fileSize ||
      !["video/mp4", "video/quicktime"].includes(contentType)
    ) {
      return {
        result: confirmedFailure("youtube_media_invalid", 400, operationId(operation)),
        state: "failed",
      };
    }
    let probe: { acknowledged: number } | { videoId: string };
    try {
      probe = await querySession(context, credentials, operation);
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    if ("videoId" in probe) {
      return {
        providerOperationId: operationId({
          id: probe.videoId,
          phase: "video",
        }),
        state: "processing",
      };
    }
    // Resume from Google's authoritative offset; the persisted acknowledgement
    // is only the identity floor so retained evidence never regresses.
    const retainedAcknowledged =
      operation.phase === "submitted"
        ? Math.max(probe.acknowledged, operation.acknowledged)
        : probe.acknowledged;
    const outcome = await uploadBytes(
      context,
      credentials,
      {
        fileSize: operation.fileSize,
        id: operation.id,
        url: sessionUrl(operation.id),
      },
      { contentType, media },
      probe.acknowledged,
    );
    if (outcome.kind === "complete") {
      return {
        providerOperationId: operationId({
          id: outcome.id,
          phase: "video",
        }),
        state: "processing",
      };
    }
    if (outcome.kind === "interrupted") {
      return {
        result: unknownResult(
          outcome.failure,
          operationId({
            acknowledged: Math.max(outcome.acknowledged, retainedAcknowledged),
            fileSize: operation.fileSize,
            id: operation.id,
            phase: "submitted",
          }),
        ),
        state: "unknown",
      };
    }
    return {
      result: {
        failure: outcome.failure,
        outcome: "confirmed_failure",
        providerOperationId: operationId(operation),
      },
      state: "failed",
    };
  };

  /**
   * Probes an open resumable upload session for Google's acknowledged byte offset.
   * A 308 keeps the operation `unknown` with the retained identity refreshed to
   * the acknowledged floor (never backward); a 2xx promotes the session to the
   * `video:` identity in `processing`; a 404 is `not_found`. When `media` is
   * supplied the lookup delegates to `continueSession` instead, so a reconciled
   * session can finish uploading rather than stall until expiry.
   * Returns the ProviderPublicationStatus. Throws ProviderAdapterError on
   * malformed responses or transport failures.
   */
  const lookupSession = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: Extract<YouTubeOperation, { phase: "session" | "submitted" }>,
    media?: ProviderMedia,
  ): Promise<ProviderPublicationStatus> => {
    if (media !== undefined) {
      return continueSession(context, credentials, operation, media);
    }
    let response;
    try {
      response = await googleRequest<unknown>(context, {
        acceptedStatuses: [308],
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Length": "0",
          "Content-Range": `bytes */${operation.fileSize}`,
        },
        method: "PUT",
        responseType: "json_or_empty",
        url: sessionUrl(operation.id),
      });
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    if (response.status === 308) {
      // The session is still open. Refresh the retained operation identity with
      // Google's acknowledged offset so reconciliation evidence never moves
      // backward; a session-phase identity stays 'session' until bytes are
      // confirmed received.
      const acknowledged = acknowledgedOffset(response.headers, operation.fileSize, 0);
      const retained =
        operation.phase === "submitted" || acknowledged > 0
          ? operationId({
              acknowledged: Math.max(
                acknowledged,
                operation.phase === "submitted" ? operation.acknowledged : 0,
              ),
              fileSize: operation.fileSize,
              id: operation.id,
              phase: "submitted",
            })
          : operationId(operation);
      return {
        result: unknownResult(
          classifyProviderFailure({
            code: "youtube_upload_incomplete",
            sideEffectPossible: true,
          }),
          retained,
        ),
        state: "unknown",
      };
    }
    const id = videoId(response.body);
    return {
      providerOperationId: operationId({ id, phase: "video" }),
      state: "processing",
    };
  };

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("youtube", headers),
    /**
     * Builds the Google OAuth v2 authorization URL with offline access, PKCE S256
     * challenge, incremental grants, account selection and consent prompts, and the
     * configured redirect URI, scopes, and state. Throws TypeError if the redirect
     * URI does not match the adapter configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL("/o/oauth2/v2/auth", authorizationOrigin);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("code_challenge", pkce("codeChallenge", input.codeChallenge));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent select_account");
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", configuredScopes.join(" "));
      url.searchParams.set("state", required("state", input.state, 1_024));
      return url.toString();
    },

    capability,

    /**
     * Exchanges a PKCE authorization code for Google tokens and binds the
     * connection to exactly one YouTube channel. The redirect URI must match
     * the adapter configuration; the token response must be a bearer grant
     * carrying the configured scopes and a refresh token; the channels.list
     * `mine` lookup must return exactly one channel — zero or several is a
     * deterministic `youtube_channel_selection_required` failure so the
     * account is never bound ambiguously.
     * Returns the OAuthConnection with access/refresh tokens, expiry, scopes,
     * and the channel's id, display name, and avatar.
     */
    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: required("authorizationCode", input.code),
        code_verifier: pkce("codeVerifier", input.codeVerifier),
        grant_type: "authorization_code",
        redirect_uri: configuredRedirectUri,
      });
      const tokenResponse = await http.request<unknown>(context, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${tokenOrigin}/token`,
      });
      const tokens = tokenBody(tokenResponse.body, now(), true);
      const channelUrl = new URL("/youtube/v3/channels", apiOrigin);
      channelUrl.searchParams.set("part", "id,snippet");
      channelUrl.searchParams.set("mine", "true");
      channelUrl.searchParams.set("maxResults", "2");
      const channelResponse = await googleRequest<unknown>(context, {
        headers: bearer(tokens.accessToken),
        method: "GET",
        url: channelUrl.toString(),
      });
      const channelBody = record(channelResponse.body);
      if (
        !Array.isArray(channelBody?.items) ||
        channelBody.items.length !== 1 ||
        channelBody.nextPageToken !== undefined
      ) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "youtube_channel_selection_required",
            status: 409,
          }),
        );
      }
      const channel = record(channelBody.items[0]);
      const snippet = record(channel?.snippet);
      const thumbnails = record(snippet?.thumbnails);
      const thumbnail = record(thumbnails?.default);
      const id = providerIdentifier(channel?.id);
      const displayName = boundedText(snippet?.title, 500);
      const avatarUrl = thumbnail?.url === undefined ? undefined : secureUrl(thumbnail.url);
      const username = youtubeHandle(snippet?.customUrl);
      if (!id || !displayName || (thumbnail?.url !== undefined && !avatarUrl)) {
        throw malformed();
      }
      return {
        accessToken: tokens.accessToken,
        account: {
          ...(avatarUrl ? { avatarUrl } : {}),
          displayName,
          id,
          ...(username ? { username } : {}),
        },
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken!,
        scopes: [...configuredScopes],
      };
    },

    /**
     * Reads lifetime views, likes, comments, and shares for one uploaded video
     * from the YouTube Analytics API.
     *
     * The report filters to the connected channel and the publication's video
     * id with no time dimension, so the API returns one aggregate row. An empty
     * report means YouTube has not published analytics for the video yet; no
     * snapshot is invented. Every requested metric must be present because a
     * partial row would misstate the video's lifetime totals.
     *
     * @param context - Provider request context carrying cancellation.
     * @param credentials - Connected channel token and channel identity.
     * @param lookup - Publication whose providerPostId names the video.
     * @param page - Single-report input; Analytics reports are not paginated here.
     * @returns One analytics record, or an empty page when the report has no rows.
     * @throws {ProviderAdapterError} On a rejected scope/quota, malformed report,
     *   or a missing requested metric.
     */
    /**
     * Reads the authenticated channel's lifetime subscriber and video counters.
     * Hidden subscriber counts are rejected so the chart never invents a value.
     */
    async getAccountAnalytics(context, credentials) {
      const url = new URL("/youtube/v3/channels", apiOrigin);
      url.searchParams.set("part", "statistics");
      url.searchParams.set("mine", "true");
      const response = await googleRequest<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      const items = body?.items;
      if (!Array.isArray(items) || items.length !== 1) throw malformed();
      const statistics = record(record(items[0])?.statistics);
      if (statistics?.hiddenSubscriberCount === true) throw malformed();
      const followers = Number(statistics?.subscriberCount);
      const posts = Number(statistics?.videoCount);
      if (!Number.isSafeInteger(followers) || followers < 0) throw malformed();
      return {
        followers,
        ...(Number.isSafeInteger(posts) && posts >= 0 ? { posts } : {}),
        recordedAt: now().toISOString(),
      };
    },

    async listAnalytics(context, credentials, lookup, page) {
      validatePageInput("youtube", page);
      if (page.cursor) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "youtube_analytics_not_paginated",
            status: 400,
          }),
        );
      }
      const providerPostId = requiredIdentifier(lookup.providerPostId, "youtube_video_id_required");
      const channelId = accountId(credentials);
      const url = new URL("/v2/reports", analyticsOrigin);
      url.searchParams.set("ids", `channel==${channelId}`);
      url.searchParams.set("startDate", "2005-02-14");
      url.searchParams.set("endDate", now().toISOString().slice(0, 10));
      url.searchParams.set("metrics", "views,likes,comments,shares");
      url.searchParams.set("filters", `video==${providerPostId}`);
      const response = await googleRequest<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      const columnHeaders = body?.columnHeaders;
      if (!Array.isArray(columnHeaders)) throw malformed();
      const rows = body?.rows;
      // The Analytics API omits `rows` when no data exists for the query but
      // still returns the requested column metadata.
      if (rows === undefined) return { items: [] };
      if (!Array.isArray(rows)) throw malformed();
      if (rows.length === 0) return { items: [] };
      const row = rows[0];
      if (rows.length !== 1 || !Array.isArray(row) || row.length !== columnHeaders.length) {
        throw malformed();
      }
      const metrics = new Map<string, number>();
      for (const [index, value] of columnHeaders.entries()) {
        const name = boundedString(record(value)?.name, 64);
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
      return {
        items: [
          {
            comments,
            impressions: 0,
            likes,
            providerPostId,
            recordedAt: now().toISOString(),
            reach: 0,
            shares,
            views,
            watchTimeSeconds: 0,
          },
        ],
      };
    },

    /**
     * Declares the continuation seam for this adapter: true only when the
     * retained operation identity parses to an open resumable upload session
     * (`session:` or `submitted:`). Generic callers resolve replayable Asset
     * media only for accepted identities; `video:` operations and every other
     * lookup stay on the read-only status path.
     */
    continuesResumableUpload(providerOperationId) {
      const operation = parseOperationId(providerOperationId);
      return (
        operation !== undefined &&
        (operation.phase === "session" || operation.phase === "submitted")
      );
    },

    /**
     * Reconciles a YouTube publication's remote state. A `video:` operation or
     * bare post id polls processing through `lookupVideo`; an open upload
     * session probes Google's acknowledged offset through `lookupSession`,
     * which continues the upload in place when `lookup.media` replays the
     * original Asset bytes — the session is never re-initiated and
     * acknowledged bytes are never resent. Malformed or contradictory
     * identifiers throw rather than guess.
     * Returns the ProviderPublicationStatus for the retained operation.
     */
    async lookupPublication(context, credentials, lookup) {
      accountId(credentials);
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      const operation = parseOperationId(lookup.providerOperationId);
      if (lookup.providerOperationId && !operation) throw malformed();
      if (providerPostId) {
        if (operation?.phase === "video" && operation.id !== providerPostId) {
          throw malformed();
        }
        return lookupVideo(
          context,
          credentials,
          providerPostId,
          operation ? operationId(operation) : operationId({ id: providerPostId, phase: "video" }),
        );
      }
      if (!operation) throw malformed();
      return operation.phase === "video"
        ? lookupVideo(context, credentials, operation.id, operationId(operation))
        : lookupSession(context, credentials, operation, lookup.media);
    },

    /**
     * Publishes a validated Shorts candidate through YouTube's resumable upload
     * protocol. One initiation POST creates the upload session (snippet, status,
     * declared length/type); `uploadBytes` then streams bounded chunks. A
     * completed upload returns `confirmed_success` with the `video:` identity;
     * an interrupted upload returns `unknown` carrying the durable `submitted:`
     * identity (file size, acknowledged offset, session id) so reconciliation
     * can resume the same session — never a second initiation; a confirmed
     * failure retains the `session:` identity.
     * Returns the ProviderOperationResult. Throws ProviderAdapterError on
     * invalid input, malformed responses, or transport failures.
     */
    async publish(context, credentials, input) {
      accountId(credentials);
      const upload = uploadInput(input);
      const initiationUrl = new URL("/upload/youtube/v3/videos", apiOrigin);
      initiationUrl.searchParams.set("uploadType", "resumable");
      initiationUrl.searchParams.set("part", "snippet,status");
      const initiation = await googleRequest<undefined>(context, {
        body: JSON.stringify({
          snippet: {
            categoryId,
            description: upload.description,
            tags: upload.tags,
            title: upload.title,
          },
          status: {
            ...(upload.madeForKids === undefined ? {} : { madeForKids: upload.madeForKids }),
            privacyStatus: upload.privacyStatus,
          },
        }),
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(upload.fileSize),
          "X-Upload-Content-Type": upload.contentType,
        },
        method: "POST",
        responseType: "empty",
        url: initiationUrl.toString(),
      });
      const session = sessionLocation(initiation.headers.get("Location"));
      const sessionOperation: Extract<YouTubeOperation, { phase: "session" }> = {
        fileSize: upload.fileSize,
        id: session.id,
        phase: "session",
      };
      const submittedOperation = (acknowledged: number) =>
        operationId({
          acknowledged,
          fileSize: upload.fileSize,
          id: session.id,
          phase: "submitted",
        });
      const outcome = await uploadBytes(
        context,
        credentials,
        { fileSize: upload.fileSize, id: session.id, url: session.url },
        upload,
      );
      if (outcome.kind === "complete") {
        return {
          outcome: "confirmed_success",
          providerOperationId: operationId({
            id: outcome.id,
            phase: "video",
          }),
        };
      }
      if (outcome.kind === "interrupted") {
        return unknownResult(outcome.failure, submittedOperation(outcome.acknowledged));
      }
      return {
        failure: outcome.failure,
        outcome: "confirmed_failure",
        providerOperationId: operationId(sessionOperation),
      };
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const currentRefreshToken = required("refreshToken", refreshToken, 16_000);
      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      });
      const response = await http.request<unknown>(context, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${tokenOrigin}/token`,
      });
      const tokens = tokenBody(response.body, now(), false);
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken ?? currentRefreshToken,
        scopes: [...configuredScopes],
      };
    },

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 8,
      maxDelaySeconds: 900,
    },

    transferModes: ["resumable_upload"],
  };
}
