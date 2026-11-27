import { isHttp404, malformed, rejected, requiredIdentifier } from "../failures";
import type { ProviderHttpClient } from "../http";
import { failedWriteResult, type ConfirmedSuccess } from "../results";
import type {
  ProviderBroadcastInfo,
  ProviderCredentials,
  ProviderOperationResult,
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  ProviderRequestContext,
  PublishInput,
} from "../types";
import {
  bearer,
  firstNonEmptyLine,
  jsonHeaders,
  mediaKind,
  normalizeContentType,
  numericOrStringIdentifier,
  providerIdentifier,
  record,
  required,
  requireIdempotencyKey,
} from "../values";
import { resolveFacebookPostType } from "./options";
import {
  facebookBroadcastInfo,
  facebookPostStatus,
  facebookReelLookupStatus,
  facebookStoryStatus,
  facebookVideoStatus,
  liveOperation,
  photoUrl,
  remoteVideoUrl,
} from "./responses";
import {
  facebookAccountId,
  facebookNativeDraft,
  facebookOperationId,
  facebookPublishedVideo,
  graphUrl,
  nodeUrl,
  parseFacebookOperationId,
  parseFacebookReelStatus,
  validateFacebookUploadUrl,
  type FacebookOperation,
  type FacebookReelStatus,
} from "./types";

const slideshowImageTypes = ["image/jpeg", "image/png", "image/bmp"];
const storyPageSize = "100";

export function createFacebookPublish(http: ProviderHttpClient) {
  const get = async (context: ProviderRequestContext, accessToken: string, url: URL) =>
    record(
      (
        await http.request(context, {
          headers: bearer(accessToken),
          method: "GET",
          url: url.toString(),
        })
      ).body,
    );

  const post = async (
    context: ProviderRequestContext,
    accessToken: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    sideEffectPossible: boolean,
  ) =>
    record(
      (
        await http.request(context, {
          ...(body
            ? { body: JSON.stringify(body), headers: jsonHeaders(accessToken) }
            : { headers: bearer(accessToken) }),
          method: "POST",
          sideEffectPossible,
          url: url.toString(),
        })
      ).body,
    );

  const stageUnpublishedPhoto = async (
    context: ProviderRequestContext,
    accessToken: string,
    pageId: string,
    url: string,
  ): Promise<string> => {
    const id = providerIdentifier(
      (
        await post(
          context,
          accessToken,
          graphUrl(`${encodeURIComponent(pageId)}/photos`),
          { url, published: false },
          false,
        )
      )?.id,
    );
    if (!id) throw malformed();
    return id;
  };

  const getReelStatus = async (
    context: ProviderRequestContext,
    accessToken: string,
    videoId: string,
  ): Promise<FacebookReelStatus | undefined> => {
    try {
      return parseFacebookReelStatus(
        await get(context, accessToken, nodeUrl(videoId, "id,status")),
        videoId,
      );
    } catch (cause) {
      if (isHttp404(cause)) return undefined;
      throw cause;
    }
  };

  const submitFinish = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    videoId: string,
    description: string,
    kind: "reel" | "story",
    draft: boolean,
  ): Promise<ProviderOperationResult> => {
    const url = graphUrl(
      `${encodeURIComponent(facebookAccountId(credentials))}/${kind === "story" ? "video_stories" : "video_reels"}`,
    );
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("upload_phase", "finish");
    if (kind === "reel") {
      url.searchParams.set("video_state", draft ? "DRAFT" : "PUBLISHED");
      if (description) url.searchParams.set("description", description);
    }
    try {
      const body = await post(context, credentials.accessToken, url, undefined, true);
      if (body?.success !== true) throw malformed(true);
      if (kind === "reel") {
        return {
          outcome: "confirmed_success",
          providerOperationId: facebookOperationId(draft ? "reel_draft" : "finishing", videoId),
        };
      }
      const id = numericOrStringIdentifier(body.post_id);
      if (!id) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: facebookOperationId("story", videoId),
        providerPostId: id,
      };
    } catch (cause) {
      return kind === "story"
        ? failedWriteResult(cause, facebookOperationId("story", videoId))
        : failedWriteResult(
            cause,
            facebookOperationId("finish_submitted", videoId),
            facebookOperationId("uploaded", videoId),
          );
    }
  };

  const lookupStory = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    mediaId: string,
  ): Promise<ProviderPublicationStatus> => {
    const url = graphUrl(`${encodeURIComponent(pageId)}/stories`);
    url.searchParams.set("limit", storyPageSize);
    return facebookStoryStatus(await get(context, credentials.accessToken, url), mediaId);
  };

  const lookupVideo = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: FacebookOperation & { phase: "video" | "video_draft" },
  ): Promise<ProviderPublicationStatus> => {
    let body;
    try {
      body = await get(context, credentials.accessToken, nodeUrl(operation.id, "id,status"));
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    return facebookVideoStatus(body, operation);
  };

  const lookupPost = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    postId: string,
    phase: "post" | "post_draft",
  ): Promise<ProviderPublicationStatus> => {
    if (!postId.startsWith(`${pageId}_`)) throw malformed();
    let post;
    try {
      post = await get(context, credentials.accessToken, nodeUrl(postId, "id,is_published"));
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    return facebookPostStatus(post, postId, phase);
  };

  const lookupReel = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    videoId: string,
    operation: FacebookOperation | undefined,
  ): Promise<ProviderPublicationStatus> => {
    const status = await getReelStatus(context, credentials.accessToken, videoId);
    if (!status) return { state: "not_found" };
    return facebookReelLookupStatus(status, videoId, operation);
  };

  const publishVideoUpload = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    input: PublishInput,
    kind: "reel" | "story",
    draft: boolean,
  ): Promise<ProviderOperationResult> => {
    const mediaUrl = remoteVideoUrl(input);
    const createUrl = graphUrl(
      `${encodeURIComponent(pageId)}/${kind === "story" ? "video_stories" : "video_reels"}`,
    );
    createUrl.searchParams.set("upload_phase", "start");
    const created = await post(context, credentials.accessToken, createUrl, undefined, true);
    const videoId = providerIdentifier(created?.video_id);
    if (!videoId) throw malformed(true);
    const uploadUrl = validateFacebookUploadUrl(created?.upload_url, videoId);
    try {
      const uploaded = await http.request(context, {
        headers: {
          Authorization: `OAuth ${required("accessToken", credentials.accessToken)}`,
          file_url: mediaUrl,
        },
        method: "POST",
        sideEffectPossible: true,
        url: uploadUrl,
      });
      if (record(uploaded.body)?.success !== true) throw malformed(true);
    } catch (cause) {
      return kind === "story"
        ? failedWriteResult(cause, facebookOperationId("story", videoId))
        : failedWriteResult(
            cause,
            facebookOperationId("upload_submitted", videoId),
            facebookOperationId("uploaded", videoId),
          );
    }
    return submitFinish(context, credentials, videoId, input.caption.trim(), kind, draft);
  };

  return {
    async getBroadcastInfo(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderBroadcastInfo> {
      facebookAccountId(credentials);
      const { id } = liveOperation(lookup);
      const body = await get(
        context,
        credentials.accessToken,
        nodeUrl(id, "id,status,secure_stream_url"),
      );
      return facebookBroadcastInfo(body, id);
    },

    async endBroadcast(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderOperationResult> {
      facebookAccountId(credentials);
      const { id } = liveOperation(lookup);
      const endUrl = nodeUrl(id);
      endUrl.searchParams.set("end_live_video", "true");
      const ended = await post(context, credentials.accessToken, endUrl, undefined, true);
      if (numericOrStringIdentifier(ended?.id) !== id) throw malformed(true);
      const status = await get(context, credentials.accessToken, nodeUrl(id, "id,status"));
      if (numericOrStringIdentifier(status?.id) !== id) throw malformed();
      return status?.status === "VOD"
        ? facebookPublishedVideo("ended_live", id)
        : {
            outcome: "confirmed_success",
            delivery: "broadcast",
            providerOperationId: facebookOperationId("ended_live", id),
          };
    },

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
      switch (operation?.phase) {
        case "live":
        case "ended_live":
          return {
            state: "delivered",
            result: {
              outcome: "confirmed_success",
              delivery: "broadcast",
              providerOperationId: facebookOperationId(operation.phase, operation.id),
            },
          };
        case "ab_test": {
          const body = await get(context, credentials.accessToken, nodeUrl(operation.id));
          if (numericOrStringIdentifier(body?.id) !== operation.id) throw malformed();
          return {
            state: "delivered",
            result: {
              outcome: "confirmed_success",
              delivery: "experiment",
              providerOperationId: facebookOperationId("ab_test", operation.id),
            },
          };
        }
        case "story":
          return lookupStory(context, credentials, pageId, operation.id);
        case "video":
        case "video_draft":
          return lookupVideo(context, credentials, { id: operation.id, phase: operation.phase });
        case "post":
        case "post_draft":
          return lookupPost(
            context,
            credentials,
            pageId,
            providerPostId ?? operation.id,
            operation.phase,
          );
      }
      const videoId = providerPostId ?? operation?.id;
      if (!videoId) throw malformed();
      return lookupReel(context, credentials, videoId, operation);
    },

    async publish(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      input: PublishInput,
    ): Promise<ProviderOperationResult> {
      const pageId = facebookAccountId(credentials);
      const options = input.providerOptions?.facebook;
      const draft = options?.deliveryMode === "draft";
      const token = credentials.accessToken;
      const caption = input.caption.trim();
      const pageEdge = (edge: string) => graphUrl(`${encodeURIComponent(pageId)}/${edge}`);
      requireIdempotencyKey(input.idempotencyKey);
      const postType = resolveFacebookPostType(
        options,
        input.media.map((media) => mediaKind(media.contentType)),
      );
      if (!postType) throw rejected("facebook_post_options_invalid");
      if (postType === "story" && (caption || input.hashtags.length)) {
        throw rejected("facebook_story_caption_unsupported");
      }

      switch (postType) {
        case "live": {
          const body = await post(
            context,
            token,
            pageEdge("live_videos"),
            { status: "LIVE_NOW", title: firstNonEmptyLine(caption) ?? "", description: caption },
            true,
          );
          const id = numericOrStringIdentifier(body?.id);
          if (!id) throw malformed(true);
          return {
            outcome: "confirmed_success",
            delivery: "broadcast",
            providerOperationId: facebookOperationId("live", id),
          };
        }
        case "ab_test": {
          const test = options?.abTest;
          const body = await post(
            context,
            token,
            pageEdge("ab_tests"),
            {
              name: required("experimentName", test?.name ?? "", 200),
              description: caption,
              control_video_id: requiredIdentifier(
                test?.controlVideoId,
                "facebook_experiment_control_required",
              ),
              experiment_video_ids: test?.experimentVideoIds,
              optimization_goal: test?.optimizationGoal,
              ...(test?.durationSeconds !== undefined ? { duration: test.durationSeconds } : {}),
            },
            true,
          );
          const id = numericOrStringIdentifier(body?.id);
          if (!id) throw malformed(true);
          return {
            outcome: "confirmed_success",
            delivery: "experiment",
            providerOperationId: facebookOperationId("ab_test", id),
          };
        }
        case "feed": {
          if (!caption && input.media.length === 0 && !options?.link) {
            throw rejected("facebook_feed_invalid");
          }
          const photos = input.media.map(photoUrl);
          const attached: { media_fbid: string }[] = [];
          for (const url of photos) {
            attached.push({ media_fbid: await stageUnpublishedPhoto(context, token, pageId, url) });
          }
          const body = await post(
            context,
            token,
            pageEdge("feed"),
            {
              message: caption,
              published: !draft,
              ...(attached.length ? { attached_media: attached } : {}),
              ...(options?.link ? { link: options.link } : {}),
              ...(options?.linkCards
                ? { child_attachments: options.linkCards, multi_share_optimized: false }
                : {}),
            },
            true,
          );
          const id = providerIdentifier(body?.id);
          if (!id || !id.startsWith(`${pageId}_`)) throw malformed(true);
          return draft ? facebookNativeDraft("post_draft", id) : facebookPublishedVideo("post", id);
        }
        case "video":
        case "slideshow":
        case "crosspost": {
          let source: Record<string, unknown>;
          if (postType === "crosspost") {
            source = {
              crossposted_video_id: requiredIdentifier(
                options?.crosspostedVideoId,
                "facebook_source_video_required",
              ),
            };
          } else if (postType === "slideshow") {
            if (
              input.media.some(
                (media) => !slideshowImageTypes.includes(normalizeContentType(media.contentType)),
              )
            ) {
              throw rejected("facebook_slideshow_invalid");
            }
            source = { slideshow_spec: { images_urls: input.media.map(photoUrl) } };
          } else {
            source = { file_url: remoteVideoUrl(input) };
          }
          const body = await post(
            context,
            token,
            pageEdge("videos"),
            { description: caption, ...source, published: !draft },
            true,
          );
          const id = providerIdentifier(body?.id);
          if (!id) throw malformed(true);
          return {
            outcome: "confirmed_success",
            providerOperationId: facebookOperationId(draft ? "video_draft" : "video", id),
          };
        }
        case "story": {
          const [media] = input.media;
          if (media && mediaKind(media.contentType) === "image") {
            const photoId = await stageUnpublishedPhoto(context, token, pageId, photoUrl(media));
            const retainedId = facebookOperationId("story", photoId);
            try {
              const body = await post(
                context,
                token,
                pageEdge("photo_stories"),
                { photo_id: photoId },
                true,
              );
              const id = numericOrStringIdentifier(body?.post_id);
              if (body?.success !== true || !id) throw malformed(true);
              return {
                outcome: "confirmed_success",
                providerOperationId: retainedId,
                providerPostId: id,
              } satisfies ConfirmedSuccess;
            } catch (cause) {
              return failedWriteResult(cause, retainedId);
            }
          }
          return publishVideoUpload(context, credentials, pageId, input, "story", draft);
        }
        case "reel":
          return publishVideoUpload(context, credentials, pageId, input, "reel", draft);
      }
    },
  };
}
