import { confirmedFailure, isHttp404, malformed, unknownResult } from "../adapter-helpers";
import { classifyProviderFailure, isUncertainFailure, ProviderAdapterError } from "../failures";
import type { ProviderHttpResponse } from "../http";
import { IDEMPOTENCY_KEY_MAX_CHARS } from "../limits";
import {
  bearer,
  boundedString,
  codePointLength,
  firstNonEmptyLine,
  normalizeContentType,
  providerIdentifier,
  record,
  required,
} from "../meta-common";
import type {
  ProviderCredentials,
  ProviderFailure,
  ProviderMedia,
  ProviderOperationResult,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderStreamMedia,
  PublishInput,
  YouTubePrivacyStatus,
} from "../types";
import {
  YOUTUBE_API_ORIGIN,
  YOUTUBE_LIMITS,
  YOUTUBE_VIDEO_ORIGIN,
  validateSessionUri,
  youtubeAccountId,
  youtubeOperationId,
  youtubeVideoId,
  type GoogleRequest,
  type YouTubeOperation,
} from "./types";

const angleBracketsPattern = /[<>]/;
const uploadRangePattern = /^bytes=0-(\d+)$/;
const utf8Encoder = new TextEncoder();

/**
 * Coalescing threshold for small stream reads: reads below this size are copied
 * into a bounded staging slab before joining the part list, bounding the part
 * array length even for degenerate 1-byte-per-read streams.
 */
const STAGING_BUFFER_BYTES = 64 * 1024;

export interface UploadInput {
  contentType: string;
  description: string;
  fileSize: number;
  madeForKids?: boolean;
  media: ProviderStreamMedia;
  privacyStatus: YouTubePrivacyStatus;
  tags: string[];
  title: string;
}

type SessionProbe = { kind: "open"; acknowledged: number } | { kind: "complete"; videoId: string };

type UploadOutcome =
  | { failure: ProviderFailure; kind: "failed" }
  | { acknowledged: number; failure: ProviderFailure; kind: "interrupted" }
  | { id: string; kind: "complete" };

/**
 * Validates one standard YouTube video or Shorts-candidate upload against
 * title/description/tag/media/options bounds.
 */
function parseYouTubeUploadInput(input: PublishInput): UploadInput {
  required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
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

/**
 * Parses a resumable-upload `Range` response header into the acknowledged byte
 * count, falling back to `absent` when the header is missing.
 */
function acknowledgedOffset(headers: Headers, fileSize: number, absent: number): number {
  const range = headers.get("Range");
  if (range === null) return absent;
  const lastByte = Number(range.match(uploadRangePattern)?.[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte + 1 > fileSize) {
    throw malformed();
  }
  return lastByte + 1;
}

/** Narrows a byte view to the `ArrayBuffer`-backed shape `fetch` BodyInit requires. */
function isArrayBufferBacked(value: Uint8Array): value is Uint8Array<ArrayBuffer> {
  return value.buffer instanceof ArrayBuffer;
}

/**
 * Bounded stream read buffer that coalesces tiny reads into a 64 KiB staging
 * slab while passing large ArrayBuffer-backed chunks through without copying.
 * Keeps `parts.length` bounded even on degenerate 1-byte-per-read streams.
 */
class ChunkWindow {
  readonly #parts: Uint8Array<ArrayBuffer>[] = [];
  #partStart = 0;
  #buffered = 0;
  #staging: Uint8Array<ArrayBuffer> | undefined;
  #stagingUsed = 0;

  get buffered(): number {
    return this.#buffered;
  }

  append(part: Uint8Array): void {
    if (part.byteLength === 0) return;
    if (part.byteLength >= STAGING_BUFFER_BYTES) {
      this.#flushStaging();
      this.#parts.push(isArrayBufferBacked(part) ? part : part.slice());
      this.#buffered += part.byteLength;
      return;
    }
    if (!this.#staging || this.#staging.byteLength - this.#stagingUsed < part.byteLength) {
      this.#flushStaging();
      this.#staging = new Uint8Array(STAGING_BUFFER_BYTES);
      this.#stagingUsed = 0;
    }
    this.#staging.set(part, this.#stagingUsed);
    this.#stagingUsed += part.byteLength;
    this.#buffered += part.byteLength;
  }

  /** Assembles the next `chunkLength` bytes without advancing the window. */
  peek(chunkLength: number): Uint8Array<ArrayBuffer> {
    this.#flushStaging();
    const first = this.#parts[this.#partStart];
    if (!first) return new Uint8Array(0);
    if (first.byteLength >= chunkLength) {
      return first.subarray(0, chunkLength);
    }
    const assembled = new Uint8Array(chunkLength);
    let written = 0;
    for (
      let index = this.#partStart;
      index < this.#parts.length && written < chunkLength;
      index += 1
    ) {
      const part = this.#parts[index];
      if (!part) break;
      const take = Math.min(part.byteLength, chunkLength - written);
      assembled.set(part.subarray(0, take), written);
      written += take;
    }
    return assembled;
  }

  /** Drops `byteCount` acknowledged bytes from the front of the window. */
  consume(byteCount: number): void {
    this.#flushStaging();
    let remaining = byteCount;
    this.#buffered -= byteCount;
    while (remaining > 0) {
      const part = this.#parts[this.#partStart];
      if (!part) break;
      if (part.byteLength > remaining) {
        this.#parts[this.#partStart] = part.subarray(remaining);
        remaining = 0;
      } else {
        this.#partStart += 1;
        remaining -= part.byteLength;
      }
    }
    if (this.#partStart > 0) {
      this.#parts.splice(0, this.#partStart);
      this.#partStart = 0;
    }
  }

  #flushStaging(): void {
    if (this.#staging && this.#stagingUsed > 0) {
      this.#parts.push(this.#staging.subarray(0, this.#stagingUsed));
      this.#staging = undefined;
      this.#stagingUsed = 0;
    }
  }
}

export interface YouTubeResumableConfig {
  categoryId: string;
  googleRequest: GoogleRequest;
  uploadChunkBytes: number;
}

/**
 * Builds YouTube's resumable upload initiation, chunk streaming, session probe,
 * continuation, and video processing lookup handlers.
 */
export function createYouTubeResumable(config: YouTubeResumableConfig) {
  const { categoryId, googleRequest, uploadChunkBytes } = config;

  /**
   * Probes an open resumable upload session (`PUT` with `Content-Range: bytes *\/size`).
   * Shared by both in-flight chunk recovery and reconciliation lookup.
   */
  const probeSession = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    session: { fileSize: number; sessionUri: string },
    sideEffectOnVideoId: boolean,
  ): Promise<SessionProbe> => {
    const response = await googleRequest<unknown>(context, {
      acceptedStatuses: [308],
      headers: {
        ...bearer(credentials.accessToken),
        "Content-Length": "0",
        "Content-Range": `bytes */${session.fileSize}`,
      },
      method: "PUT",
      responseType: "json_or_empty",
      url: session.sessionUri,
    });
    return response.status === 308
      ? {
          acknowledged: acknowledgedOffset(response.headers, session.fileSize, 0),
          kind: "open",
        }
      : { kind: "complete", videoId: youtubeVideoId(response.body, sideEffectOnVideoId) };
  };

  /**
   * Streams the media body to a resumable session in bounded 256 KiB-aligned
   * chunks, coalescing small stream reads into 64 KiB slabs and probing the
   * session on uncertain chunk failures without resending acknowledged bytes.
   */
  const uploadBytes = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    session: { fileSize: number; sessionUri: string },
    upload: { contentType: string; media: ProviderStreamMedia },
    startOffset = 0,
  ): Promise<UploadOutcome> => {
    const interrupted = (failure: ProviderFailure, acknowledged: number): UploadOutcome => ({
      acknowledged,
      failure,
      kind: "interrupted",
    });
    const failed = (failure: ProviderFailure): UploadOutcome => ({
      failure,
      kind: "failed",
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const window = new ChunkWindow();
    let offset = startOffset;
    let skipped = 0;
    let ended = false;
    try {
      reader = upload.media.body.getReader();
      while (offset < session.fileSize) {
        while (window.buffered < uploadChunkBytes && !ended) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
          } else if (value.byteLength > 0) {
            const skip = Math.min(startOffset - skipped, value.byteLength);
            if (skip > 0) skipped += skip;
            if (skip < value.byteLength) {
              window.append(skip > 0 ? value.subarray(skip) : value);
            }
          }
        }
        const end = Math.min(offset + uploadChunkBytes, offset + window.buffered, session.fileSize);
        if (end <= offset) {
          return failed(
            classifyProviderFailure({
              code: "youtube_media_invalid",
              status: 400,
            }),
          );
        }
        const chunkLength = end - offset;
        const chunk = window.peek(chunkLength);
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
              url: session.sessionUri,
            });
          } catch (cause) {
            if (!(cause instanceof ProviderAdapterError)) throw cause;
            const failure = cause.failure;
            if (!isUncertainFailure(failure)) {
              return failure.classification === "rate_limit"
                ? interrupted(failure, start)
                : failed(failure);
            }
            resumes += 1;
            if (resumes > 3) return interrupted(failure, start);
            let probe: SessionProbe;
            try {
              probe = await probeSession(context, credentials, session, true);
            } catch (probeCause) {
              if (!(probeCause instanceof ProviderAdapterError)) throw probeCause;
              return isUncertainFailure(probeCause.failure, true)
                ? interrupted(probeCause.failure, start)
                : failed(probeCause.failure);
            }
            if (probe.kind === "complete") {
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
              acknowledged = acknowledgedOffset(response.headers, session.fileSize, start);
            } catch (rangeCause) {
              if (!(rangeCause instanceof ProviderAdapterError)) throw rangeCause;
              return interrupted(rangeCause.failure, start);
            }
            if (acknowledged < start || acknowledged > end) {
              return interrupted(
                classifyProviderFailure({
                  code: "youtube_upload_incomplete",
                  sideEffectPossible: true,
                }),
                start,
              );
            }
            if (acknowledged === start && start === offset) {
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
          return { id: youtubeVideoId(response.body, true), kind: "complete" };
        }
        window.consume(offset - chunkStart);
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
   */
  const lookupVideo = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    id: string,
    retainedOperationId: string,
  ): Promise<ProviderPublicationStatus> => {
    const url = new URL("/youtube/v3/videos", YOUTUBE_API_ORIGIN);
    url.searchParams.set("part", "id,snippet,status,processingDetails");
    url.searchParams.set("id", id);
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
    if (channelId !== youtubeAccountId(credentials)) {
      return {
        result: confirmedFailure("youtube_channel_mismatch", 409, retainedOperationId),
        state: "failed",
      };
    }
    if (["deleted", "failed", "rejected"].includes(uploadStatus) || processingStatus === "failed") {
      return {
        result: confirmedFailure("youtube_video_processing_failed", 422, retainedOperationId),
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
          providerUrl: `${YOUTUBE_VIDEO_ORIGIN}/${encodeURIComponent(id)}`,
        },
        state: "published",
      };
    }
    return { providerOperationId: retainedOperationId, state: "processing" };
  };

  /**
   * Continues an open resumable upload session inside reconciliation using
   * replayed Asset bytes without issuing a second initiation POST.
   */
  const continueSession = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: Extract<YouTubeOperation, { phase: "session" | "submitted" }>,
    media: ProviderMedia,
  ): Promise<ProviderPublicationStatus> => {
    const contentType = normalizeContentType(media.contentType);
    if (
      media.mode === "remote_ingest" ||
      media.fileSize !== operation.fileSize ||
      !["video/mp4", "video/quicktime"].includes(contentType)
    ) {
      return {
        result: confirmedFailure("youtube_media_invalid", 400, youtubeOperationId(operation)),
        state: "failed",
      };
    }
    let probe: SessionProbe;
    try {
      probe = await probeSession(context, credentials, operation, true);
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    if (probe.kind === "complete") {
      return {
        providerOperationId: youtubeOperationId({
          id: probe.videoId,
          phase: "video",
        }),
        state: "processing",
      };
    }
    const retainedAcknowledged =
      operation.phase === "submitted"
        ? Math.max(probe.acknowledged, operation.acknowledged)
        : probe.acknowledged;
    const outcome = await uploadBytes(
      context,
      credentials,
      { fileSize: operation.fileSize, sessionUri: operation.sessionUri },
      { contentType, media },
      probe.acknowledged,
    );
    if (outcome.kind === "complete") {
      return {
        providerOperationId: youtubeOperationId({
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
          youtubeOperationId({
            acknowledged: Math.max(outcome.acknowledged, retainedAcknowledged),
            fileSize: operation.fileSize,
            sessionUri: operation.sessionUri,
            phase: "submitted",
          }),
        ),
        state: "unknown",
      };
    }
    return {
      result: confirmedFailure(outcome.failure, youtubeOperationId(operation)),
      state: "failed",
    };
  };

  /**
   * Probes an open resumable upload session or delegates to `continueSession`
   * when replayable media is provided.
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
    let probe: SessionProbe;
    try {
      probe = await probeSession(context, credentials, operation, false);
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    if (probe.kind === "open") {
      const retained =
        operation.phase === "submitted" || probe.acknowledged > 0
          ? youtubeOperationId({
              acknowledged: Math.max(
                probe.acknowledged,
                operation.phase === "submitted" ? operation.acknowledged : 0,
              ),
              fileSize: operation.fileSize,
              sessionUri: operation.sessionUri,
              phase: "submitted",
            })
          : youtubeOperationId(operation);
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
    return {
      providerOperationId: youtubeOperationId({ id: probe.videoId, phase: "video" }),
      state: "processing",
    };
  };

  /** Initiates one resumable upload session and streams bounded chunks to Google. */
  const publishVideo = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    input: PublishInput,
  ): Promise<ProviderOperationResult> => {
    const upload = parseYouTubeUploadInput(input);
    const initiationUrl = new URL("/upload/youtube/v3/videos", YOUTUBE_API_ORIGIN);
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
          ...(upload.madeForKids === undefined
            ? {}
            : { selfDeclaredMadeForKids: upload.madeForKids }),
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
    const sessionUri = validateSessionUri(initiation.headers.get("Location"));
    const sessionOperation: Extract<YouTubeOperation, { phase: "session" }> = {
      fileSize: upload.fileSize,
      phase: "session",
      sessionUri,
    };
    const outcome = await uploadBytes(
      context,
      credentials,
      { fileSize: upload.fileSize, sessionUri },
      upload,
    );
    if (outcome.kind === "complete") {
      return {
        outcome: "confirmed_success",
        providerOperationId: youtubeOperationId({
          id: outcome.id,
          phase: "video",
        }),
      };
    }
    if (outcome.kind === "interrupted") {
      return unknownResult(
        outcome.failure,
        youtubeOperationId({
          acknowledged: outcome.acknowledged,
          fileSize: upload.fileSize,
          phase: "submitted",
          sessionUri,
        }),
      );
    }
    return confirmedFailure(outcome.failure, youtubeOperationId(sessionOperation));
  };

  return {
    lookupSession,
    lookupVideo,
    publishVideo,
  };
}
