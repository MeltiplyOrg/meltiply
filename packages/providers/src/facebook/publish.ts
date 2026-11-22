import {
  confirmedFailure,
  isHttp404,
  malformed,
  requiredIdentifier,
  unknownResult,
} from "../adapter-helpers";
import { resolveFacebookPostType } from "../facebook-options";
import { classifyProviderFailure, isUncertainFailure, ProviderAdapterError } from "../failures";
import type { ProviderHttpClient } from "../http";
import { IDEMPOTENCY_KEY_MAX_CHARS } from "../limits";
import {
  bearer,
  boundedString,
  firstNonEmptyLine,
  normalizeContentType,
  providerIdentifier,
  record,
  required,
  secureUrl,
} from "../meta-common";
import type {
  ProviderBroadcastInfo,
  ProviderCredentials,
  ProviderMedia,
  ProviderOperationResult,
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  ProviderRequestContext,
  PublishInput,
} from "../types";
import {
  FACEBOOK_API_VERSION,
  FACEBOOK_GRAPH_ORIGIN,
  FACEBOOK_LIMITS,
  facebookAccountId,
  facebookNativeDraft,
  facebookOperationId,
  facebookPublishedPost,
  facebookStoryPostId,
  isFacebookReelStatusFailed,
  isFacebookReelStatusPublished,
  parseFacebookOperationId,
  parseFacebookReelStatus,
  validateFacebookUploadUrl,
  type FacebookReelStatus,
} from "./types";

const liveStatuses = new Set([
  "LIVE",
  "LIVE_NOW",
  "UNPUBLISHED",
  "SCHEDULED_UNPUBLISHED",
  "SCHEDULED_LIVE",
  "PREVIEW",
  "VOD",
  "SCHEDULED_CANCELED",
]);

/**
 * Validates a single remotely ingested Reel or video Story attachment.
 * Enforces HTTPS, MP4/MOV MIME types, and Meltiply's 500 MiB Asset upload ceiling.
 */
function remoteVideoInput(input: PublishInput): {
  description: string;
  mediaUrl: string;
} {
  required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
  const description = input.caption.trim();
  const [media] = input.media;
  if (input.media.length !== 1 || !media || media.mode !== "remote_ingest") {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_reel_invalid",
        status: 400,
      }),
    );
  }
  const contentType = normalizeContentType(media.contentType);
  const mediaUrl = secureUrl(media.url)?.href;
  if (
    !["video/mp4", "video/quicktime"].includes(contentType) ||
    !Number.isSafeInteger(media.fileSize) ||
    media.fileSize < 1 ||
    media.fileSize > FACEBOOK_LIMITS.maxVideoBytes ||
    !mediaUrl
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_reel_media_invalid",
        status: 400,
      }),
    );
  }
  return { description, mediaUrl };
}

/**
 * Validates a Page photo before any upload. Applies the 10 MB image contract
 * to feed photos, slideshows, and fresh photo Stories; transfer URLs require HTTPS.
 */
function photoUrl(media: ProviderMedia): string {
  const contentType = normalizeContentType(media.contentType);
  const url = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
  if (
    !url ||
    !["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"].includes(contentType) ||
    !Number.isSafeInteger(media.fileSize) ||
    media.fileSize < 1 ||
    media.fileSize > FACEBOOK_LIMITS.maxImageBytes
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({ code: "facebook_photo_invalid", status: 400 }),
    );
  }
  return url.href;
}

/**
 * Builds the Facebook Page publishing, reconciliation, and live broadcast
 * handlers (`publish`, `lookupPublication`, `getBroadcastInfo`, `endBroadcast`).
 */
export function createFacebookPublish(http: ProviderHttpClient) {
  const getReelStatus = async (
    context: ProviderRequestContext,
    accessToken: string,
    videoId: string,
  ): Promise<FacebookReelStatus | undefined> => {
    const url = new URL(
      `/${FACEBOOK_API_VERSION}/${encodeURIComponent(videoId)}`,
      FACEBOOK_GRAPH_ORIGIN,
    );
    url.searchParams.set("fields", "id,status");
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: url.toString(),
      });
      return parseFacebookReelStatus(response.body, videoId);
    } catch (cause) {
      if (isHttp404(cause)) return undefined;
      throw cause;
    }
  };

  /**
   * Finishes a Reel or video Story exactly once, retaining the known media
   * identity on uncertain writes. Confirmed Reel drafts remain pollable until ready.
   */
  const submitFinish = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    videoId: string,
    description: string,
    kind: "reel" | "story",
    draft: boolean,
  ): Promise<ProviderOperationResult> => {
    const url = new URL(
      `/${FACEBOOK_API_VERSION}/${encodeURIComponent(facebookAccountId(credentials))}/${kind === "story" ? "video_stories" : "video_reels"}`,
      FACEBOOK_GRAPH_ORIGIN,
    );
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("upload_phase", "finish");
    if (kind === "reel") {
      url.searchParams.set("video_state", draft ? "DRAFT" : "PUBLISHED");
      if (description) url.searchParams.set("description", description);
    }
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      const body = record(response.body);
      if (body?.success !== true) throw malformed(true);
      if (kind === "story") {
        const id = facebookStoryPostId(body.post_id);
        if (!id) throw malformed(true);
        return {
          outcome: "confirmed_success",
          providerOperationId: facebookOperationId("story", videoId),
          providerPostId: id,
        };
      }
      return {
        outcome: "confirmed_success",
        providerOperationId: facebookOperationId(draft ? "reel_draft" : "finishing", videoId),
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isUncertainFailure(cause.failure)) {
        return unknownResult(
          cause.failure,
          facebookOperationId(kind === "story" ? "story" : "finish_submitted", videoId),
        );
      }
      return confirmedFailure(
        cause.failure,
        facebookOperationId(kind === "story" ? "story" : "uploaded", videoId),
      );
    }
  };

  return {
    /**
     * Reads an encoder URL on demand. Never retained in operation results or
     * publication snapshots; callers must authorize writers and disable caching.
     */
    async getBroadcastInfo(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderBroadcastInfo> {
      facebookAccountId(credentials);
      const operation = parseFacebookOperationId(lookup.providerOperationId);
      if (operation?.phase !== "live") throw malformed();
      const url = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(operation.id)}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      url.searchParams.set("fields", "id,status,secure_stream_url");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      if (facebookStoryPostId(body?.id) !== operation.id) throw malformed();
      const status = body?.status;
      if (typeof status !== "string" || !liveStatuses.has(status)) throw malformed();
      if (status === "VOD" || status === "SCHEDULED_CANCELED") {
        return {
          state: "ended",
          ...(status === "VOD"
            ? {
                providerPostId: operation.id,
                providerUrl: `https://www.facebook.com/${encodeURIComponent(operation.id)}`,
              }
            : {}),
        };
      }
      const stream = boundedString(body?.secure_stream_url, 4096);
      if (!stream || !URL.canParse(stream) || new URL(stream).protocol !== "rtmps:") {
        throw malformed();
      }
      return {
        state:
          status === "LIVE" || status === "LIVE_NOW"
            ? "live"
            : status === "PREVIEW"
              ? "testing"
              : "ready",
        ...(status === "LIVE" || status === "LIVE_NOW" ? { providerPostId: operation.id } : {}),
        ingestUrl: stream,
        providerUrl: `https://www.facebook.com/${encodeURIComponent(operation.id)}`,
      };
    },

    /** Ends the known broadcast once; uncertain responses must not create another broadcast. */
    async endBroadcast(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderOperationResult> {
      facebookAccountId(credentials);
      const operation = parseFacebookOperationId(lookup.providerOperationId);
      if (operation?.phase !== "live") throw malformed();
      const url = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(operation.id)}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      url.searchParams.set("end_live_video", "true");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      if (facebookStoryPostId(record(response.body)?.id) !== operation.id) throw malformed(true);
      const statusUrl = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(operation.id)}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      statusUrl.searchParams.set("fields", "id,status");
      const statusResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: statusUrl.toString(),
      });
      const ended = record(statusResponse.body);
      if (facebookStoryPostId(ended?.id) !== operation.id) throw malformed();
      if (ended?.status !== "VOD") {
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: facebookOperationId("ended_live", operation.id),
        };
      }
      return {
        outcome: "confirmed_success",
        providerOperationId: facebookOperationId("ended_live", operation.id),
        providerPostId: operation.id,
        providerUrl: `https://www.facebook.com/${encodeURIComponent(operation.id)}`,
      };
    },

    /**
     * Reconciles a Facebook Page publication across feed posts, native drafts,
     * Reels, videos, Stories, A/B experiments, and live broadcasts.
     */
    async lookupPublication(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderPublicationStatus> {
      const pageId = facebookAccountId(credentials);
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      const operation = parseFacebookOperationId(lookup.providerOperationId);
      if (lookup.providerOperationId && !operation) throw malformed();
      if (operation?.phase === "live" || operation?.phase === "ended_live") {
        return {
          state: "delivered",
          result: {
            outcome: "confirmed_success",
            delivery: "broadcast",
            providerOperationId: facebookOperationId(operation.phase, operation.id),
          },
        };
      }
      if (operation?.phase === "ab_test") {
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "GET",
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(operation.id)}`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        if (facebookStoryPostId(record(response.body)?.id) !== operation.id) throw malformed();
        return {
          state: "delivered",
          result: {
            outcome: "confirmed_success",
            delivery: "experiment",
            providerOperationId: facebookOperationId("ab_test", operation.id),
          },
        };
      }
      if (operation?.phase === "story") {
        const url = new URL(
          `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/stories`,
          FACEBOOK_GRAPH_ORIGIN,
        );
        url.searchParams.set("limit", "100");
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "GET",
          url: url.toString(),
        });
        const data = record(response.body)?.data;
        if (!Array.isArray(data)) throw malformed();
        for (const value of data) {
          const story = record(value);
          if (facebookStoryPostId(story?.media_id) !== operation.id) continue;
          const id = facebookStoryPostId(story?.post_id);
          if (!id || !["PUBLISHED", "ARCHIVED"].includes(String(story?.status))) throw malformed();
          const permalink = secureUrl(story?.url)?.href;
          return {
            state: "published",
            result: {
              outcome: "confirmed_success",
              providerOperationId: facebookOperationId("story", operation.id),
              providerPostId: id,
              ...(permalink ? { providerUrl: permalink } : {}),
            },
          };
        }
        return {
          state: "unknown",
          result: unknownResult(
            classifyProviderFailure({
              code: "facebook_story_evidence_pending",
              sideEffectPossible: true,
            }),
            facebookOperationId("story", operation.id),
          ),
        };
      }
      if (operation?.phase === "video" || operation?.phase === "video_draft") {
        const url = new URL(
          `/${FACEBOOK_API_VERSION}/${encodeURIComponent(operation.id)}`,
          FACEBOOK_GRAPH_ORIGIN,
        );
        url.searchParams.set("fields", "id,status");
        try {
          const response = await http.request<unknown>(context, {
            headers: bearer(credentials.accessToken),
            method: "GET",
            url: url.toString(),
          });
          const body = record(response.body);
          const status = record(body?.status)?.video_status;
          if (body?.id !== operation.id || typeof status !== "string") throw malformed();
          if (["error", "expired", "upload_failed"].includes(status)) {
            return {
              state: "failed",
              result: confirmedFailure(
                "facebook_video_processing_failed",
                422,
                facebookOperationId(operation.phase, operation.id),
              ),
            };
          }
          if (status === "ready") {
            if (operation.phase === "video_draft") {
              return {
                state: "delivered",
                result: facebookNativeDraft("video_draft", operation.id),
              };
            }
            return {
              state: "published",
              result: {
                outcome: "confirmed_success",
                providerOperationId: facebookOperationId("video", operation.id),
                providerPostId: operation.id,
                providerUrl: `https://www.facebook.com/${encodeURIComponent(operation.id)}`,
              },
            };
          }
          return {
            state: "processing",
            providerOperationId: facebookOperationId(operation.phase, operation.id),
          };
        } catch (cause) {
          if (isHttp404(cause)) return { state: "not_found" };
          throw cause;
        }
      }
      if (operation?.phase === "post" || operation?.phase === "post_draft") {
        const postId = providerPostId ?? operation.id;
        if (!postId.startsWith(`${pageId}_`)) throw malformed();
        const url = new URL(
          `/${FACEBOOK_API_VERSION}/${encodeURIComponent(postId)}`,
          FACEBOOK_GRAPH_ORIGIN,
        );
        url.searchParams.set("fields", "id,is_published");
        try {
          const response = await http.request<unknown>(context, {
            headers: bearer(credentials.accessToken),
            method: "GET",
            url: url.toString(),
          });
          const post = record(response.body);
          if (post?.id !== postId || typeof post.is_published !== "boolean") throw malformed();
          if (post.is_published)
            return { result: facebookPublishedPost(postId), state: "published" };
          if (operation.phase === "post_draft") {
            return { state: "delivered", result: facebookNativeDraft("post_draft", postId) };
          }
          return { providerOperationId: facebookOperationId("post", postId), state: "processing" };
        } catch (cause) {
          if (isHttp404(cause)) return { state: "not_found" };
          throw cause;
        }
      }
      const videoId = providerPostId ?? operation?.id;
      if (!videoId) throw malformed();
      const status = await getReelStatus(context, credentials.accessToken, videoId);
      if (!status) return { state: "not_found" };
      const retainedOperationId = operation
        ? facebookOperationId(operation.phase, operation.id)
        : facebookOperationId("finishing", videoId);
      if (isFacebookReelStatusFailed(status)) {
        return {
          result: confirmedFailure("facebook_reel_processing_failed", 422, retainedOperationId),
          state: "failed",
        };
      }
      if (isFacebookReelStatusPublished(status)) {
        return {
          result: {
            outcome: "confirmed_success",
            providerOperationId: retainedOperationId,
            providerPostId: videoId,
          },
          state: "published",
        };
      }
      if (operation?.phase === "reel_draft") {
        return status.video === "ready"
          ? { state: "delivered", result: facebookNativeDraft("reel_draft", videoId) }
          : { state: "processing", providerOperationId: retainedOperationId };
      }
      if (operation && operation.phase !== "finishing") {
        return {
          result: unknownResult(
            classifyProviderFailure({
              code:
                operation.phase === "finish_submitted"
                  ? "facebook_finish_evidence_pending"
                  : "facebook_upload_evidence_pending",
              sideEffectPossible: true,
            }),
            retainedOperationId,
          ),
          state: "unknown",
        };
      }
      return { providerOperationId: retainedOperationId, state: "processing" };
    },

    /**
     * Dispatches one Facebook Page publication across feed, photo/video Story,
     * Reel, standard video, slideshow, crosspost, A/B test, or live broadcast.
     */
    async publish(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      input: PublishInput,
    ): Promise<ProviderOperationResult> {
      const pageId = facebookAccountId(credentials);
      const draft = input.providerOptions?.facebook?.deliveryMode === "draft";
      required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
      const postType = resolveFacebookPostType(
        input.providerOptions?.facebook,
        input.media.map((media) =>
          media.contentType.startsWith("image/")
            ? "image"
            : media.contentType.startsWith("video/")
              ? "video"
              : null,
        ),
      );
      if (!postType) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "facebook_post_options_invalid",
            status: 400,
          }),
        );
      }
      if (postType === "story" && (input.caption.trim() || input.hashtags.length)) {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "facebook_story_caption_unsupported", status: 400 }),
        );
      }
      if (postType === "live") {
        const description = input.caption.trim();
        const response = await http.request<unknown>(context, {
          body: JSON.stringify({
            status: "LIVE_NOW",
            title: firstNonEmptyLine(description) ?? "",
            description,
          }),
          headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
          method: "POST",
          sideEffectPossible: true,
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/live_videos`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        const id = facebookStoryPostId(record(response.body)?.id);
        if (!id) throw malformed(true);
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: facebookOperationId("live", id),
        };
      }
      if (postType === "ab_test") {
        const test = input.providerOptions?.facebook?.abTest;
        const response = await http.request<unknown>(context, {
          body: JSON.stringify({
            name: required("experimentName", test?.name ?? "", 200),
            description: input.caption.trim(),
            control_video_id: requiredIdentifier(
              test?.controlVideoId,
              "facebook_experiment_control_required",
            ),
            experiment_video_ids: test?.experimentVideoIds,
            optimization_goal: test?.optimizationGoal,
            ...(test?.durationSeconds !== undefined ? { duration: test.durationSeconds } : {}),
          }),
          headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
          method: "POST",
          sideEffectPossible: true,
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/ab_tests`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        const id = facebookStoryPostId(record(response.body)?.id);
        if (!id) throw malformed(true);
        return {
          outcome: "confirmed_success",
          delivery: "experiment",
          providerOperationId: facebookOperationId("ab_test", id),
        };
      }
      if (postType === "feed") {
        const caption = input.caption.trim();
        const options = input.providerOptions?.facebook;
        if (!caption && input.media.length === 0 && !options?.link) {
          throw new ProviderAdapterError(
            classifyProviderFailure({
              code: "facebook_feed_invalid",
              status: 400,
            }),
          );
        }
        // Validate the complete photo set before creating any remote object.
        const photos = input.media.map(photoUrl);
        const attached: { media_fbid: string }[] = [];
        for (const url of photos) {
          const staged = await http.request<unknown>(context, {
            body: JSON.stringify({ url, published: false }),
            headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
            method: "POST",
            url: new URL(
              `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/photos`,
              FACEBOOK_GRAPH_ORIGIN,
            ).toString(),
          });
          const id = providerIdentifier(record(staged.body)?.id);
          if (!id) throw malformed();
          attached.push({ media_fbid: id });
        }
        const response = await http.request<unknown>(context, {
          body: JSON.stringify({
            message: caption,
            published: !draft,
            ...(attached.length ? { attached_media: attached } : {}),
            ...(options?.link ? { link: options.link } : {}),
            ...(options?.linkCards
              ? {
                  child_attachments: options.linkCards,
                  multi_share_optimized: false,
                }
              : {}),
          }),
          headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
          method: "POST",
          sideEffectPossible: true,
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/feed`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        const id = providerIdentifier(record(response.body)?.id);
        if (!id || !id.startsWith(`${pageId}_`)) throw malformed(true);
        return draft ? facebookNativeDraft("post_draft", id) : facebookPublishedPost(id);
      }
      if (postType === "video" || postType === "slideshow" || postType === "crosspost") {
        let source:
          | { file_url: string }
          | { slideshow_spec: { images_urls: string[] } }
          | { crossposted_video_id: string };
        if (postType === "crosspost") {
          source = {
            crossposted_video_id: requiredIdentifier(
              input.providerOptions?.facebook?.crosspostedVideoId,
              "facebook_source_video_required",
            ),
          };
        } else if (postType === "slideshow") {
          if (
            input.media.some(
              (media) =>
                !["image/jpeg", "image/png", "image/bmp"].includes(
                  normalizeContentType(media.contentType),
                ),
            )
          ) {
            throw new ProviderAdapterError(
              classifyProviderFailure({ code: "facebook_slideshow_invalid", status: 400 }),
            );
          }
          source = { slideshow_spec: { images_urls: input.media.map(photoUrl) } };
        } else {
          const { mediaUrl } = remoteVideoInput(input);
          source = { file_url: mediaUrl };
        }
        const response = await http.request<unknown>(context, {
          body: JSON.stringify({ description: input.caption.trim(), ...source, published: !draft }),
          headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
          method: "POST",
          sideEffectPossible: true,
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/videos`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        const id = providerIdentifier(record(response.body)?.id);
        if (!id) throw malformed(true);
        return {
          outcome: "confirmed_success",
          providerOperationId: facebookOperationId(draft ? "video_draft" : "video", id),
        };
      }
      const [firstMedia] = input.media;
      if (postType === "story" && firstMedia && firstMedia.contentType.startsWith("image/")) {
        const url = photoUrl(firstMedia);
        const uploaded = await http.request<unknown>(context, {
          body: JSON.stringify({ url, published: false }),
          headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
          method: "POST",
          url: new URL(
            `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/photos`,
            FACEBOOK_GRAPH_ORIGIN,
          ).toString(),
        });
        const photoId = providerIdentifier(record(uploaded.body)?.id);
        if (!photoId) throw malformed();
        const retainedId = facebookOperationId("story", photoId);
        try {
          const response = await http.request<unknown>(context, {
            body: JSON.stringify({ photo_id: photoId }),
            headers: { ...bearer(credentials.accessToken), "Content-Type": "application/json" },
            method: "POST",
            sideEffectPossible: true,
            url: new URL(
              `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/photo_stories`,
              FACEBOOK_GRAPH_ORIGIN,
            ).toString(),
          });
          const body = record(response.body);
          const id = facebookStoryPostId(body?.post_id);
          if (body?.success !== true || !id) throw malformed(true);
          return {
            outcome: "confirmed_success",
            providerOperationId: retainedId,
            providerPostId: id,
          };
        } catch (cause) {
          if (!(cause instanceof ProviderAdapterError)) throw cause;
          return cause.failure.classification === "ambiguous"
            ? unknownResult(cause.failure, retainedId)
            : confirmedFailure(cause.failure, retainedId);
        }
      }
      if (postType !== "reel" && postType !== "story") {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "facebook_post_options_invalid", status: 400 }),
        );
      }
      const { description, mediaUrl } = remoteVideoInput(input);
      const createUrl = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/${postType === "story" ? "video_stories" : "video_reels"}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      createUrl.searchParams.set("upload_phase", "start");
      const createResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: createUrl.toString(),
      });
      const createBody = record(createResponse.body);
      const videoId = providerIdentifier(createBody?.video_id);
      if (!videoId) throw malformed(true);
      const uploadUrl = validateFacebookUploadUrl(createBody?.upload_url, videoId);
      try {
        const uploadResponse = await http.request<unknown>(context, {
          headers: {
            Authorization: `OAuth ${required("accessToken", credentials.accessToken)}`,
            file_url: mediaUrl,
          },
          method: "POST",
          sideEffectPossible: true,
          url: uploadUrl,
        });
        if (record(uploadResponse.body)?.success !== true) {
          throw malformed(true);
        }
        return submitFinish(context, credentials, videoId, description, postType, draft);
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        if (isUncertainFailure(cause.failure)) {
          return unknownResult(
            cause.failure,
            facebookOperationId(postType === "story" ? "story" : "upload_submitted", videoId),
          );
        }
        return confirmedFailure(
          cause.failure,
          facebookOperationId(postType === "story" ? "story" : "uploaded", videoId),
        );
      }
    },
  };
}
