import type { PlatformCapability } from "@meltiply/domain";

import { malformed, optionalLookupPostId } from "../failures";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type { ProviderAdapter, ProviderPublicationStatus } from "../types";
import { required, requireIdempotencyKey, STANDARD_VIDEO_MIME_TYPES } from "../values";
import { createYouTubeAnalytics } from "./analytics";
import { createYouTubeLive } from "./live";
import { createYouTubeOAuth } from "./oauth";
import { createYouTubeResumable } from "./resumable";
import {
  broadcastOperationId,
  googleErrorDiagnosis,
  parseBroadcastOperationId,
  parseYouTubeOperationId,
  YOUTUBE_ANALYTICS_ORIGIN,
  YOUTUBE_API_ORIGIN,
  YOUTUBE_LIMITS,
  YOUTUBE_TOKEN_ORIGIN,
  youtubeAccountId,
  youtubeOperationId,
  youtubeWatchUrl,
  type GoogleRequest,
} from "./types";

const categoryIdPattern = /^\d{1,3}$/;
const defaultCategoryId = "22";
const chunkAlignmentBytes = 256 * 1024;
const maxChunkBytes = 64 * 1024 * 1024;
const defaultChunkBytes = 8 * 1024 * 1024;

const capability: PlatformCapability = {
  accepted_mime_types: [...STANDARD_VIDEO_MIME_TYPES],
  analytics: true,
  asset_types: ["video"],
  comments: false,
  connect_available: true,
  max_caption_length: YOUTUBE_LIMITS.maxCaptionCodePoints,
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

export interface YouTubeAdapterOptions extends ProviderAdapterOptions {
  categoryId?: string;
  uploadChunkBytes?: number;
}

export function createYouTubeAdapter(options: YouTubeAdapterOptions): ProviderAdapter {
  const runtime = adapterRuntime(
    "youtube",
    [YOUTUBE_API_ORIGIN, YOUTUBE_ANALYTICS_ORIGIN, YOUTUBE_TOKEN_ORIGIN],
    options,
  );
  const categoryId = required("categoryId", options.categoryId ?? defaultCategoryId, 3);
  if (!categoryIdPattern.test(categoryId)) throw new TypeError("categoryId is invalid");
  const uploadChunkBytes = options.uploadChunkBytes ?? defaultChunkBytes;
  if (
    !Number.isSafeInteger(uploadChunkBytes) ||
    uploadChunkBytes < chunkAlignmentBytes ||
    uploadChunkBytes > maxChunkBytes ||
    uploadChunkBytes % chunkAlignmentBytes !== 0
  ) {
    throw new RangeError(
      "uploadChunkBytes must be a multiple of 256 KiB between 256 KiB and 64 MiB",
    );
  }
  const googleRequest: GoogleRequest = (context, request) =>
    runtime.http.request(context, { ...request, classifyErrorBody: googleErrorDiagnosis });
  const live = createYouTubeLive(googleRequest, runtime.now);
  const oauth = createYouTubeOAuth(runtime, googleRequest);
  const analytics = createYouTubeAnalytics(googleRequest, runtime.now);
  const resumable = createYouTubeResumable({ categoryId, googleRequest, uploadChunkBytes });

  return {
    authorizationUrl: oauth.authorizationUrl,
    capability,
    exchangeAuthorizationCode: oauth.exchangeAuthorizationCode,
    getAccountAnalytics: analytics.getAccountAnalytics,
    listAnalytics: analytics.listAnalytics,
    getBroadcastInfo: live.info,
    endBroadcast: live.end,

    continuesResumableUpload(providerOperationId) {
      const phase = parseYouTubeOperationId(providerOperationId)?.phase;
      return phase === "session" || phase === "submitted";
    },

    async lookupPublication(context, credentials, lookup): Promise<ProviderPublicationStatus> {
      youtubeAccountId(credentials);
      const broadcast = parseBroadcastOperationId(lookup.providerOperationId);
      if (broadcast?.phase === "ended_live") {
        return {
          state: "published",
          result: {
            outcome: "confirmed_success",
            providerOperationId: broadcastOperationId({ id: broadcast.id, phase: "ended_live" }),
            providerPostId: broadcast.id,
            providerUrl: youtubeWatchUrl(broadcast.id),
          },
        };
      }
      if (broadcast) {
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
      const providerPostId = optionalLookupPostId(lookup.providerPostId);
      const operation = parseYouTubeOperationId(lookup.providerOperationId);
      if (lookup.providerOperationId && !operation) throw malformed();
      if (providerPostId) {
        if (operation?.phase === "video" && operation.id !== providerPostId) throw malformed();
        return resumable.lookupVideo(
          context,
          credentials,
          providerPostId,
          youtubeOperationId(operation ?? { id: providerPostId, phase: "video" }),
        );
      }
      if (!operation) throw malformed();
      return operation.phase === "video"
        ? resumable.lookupVideo(context, credentials, operation.id, youtubeOperationId(operation))
        : resumable.lookupSession(context, credentials, operation, lookup.media);
    },

    async publish(context, credentials, input) {
      youtubeAccountId(credentials);
      if (input.providerOptions?.youtube?.postType === "live") {
        requireIdempotencyKey(input.idempotencyKey);
        return live.publish(context, credentials, input);
      }
      return resumable.publishVideo(context, credentials, input);
    },

    refreshAccessToken: oauth.refreshAccessToken,
    retryPolicy: { baseDelaySeconds: 30, maxAttempts: 8, maxDelaySeconds: 900 },
    transferModes: ["resumable_upload"],
  };
}
