import type { PlatformCapability } from "@meltiply/domain";

import { malformed } from "./adapter-helpers";
import { ProviderHttpClient, type ProviderHttpRequest, type ProviderHttpResponse } from "./http";
import { IDEMPOTENCY_KEY_MAX_CHARS } from "./limits";
import { exactRedirectUri, providerIdentifier, required } from "./meta-common";
import { extractRateLimitBudget } from "./rate-limit";
import type { ProviderAdapter, ProviderRequestContext } from "./types";
import { createYouTubeAnalytics } from "./youtube/analytics";
import { createYouTubeOAuth } from "./youtube/oauth";
import { createYouTubeResumable } from "./youtube/resumable";
import {
  YOUTUBE_ANALYTICS_ORIGIN,
  YOUTUBE_API_ORIGIN,
  YOUTUBE_LIMITS,
  YOUTUBE_TOKEN_ORIGIN,
  YOUTUBE_VIDEO_ORIGIN,
  googleErrorDiagnosis,
  parseYouTubeOperationId,
  youtubeAccountId,
  youtubeOperationId,
} from "./youtube/types";
import { youtubeLive } from "./youtube-live";

const categoryIdPattern = /^\d{1,3}$/;

/** YouTube's description ceiling remains known even before live publishing is configured. */
export const YOUTUBE_MAX_CAPTION_LENGTH = YOUTUBE_LIMITS.maxCaptionCodePoints;

const capability: PlatformCapability = {
  accepted_mime_types: ["video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["video"],
  comments: false,
  connect_available: true,
  max_caption_length: YOUTUBE_MAX_CAPTION_LENGTH,
  max_file_size: YOUTUBE_LIMITS.maxVideoBytes,
  max_hashtags: YOUTUBE_LIMITS.maxHashtags,
  max_media_count: YOUTUBE_LIMITS.maxMediaCount,
  max_video_duration_sec: YOUTUBE_LIMITS.maxVideoDurationSeconds,
  min_media_count: 1,
  multi_asset_types: [],
  notes: [
    "Standard videos and Shorts share YouTube's resumable video-upload API; YouTube determines Shorts eligibility.",
    "One video publishes one upload, with a maximum duration of 12 hours; unverified channels may have lower account limits.",
    "MP4 or MOV media uses YouTube's resumable upload protocol without Worker buffering; Meltiply's Asset upload ceiling is 500 MiB.",
    "Meltiply uses the first non-empty caption line as the title and category 22 by default.",
    "Live uses a separate stream/broadcast/bind workflow with an external RTMPS encoder; it never uploads a queued Asset as a live stream.",
    "Live controls require renewed youtube.force-ssl consent and an eligible channel; encoder credentials are writer-only, on-demand, and never persisted.",
    "Analytics reads lifetime views, likes, comments, and shares from the YouTube Analytics API for the uploaded video.",
    "Existing connections must reconnect to grant the yt-analytics.readonly scope.",
    "Comments, replies, and deletion are not claimed.",
    "Google verification, YouTube API audit, quota, and live-channel acceptance remain required.",
  ],
  platform: "youtube",
  publish: true,
  reply: false,
};

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
 * Instantiates a ProviderAdapter for YouTube video and Shorts publishing via resumable uploads.
 * Handles OAuth 2.0 with PKCE, Google API quota error mapping, stream piping, and status polling.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createYouTubeAdapter(options: YouTubeAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const categoryId = required("categoryId", options.categoryId ?? "22", 3);
  if (!categoryIdPattern.test(categoryId)) {
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
    allowedOrigins: [YOUTUBE_API_ORIGIN, YOUTUBE_ANALYTICS_ORIGIN, YOUTUBE_TOKEN_ORIGIN],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    platform: "youtube",
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  const googleRequest = <T = unknown>(
    context: ProviderRequestContext,
    request: Omit<ProviderHttpRequest, "classifyErrorBody">,
  ): Promise<ProviderHttpResponse<T>> =>
    http.request<T>(context, {
      ...request,
      classifyErrorBody: googleErrorDiagnosis,
    });

  const live = youtubeLive(googleRequest, now);
  const oauth = createYouTubeOAuth({
    clientId,
    clientSecret,
    configuredRedirectUri,
    googleRequest,
    http,
    now,
  });
  const analytics = createYouTubeAnalytics(googleRequest, now);
  const resumable = createYouTubeResumable({
    categoryId,
    googleRequest,
    uploadChunkBytes,
  });

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("youtube", headers),
    authorizationUrl: oauth.authorizationUrl,
    capability,
    exchangeAuthorizationCode: oauth.exchangeAuthorizationCode,
    getAccountAnalytics: analytics.getAccountAnalytics,
    listAnalytics: analytics.listAnalytics,
    getBroadcastInfo: live.info,
    endBroadcast: live.end,

    /**
     * Declares the continuation seam for this adapter: true only when the
     * retained operation identity parses to an open resumable upload session
     * (`session:` or `submitted:`). Generic callers resolve replayable Asset
     * media only for accepted identities; `video:` operations and every other
     * lookup stay on the read-only status path.
     */
    continuesResumableUpload(providerOperationId) {
      const operation = parseYouTubeOperationId(providerOperationId);
      return (
        operation !== undefined &&
        (operation.phase === "session" || operation.phase === "submitted")
      );
    },

    /**
     * Reconciles a YouTube publication's remote state across live broadcasts,
     * completed uploads (`video:`), and open resumable upload sessions
     * (`session:` / `submitted:`).
     */
    async lookupPublication(context, credentials, lookup) {
      youtubeAccountId(credentials);
      const broadcast = live.operation(lookup.providerOperationId);
      if (broadcast) {
        if (broadcast.ended) {
          return {
            state: "published",
            result: {
              outcome: "confirmed_success",
              providerOperationId: `ended_live:${broadcast.id}`,
              providerPostId: broadcast.id,
              providerUrl: `${YOUTUBE_VIDEO_ORIGIN}/${encodeURIComponent(broadcast.id)}`,
            },
          };
        }
        const info = await live.info(context, credentials, lookup);
        return info.providerPostId
          ? {
              state: "published",
              result: {
                outcome: "confirmed_success",
                providerOperationId: lookup.providerOperationId,
                providerPostId: info.providerPostId,
                ...(info.providerUrl ? { providerUrl: info.providerUrl } : {}),
              },
            }
          : {
              state: "delivered",
              result: {
                outcome: "confirmed_success",
                delivery: "broadcast",
                providerOperationId: lookup.providerOperationId,
              },
            };
      }
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      const operation = parseYouTubeOperationId(lookup.providerOperationId);
      if (lookup.providerOperationId && !operation) throw malformed();
      if (providerPostId) {
        if (operation?.phase === "video" && operation.id !== providerPostId) {
          throw malformed();
        }
        return resumable.lookupVideo(
          context,
          credentials,
          providerPostId,
          operation
            ? youtubeOperationId(operation)
            : youtubeOperationId({ id: providerPostId, phase: "video" }),
        );
      }
      if (!operation) throw malformed();
      return operation.phase === "video"
        ? resumable.lookupVideo(context, credentials, operation.id, youtubeOperationId(operation))
        : resumable.lookupSession(context, credentials, operation, lookup.media);
    },

    /**
     * Publishes a live broadcast handoff or a validated video/Shorts upload
     * through YouTube's resumable upload protocol.
     */
    async publish(context, credentials, input) {
      youtubeAccountId(credentials);
      if (input.providerOptions?.youtube?.postType === "live") {
        required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
        return live.publish(context, credentials, input);
      }
      return resumable.publishVideo(context, credentials, input);
    },

    refreshAccessToken: oauth.refreshAccessToken,

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 8,
      maxDelaySeconds: 900,
    },

    transferModes: ["resumable_upload"],
  };
}
