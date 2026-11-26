import type { PlatformCapability } from "@meltiply/domain";

import { malformed, ProviderAdapterError, rejected, rejection } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import {
  addSeconds,
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
  postForm,
} from "../oauth";
import { confirmedFailure, engagementSnapshot, failedWriteResult } from "../results";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderMedia,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
  TikTokPrivacyLevel,
  TikTokPublicationRequirements,
  TikTokPublishOptions,
} from "../types";
import {
  bearer,
  boundedString,
  boundedText,
  firstNonEmptyLine,
  formHeaders,
  mediaKind,
  metricValue,
  normalizeContentType,
  optionalSecureUrl,
  record,
  required,
  requiredIdentifier,
  requireIdempotencyKey,
  secureUrl,
  validateSnapshotPage,
  validFileSize,
} from "../values";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,254}$/;
const openIdPattern = /^[A-Za-z0-9_-][A-Za-z0-9._:~-]{0,254}$/;
const errorCodePattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const scopePattern = /^[a-z][a-z0-9._-]{0,99}$/;
const operationPattern = /^(publish|inbox):(.+)$/;
const maxScopes = 20;

export const tiktokApiOrigin = "https://open.tiktokapis.com";
const apiOrigin = tiktokApiOrigin;
const limits = PROVIDER_LIMITS.tiktok;
const jsonContentType = "application/json; charset=UTF-8";
const videoTypes = ["video/mp4", "video/quicktime", "video/webm"];
const imageTypes = ["image/jpeg", "image/webp"];
const authErrorCodes = ["access_token_invalid", "scope_not_authorized", "token_not_authorized"];
const retryableFailReasons = ["internal", "video_pull_failed", "photo_pull_failed"];
const processingStatuses = ["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"];
const requiredScopes = ["user.info.basic"] as const;
const requestedScopes = [
  ...requiredScopes,
  "video.publish",
  "video.upload",
  "user.info.profile",
  "user.info.stats",
  "video.list",
] as const;
const privacyLevels: ReadonlySet<string> = new Set<TikTokPrivacyLevel>([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "image/webp", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: false,
  connect_available: true,
  max_caption_length: limits.maxCaptionCodePoints,
  max_file_size: limits.maxVideoBytes,
  max_hashtags: limits.maxHashtags,
  max_media_count: limits.maxPhotoImages,
  max_video_duration_sec: limits.maxVideoDurationSeconds,
  min_media_count: 1,
  multi_asset_types: ["image"],
  notes: [
    "One video or up to 35 images can publish directly or be handed to the creator's TikTok inbox for native completion.",
    "A photo post is images only; mixing a video with images is not supported.",
    "Privacy, interaction, commercial-content, AI, and music-usage choices are explicit per target.",
    "Media uses PULL_FROM_URL from an HTTPS URL prefix verified in the TikTok developer portal.",
    "The Channel username appears only when the optional user.info.profile scope is granted.",
    "Direct Post re-queries creator permissions immediately before publication; inbox upload requires video.upload and is not a published outcome.",
    "Analytics reads the creator's own view, like, comment, and share counters; comments and replies are not claimed.",
    "Existing connections must reconnect to grant the video.list analytics scope.",
    "TikTok app audit and approved live-account acceptance remain required.",
  ],
  platform: "tiktok",
  publish: true,
  reply: false,
};

export interface TikTokAdapterOptions extends ProviderAdapterOptions {
  mediaUrlPrefix: string;
}

interface TikTokTokenBody {
  accessToken: string;
  expiresAt: string;
  openId: string;
  refreshToken: string;
  scope: { kind: "absent" } | { kind: "invalid" } | { kind: "granted"; scopes: string[] };
}

interface TikTokOperation {
  inbox: boolean;
  publishId: string;
}

interface PullMedia {
  contentType: string;
  fileSize: number;
  metadata: ProviderMedia["metadata"];
  url: string;
}

function isPrivacyLevel(value: unknown): value is TikTokPrivacyLevel {
  return typeof value === "string" && privacyLevels.has(value);
}

function patternIdentifier(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return pattern.test(normalized) ? normalized : undefined;
}

const tiktokIdentifier = (value: unknown) => patternIdentifier(value, identifierPattern);
const openId = (value: unknown) => patternIdentifier(value, openIdPattern);

function accountId(credentials: ProviderCredentials): string {
  const value = openId(credentials.accountId);
  if (!value) throw rejected("tiktok_account_required");
  return value;
}

function apiFailureStatus(code: string): number {
  if (authErrorCodes.includes(code)) return 401;
  if (code.includes("rate_limit")) return 429;
  if (
    code.includes("active_user_cap") ||
    code.includes("too_many_posts") ||
    code.includes("quota")
  ) {
    return 507;
  }
  if (code.includes("internal") || code.includes("server")) return 503;
  return 400;
}

function apiError(code: string): ProviderAdapterError {
  const normalized = code.trim().toLowerCase();
  if (!errorCodePattern.test(normalized)) throw malformed();
  return rejected(`tiktok_${normalized}`, apiFailureStatus(normalized));
}

function envelope(value: unknown, sideEffectPossible = false): Record<string, unknown> {
  const body = record(value);
  const code = boundedString(record(body?.error)?.code, 80);
  if (!body || !code) throw malformed(sideEffectPossible);
  if (code !== "ok") throw apiError(code);
  const data = record(body.data);
  if (!data) throw malformed(sideEffectPossible);
  return data;
}

function scopeSet(value: unknown): string[] | undefined {
  const scopes = boundedString(value, 4_096)
    ?.split(",")
    .map((scope) => scope.trim());
  return scopes &&
    scopes.length <= maxScopes &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => scopePattern.test(scope))
    ? scopes
    : undefined;
}

function tokenBody(value: unknown, now: Date): TikTokTokenBody {
  const body = record(value);
  const providerError = boundedString(body?.error, 80);
  if (providerError) throw apiError(providerError);
  const accessToken = boundedString(body?.access_token, limits.tokenMaxChars);
  const refreshToken = boundedString(body?.refresh_token, limits.tokenMaxChars);
  const tokenOpenId = openId(body?.open_id);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  if (
    !accessToken ||
    !refreshToken ||
    !tokenOpenId ||
    (tokenType !== undefined && tokenType !== "bearer")
  ) {
    throw malformed(false, "tiktok_token_response_invalid");
  }
  const scopes = scopeSet(body?.scope);
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, limits.tokenLifetimeMaxSeconds),
    openId: tokenOpenId,
    refreshToken,
    scope:
      body?.scope === undefined
        ? { kind: "absent" }
        : scopes
          ? { kind: "granted", scopes }
          : { kind: "invalid" },
  };
}

function publishingGrant(scope: TikTokTokenBody["scope"]): string[] {
  if (scope.kind === "invalid") throw malformed(false, "tiktok_token_response_invalid");
  const granted = scope.kind === "granted" ? scope.scopes : [];
  const missingScopes: string[] = requiredScopes.filter((name) => !granted.includes(name));
  if (!granted.includes("video.publish") && !granted.includes("video.upload")) {
    missingScopes.push("video.publish");
  }
  if (missingScopes.length > 0) {
    throw new ProviderAdapterError(rejection("tiktok_scope_not_granted"), { missingScopes });
  }
  return granted;
}

function configuredMediaPrefix(value: string): URL {
  const url = new URL(required("mediaUrlPrefix", value, 2_048));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    !url.pathname.endsWith("/")
  ) {
    throw new TypeError("mediaUrlPrefix must be an exact HTTPS directory prefix");
  }
  return url;
}

function pullMedia(media: ProviderMedia, mediaPrefix: URL): PullMedia {
  const url = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
  if (!url) throw rejected("tiktok_pull_media_required");
  if (url.origin !== mediaPrefix.origin || !url.pathname.startsWith(mediaPrefix.pathname)) {
    throw rejected("tiktok_media_prefix_invalid");
  }
  return {
    contentType: normalizeContentType(media.contentType),
    fileSize: media.fileSize,
    metadata: media.metadata,
    url: url.href,
  };
}

function publishOptions(input: PublishInput): TikTokPublishOptions {
  const value = input.providerOptions?.tiktok;
  if (
    !value ||
    value.musicUsageConfirmed !== true ||
    (value.postMode !== "inbox" && !isPrivacyLevel(value.privacyLevel)) ||
    (value.postMode !== undefined && value.postMode !== "direct" && value.postMode !== "inbox") ||
    [
      value.allowComment,
      value.allowDuet,
      value.allowStitch,
      value.brandContent,
      value.brandOrganic,
      value.isAiGenerated,
    ].some((choice) => typeof choice !== "boolean") ||
    (value.autoAddMusic !== undefined && typeof value.autoAddMusic !== "boolean") ||
    (value.postMode !== "inbox" && value.brandContent && value.privacyLevel === "SELF_ONLY")
  ) {
    throw rejected("tiktok_publish_options_invalid");
  }
  return value;
}

function creatorRequirements(value: unknown): TikTokPublicationRequirements {
  const data = envelope(value);
  const avatar = optionalSecureUrl(data.creator_avatar_url);
  const creatorUsername = boundedText(data.creator_username, 255);
  const creatorDisplayName = boundedText(data.creator_nickname, 500);
  const rawPrivacyLevels = data.privacy_level_options;
  const maxVideoDurationSeconds = data.max_video_post_duration_sec;
  if (
    !avatar.valid ||
    !creatorUsername ||
    !creatorDisplayName ||
    !Array.isArray(rawPrivacyLevels) ||
    rawPrivacyLevels.length < 1 ||
    new Set(rawPrivacyLevels).size !== rawPrivacyLevels.length ||
    !rawPrivacyLevels.every(isPrivacyLevel) ||
    typeof data.comment_disabled !== "boolean" ||
    typeof data.duet_disabled !== "boolean" ||
    typeof data.stitch_disabled !== "boolean" ||
    typeof maxVideoDurationSeconds !== "number" ||
    !Number.isInteger(maxVideoDurationSeconds) ||
    maxVideoDurationSeconds < 1 ||
    maxVideoDurationSeconds > limits.maxVideoDurationSeconds
  ) {
    throw malformed();
  }
  return {
    commentAllowed: !data.comment_disabled,
    ...(avatar.href ? { creatorAvatarUrl: avatar.href } : {}),
    creatorDisplayName,
    creatorUsername,
    duetAllowed: !data.duet_disabled,
    maxVideoDurationSeconds,
    platform: "tiktok",
    privacyLevels: rawPrivacyLevels,
    stitchAllowed: !data.stitch_disabled,
  };
}

function operationId(operation: TikTokOperation): string {
  return `${operation.inbox ? "inbox" : "publish"}:${operation.publishId}`;
}

function parseOperationId(value: unknown): TikTokOperation | undefined {
  const match = tiktokIdentifier(value)?.match(operationPattern);
  const publishId = tiktokIdentifier(match?.[2]);
  return match && publishId ? { inbox: match[1] === "inbox", publishId } : undefined;
}

function requiredOperation(value: unknown): TikTokOperation {
  const operation = parseOperationId(value);
  if (!operation) throw rejected("tiktok_publish_id_required");
  return operation;
}

function positiveInteger(value: number | undefined, minimum: number, maximum: number): boolean {
  return value !== undefined && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function videoInvalid(media: PullMedia, maxDuration: number): boolean {
  const { durationSeconds, height, width } = media.metadata ?? {};
  return (
    !videoTypes.includes(media.contentType) ||
    !validFileSize(media.fileSize, limits.maxVideoBytes) ||
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maxDuration ||
    !positiveInteger(width, limits.minVideoDimensionPx, limits.maxVideoDimensionPx) ||
    !positiveInteger(height, limits.minVideoDimensionPx, limits.maxVideoDimensionPx)
  );
}

function photoInvalid(media: PullMedia): boolean {
  const { height, width } = media.metadata ?? {};
  return (
    !imageTypes.includes(media.contentType) ||
    !validFileSize(media.fileSize, limits.maxImageBytes) ||
    width === undefined ||
    height === undefined ||
    !positiveInteger(width, 1, Number.MAX_SAFE_INTEGER) ||
    !positiveInteger(height, 1, Number.MAX_SAFE_INTEGER) ||
    Math.min(width, height) > limits.maxPhotoShortSidePx
  );
}

function failedPublishCode(reason: string | undefined): { code: string; status: number } {
  return {
    code: reason && errorCodePattern.test(reason) ? `tiktok_${reason}` : "tiktok_publish_failed",
    status: retryableFailReasons.includes(reason ?? "")
      ? 503
      : reason === "auth_removed"
        ? 401
        : 422,
  };
}

export function createTikTokAdapter(options: TikTokAdapterOptions): ProviderAdapter {
  const { clientId, clientSecret, http, now, redirectUri } = adapterRuntime(
    "tiktok",
    [apiOrigin],
    options,
  );
  const mediaPrefix = configuredMediaPrefix(options.mediaUrlPrefix);
  const tokenUrl = `${apiOrigin}/v2/oauth/token/`;

  const postJson = (
    context: ProviderRequestContext,
    accessToken: string,
    url: string,
    body: unknown,
    extra: { preserveLargeIntegers?: boolean; sideEffectPossible?: boolean } = {},
  ) =>
    http.request(context, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...bearer(accessToken), "Content-Type": jsonContentType },
      method: "POST",
      url,
      ...extra,
    });

  const getUser = async (context: ProviderRequestContext, accessToken: string, fields: string) => {
    const url = new URL("/v2/user/info/", apiOrigin);
    url.searchParams.set("fields", fields);
    const response = await http.request(context, {
      headers: bearer(accessToken),
      method: "GET",
      url: url.toString(),
    });
    return record(envelope(response.body).user);
  };

  const getRequirements = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ): Promise<TikTokPublicationRequirements> => {
    accountId(credentials);
    const response = await http.request(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      url: `${apiOrigin}/v2/post/publish/creator_info/query/`,
    });
    return creatorRequirements(response.body);
  };

  return {
    authorizationUrl: (input) =>
      authorizationCodeUrl("https://www.tiktok.com/v2/auth/authorize/", input, redirectUri, {
        client_key: clientId,
        disable_auto_auth: "1",
        scope: requestedScopes.join(","),
      }),

    async cancelPublication(context, credentials, lookup) {
      accountId(credentials);
      const operation = requiredOperation(lookup.providerOperationId);
      const retainedOperationId = operationId(operation);
      try {
        const response = await postJson(
          context,
          credentials.accessToken,
          `${apiOrigin}/v2/post/publish/cancel/`,
          { publish_id: operation.publishId },
          { sideEffectPossible: true },
        );
        envelope(response.body, true);
        return { outcome: "confirmed_success", providerOperationId: retainedOperationId };
      } catch (cause) {
        return failedWriteResult(cause, retainedOperationId);
      }
    },

    capability,

    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, redirectUri);
      const tokens = tokenBody(
        await exchangeAuthorizationCodeForm(http, context, {
          clientId,
          clientIdField: "client_key",
          clientSecret,
          code: input.code,
          redirectUri,
          tokenUrl,
        }),
        now(),
      );
      const scopes = publishingGrant(tokens.scope);
      const user = await getUser(
        context,
        tokens.accessToken,
        scopes.includes("user.info.profile")
          ? "open_id,display_name,avatar_url,username"
          : "open_id,display_name,avatar_url",
      );
      const displayName = boundedText(user?.display_name, 500);
      const avatar = optionalSecureUrl(user?.avatar_url);
      const username = boundedString(user?.username, 255);
      if (openId(user?.open_id) !== tokens.openId || !displayName || !avatar.valid) {
        throw malformed();
      }
      return {
        accessToken: tokens.accessToken,
        account: {
          ...(avatar.href ? { avatarUrl: avatar.href } : {}),
          displayName,
          id: tokens.openId,
          ...(username ? { username } : {}),
        },
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes,
      };
    },

    getPublicationRequirements: getRequirements,

    async getAccountAnalytics(context, credentials) {
      const user = await getUser(
        context,
        credentials.accessToken,
        "open_id,follower_count,following_count,video_count",
      );
      const followers = metricValue(user?.follower_count);
      const following = metricValue(user?.following_count);
      const posts = metricValue(user?.video_count);
      if (followers === undefined) throw malformed();
      return {
        followers,
        ...(following === undefined ? {} : { following }),
        ...(posts === undefined ? {} : { posts }),
        recordedAt: now().toISOString(),
      };
    },

    async listAnalytics(context, credentials, lookup, page) {
      validateSnapshotPage("tiktok", page);
      const providerPostId = requiredIdentifier(lookup.providerPostId, "tiktok_video_id_required");
      const url = new URL("/v2/video/query/", apiOrigin);
      url.searchParams.set("fields", "id,view_count,like_count,comment_count,share_count");
      const response = await postJson(context, credentials.accessToken, url.toString(), {
        filters: { video_ids: [providerPostId] },
      });
      const videos = envelope(response.body).videos;
      if (!Array.isArray(videos) || videos.length > 1) throw malformed();
      if (videos.length === 0) return { items: [] };
      const video = record(videos[0]);
      const views = metricValue(video?.view_count);
      const likes = metricValue(video?.like_count);
      const comments = metricValue(video?.comment_count);
      const shares = metricValue(video?.share_count);
      if (
        tiktokIdentifier(video?.id) !== providerPostId ||
        views === undefined ||
        likes === undefined ||
        comments === undefined ||
        shares === undefined
      ) {
        throw malformed();
      }
      return engagementSnapshot({ comments, likes, providerPostId, shares, views }, now());
    },

    async lookupPublication(context, credentials, lookup): Promise<ProviderPublicationStatus> {
      accountId(credentials);
      const operation = requiredOperation(lookup.providerOperationId);
      const retainedOperationId = operationId(operation);
      const response = await postJson(
        context,
        credentials.accessToken,
        `${apiOrigin}/v2/post/publish/status/fetch/`,
        { publish_id: operation.publishId },
        { preserveLargeIntegers: true },
      );
      if (record(record(response.body)?.error)?.code === "invalid_publish_id") {
        return { state: "not_found" };
      }
      const data = envelope(response.body);
      const status = boundedString(data.status, 64);
      if (status && processingStatuses.includes(status)) {
        return { providerOperationId: retainedOperationId, state: "processing" };
      }
      if (status === "SEND_TO_USER_INBOX") {
        return operation.inbox
          ? {
              state: "delivered",
              result: {
                outcome: "confirmed_success",
                delivery: "inbox",
                providerOperationId: retainedOperationId,
              },
            }
          : {
              result: confirmedFailure(rejection("tiktok_sent_to_inbox", 422), retainedOperationId),
              state: "failed",
            };
      }
      if (status === "FAILED") {
        const { code, status: failureStatus } = failedPublishCode(
          boundedString(data.fail_reason, 80)?.toLowerCase(),
        );
        return {
          result: confirmedFailure(rejection(code, failureStatus), retainedOperationId),
          state: "failed",
        };
      }
      if (status !== "PUBLISH_COMPLETE") throw malformed();
      const rawPostIds = data.publicaly_available_post_id;
      const postIds = Array.isArray(rawPostIds)
        ? rawPostIds.map((id: unknown) =>
            tiktokIdentifier(
              typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : id,
            ),
          )
        : undefined;
      if (rawPostIds !== undefined && (!postIds || postIds.some((id) => !id))) throw malformed();
      const providerPostId = postIds?.[0];
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId: retainedOperationId,
          ...(providerPostId ? { providerPostId } : {}),
        },
        state: "published",
      };
    },

    async publish(context, credentials, input) {
      accountId(credentials);
      requireIdempotencyKey(input.idempotencyKey);
      if (input.hashtags.length > limits.maxHashtags) throw rejected("tiktok_hashtags_invalid");
      const media = input.media.map((attachment) => pullMedia(attachment, mediaPrefix));
      const kinds = input.media.map((attachment) => mediaKind(attachment.contentType));
      const [first] = media;
      if (!first) throw rejected("tiktok_pull_media_required");
      if (kinds.some((kind) => kind === null)) throw rejected("tiktok_asset_type_invalid");
      if (kinds.some((kind) => kind !== kinds[0])) throw rejected("tiktok_mixed_media_unsupported");
      const isVideo = kinds[0] === "video";
      const choices = publishOptions(input);
      if (isVideo && choices.autoAddMusic === true) {
        throw rejected("tiktok_auto_music_video_unsupported");
      }
      const inbox = choices.postMode === "inbox";
      const requirements = inbox ? undefined : await getRequirements(context, credentials);
      if (
        requirements &&
        (!choices.privacyLevel ||
          !requirements.privacyLevels.includes(choices.privacyLevel) ||
          (choices.allowComment && !requirements.commentAllowed) ||
          (choices.allowDuet && !requirements.duetAllowed) ||
          (choices.allowStitch && !requirements.stitchAllowed))
      ) {
        throw rejected("tiktok_creator_choice_unavailable");
      }

      const caption = input.caption.trim();
      const directPost = {
        brand_content_toggle: choices.brandContent,
        brand_organic_toggle: choices.brandOrganic,
        disable_comment: !choices.allowComment,
        privacy_level: choices.privacyLevel,
      };
      let endpoint: string;
      let body: Record<string, unknown>;
      if (isVideo) {
        if (
          media.length !== 1 ||
          (!inbox && caption.length > limits.maxVideoCaptionCodePoints) ||
          videoInvalid(
            first,
            requirements?.maxVideoDurationSeconds ?? limits.maxVideoDurationSeconds,
          )
        ) {
          throw rejected("tiktok_video_invalid");
        }
        const source_info = { source: "PULL_FROM_URL", video_url: first.url };
        endpoint = `${apiOrigin}/v2/post/publish/${inbox ? "inbox/video" : "video"}/init/`;
        body = inbox
          ? { source_info }
          : {
              post_info: {
                ...directPost,
                disable_duet: !choices.allowDuet,
                disable_stitch: !choices.allowStitch,
                is_aigc: choices.isAiGenerated,
                title: caption,
              },
              source_info,
            };
      } else {
        const title = firstNonEmptyLine(caption);
        if (
          !title ||
          title.length > limits.maxPhotoTitleChars ||
          caption.length > limits.maxCaptionCodePoints ||
          (!inbox && (choices.allowDuet || choices.allowStitch)) ||
          media.length > limits.maxPhotoImages ||
          media.some(photoInvalid)
        ) {
          throw rejected("tiktok_photo_invalid");
        }
        endpoint = `${apiOrigin}/v2/post/publish/content/init/`;
        body = {
          media_type: "PHOTO",
          is_aigc: choices.isAiGenerated,
          post_info: inbox
            ? { title, description: caption }
            : {
                ...directPost,
                auto_add_music: choices.autoAddMusic === true,
                description: caption,
                title,
              },
          post_mode: inbox ? "MEDIA_UPLOAD" : "DIRECT_POST",
          source_info: {
            photo_cover_index: 0,
            photo_images: media.map((attachment) => attachment.url),
            source: "PULL_FROM_URL",
          },
        };
      }

      try {
        const response = await postJson(context, credentials.accessToken, endpoint, body, {
          sideEffectPossible: true,
        });
        const publishId = tiktokIdentifier(envelope(response.body, true).publish_id);
        if (!publishId) throw malformed(true);
        return {
          outcome: "confirmed_success",
          providerOperationId: operationId({ inbox, publishId }),
        };
      } catch (cause) {
        return failedWriteResult(cause);
      }
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const tokens = tokenBody(
        await postForm(http, context, tokenUrl, {
          client_key: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: required("refreshToken", refreshToken, limits.tokenMaxChars),
        }),
        now(),
      );
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scope.kind === "granted" ? tokens.scope.scopes : [],
      };
    },

    retryPolicy: { baseDelaySeconds: 30, maxAttempts: 6, maxDelaySeconds: 900 },

    async revoke(accessToken, context) {
      await http.request(
        context ?? { operationId: "tiktok-oauth-revoke", requestId: "tiktok-oauth-revoke" },
        {
          body: new URLSearchParams({
            client_key: clientId,
            client_secret: clientSecret,
            token: required("accessToken", accessToken, limits.tokenMaxChars),
          }),
          headers: formHeaders,
          method: "POST",
          responseType: "empty",
          sideEffectPossible: true,
          url: `${apiOrigin}/v2/oauth/revoke/`,
        },
      );
    },

    transferModes: ["remote_ingest"],
  };
}
