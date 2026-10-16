import type { PlatformCapability } from "@meltiply/domain";
import { extractRateLimitBudget } from "./rate-limit";

import { addSeconds, malformed, unknownResult } from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import { ProviderHttpClient } from "./http";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedString,
  boundedText,
  exactRedirectUri,
  record,
  required,
  secureUrl,
} from "./meta-common";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderFailure,
  ProviderMedia,
  ProviderOperationResult,
  ProviderRemoteMedia,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
  TikTokPrivacyLevel,
  TikTokPublicationRequirements,
  TikTokPublishOptions,
} from "./types";

const apiOrigin = "https://open.tiktokapis.com";
const authorizationOrigin = "https://www.tiktok.com";
const imageMaximumBytes = 20 * 1024 * 1024;
const videoMaximumBytes = 500 * 1024 * 1024;
const tokenLifetimeMaximumSeconds = 2 * 24 * 60 * 60;
const configuredScopes = ["user.info.basic", "video.publish"] as const;
const privacyLevels = new Set<TikTokPrivacyLevel>([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "image/webp", "video/mp4", "video/quicktime"],
  analytics: false,
  asset_types: ["image", "video"],
  comments: false,
  connect_available: true,
  max_caption_length: 2_200,
  max_file_size: videoMaximumBytes,
  max_hashtags: 30,
  max_media_count: 35,
  max_video_duration_sec: 600,
  min_media_count: 1,
  multi_asset_types: ["image"],
  notes: [
    "One video, or up to 35 images as one photo post, is submitted through TikTok Direct Post.",
    "A photo post is images only; mixing a video with images is not supported.",
    "Privacy, interaction, commercial-content, AI, and music-usage choices are explicit per target.",
    "Media uses PULL_FROM_URL from an HTTPS URL prefix verified in the TikTok developer portal.",
    "Creator eligibility and current account limits are queried immediately before publication.",
    "Analytics, comments, and replies are not claimed.",
    "TikTok app audit and approved live-account acceptance remain required.",
  ],
  platform: "tiktok",
  publish: true,
  reply: false,
};

/** TikTok's documented ceiling of images in one photo post. */
const maximumPhotoImages = 35;

export interface TikTokAdapterOptions {
  clientKey: string;
  clientSecret: string;
  fetch?: typeof fetch;
  mediaUrlPrefix: string;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

interface TikTokTokenBody {
  accessToken: string;
  expiresAt: string;
  openId: string;
  refreshToken: string;
}

/**
 * Validates and normalizes an opaque TikTok identifier string (open_id, publish_id, union_id).
 * Enforces alphanumeric start and allowable characters `[A-Za-z0-9._:~-]` up to 255 characters.
 * Returns trimmed identifier string, or undefined if absent or invalid.
 */
function tiktokIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,254}$/.test(normalized) ? normalized : undefined;
}

/**
 * Extracts and validates the required TikTok creator account identifier from credentials.
 * Returns the validated TikTok open_id string. Throws ProviderAdapterError if missing or malformed.
 */
function accountId(credentials: ProviderCredentials): string {
  const value = tiktokIdentifier(credentials.accountId);
  if (!value) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "tiktok_account_required",
        status: 400,
      }),
    );
  }
  return value;
}

/**
 * Maps TikTok API error codes to appropriate HTTP status codes.
 * Categorizes auth errors to 401, rate limits to 429, quota caps to 507, server errors to 503, and bad requests to 400.
 * Returns corresponding HTTP status integer.
 */
function apiFailureStatus(code: string): number {
  if (["access_token_invalid", "scope_not_authorized", "token_not_authorized"].includes(code)) {
    return 401;
  }
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

/**
 * Constructs a ProviderAdapterError from a raw TikTok API error code.
 * Classifies failure with mapped HTTP status and standardized `tiktok_<code_name>` format.
 * Returns ProviderAdapterError instance. Throws error if code format is invalid.
 */
function apiError(code: string): ProviderAdapterError {
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) throw malformed();
  return new ProviderAdapterError(
    classifyProviderFailure({
      code: `tiktok_${normalized}`,
      status: apiFailureStatus(normalized),
    }),
  );
}

/**
 * Unpacks and validates a standard TikTok v2 API JSON response envelope (`{ error, data }`).
 * Asserts error.code === 'ok' and extracts data object; otherwise maps TikTok error to ProviderAdapterError.
 * Returns unpacked data record. Throws ProviderAdapterError on API error or malformed structure.
 */
function envelope(value: unknown, sideEffectPossible = false): Record<string, unknown> {
  const body = record(value);
  const error = record(body?.error);
  const code = boundedString(error?.code, 80);
  if (!body || !error || !code) throw malformed(sideEffectPossible);
  if (code !== "ok") throw apiError(code);
  const data = record(body.data);
  if (!data) throw malformed(sideEffectPossible);
  return data;
}

/**
 * Parses a comma-separated TikTok OAuth scope string into a validated Set of scope identifiers.
 * Enforces a maximum of 20 unique lowercase scope tokens matching standard identifier rules.
 * Returns Set of scope strings, or undefined if the string is empty or invalid.
 */
function scopeSet(value: unknown): Set<string> | undefined {
  const normalized = boundedString(value, 4_096);
  if (!normalized) return undefined;
  const scopes = normalized.split(",").map((scope) => scope.trim());
  if (
    scopes.length > 20 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[a-z][a-z0-9._-]{0,99}$/.test(scope))
  ) {
    return undefined;
  }
  return new Set(scopes);
}

/**
 * Parses and verifies an OAuth token exchange or refresh response from TikTok.
 * Asserts bearer token type, presence of all required configured scopes, and extracts access/refresh tokens.
 * Returns typed TikTokTokenBody record. Throws ProviderAdapterError if malformed or scopes missing.
 */
function tokenBody(value: unknown, now: Date): TikTokTokenBody {
  const body = record(value);
  const providerError = boundedString(body?.error, 80);
  if (providerError) throw apiError(providerError);
  const accessToken = boundedString(body?.access_token, 16_000);
  const refreshToken = boundedString(body?.refresh_token, 16_000);
  const openId = tiktokIdentifier(body?.open_id);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  const scopes = scopeSet(body?.scope);
  if (
    !accessToken ||
    !refreshToken ||
    !openId ||
    tokenType !== "bearer" ||
    !scopes ||
    configuredScopes.some((scope) => !scopes.has(scope))
  ) {
    throw malformed();
  }
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, tokenLifetimeMaximumSeconds),
    openId,
    refreshToken,
  };
}

/**
 * Validates the configured HTTPS directory URL prefix for TikTok PULL_FROM_URL media ingest.
 * TikTok requires media URLs to be hosted under a domain verified in the developer portal.
 * Returns parsed URL with trailing slash. Throws TypeError if URL format or protocol is invalid.
 */
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

/**
 * Validates that one ordered attachment matches the verified HTTPS directory
 * prefix for TikTok pull ingest.
 * Asserts remote_ingest mode plus matching origin and pathname prefix; the URL's
 * authorization shape (path-embedded bearer token or query credential) is owned
 * by the delivery layer, so no query presence or SigV4 parameter shape is
 * assumed here. Any supplied query is preserved.
 * @param media - The attachment to check, taken from `input.media[index]`.
 * @param mediaPrefix - Configured verified directory prefix.
 * @returns The attachment with its canonical HTTPS URL.
 * @throws ProviderAdapterError on prefix mismatch or invalid URL.
 */
function pullMedia(media: ProviderMedia, mediaPrefix: URL): ProviderRemoteMedia & { url: string } {
  const normalizedUrl = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
  if (media.mode !== "remote_ingest" || !normalizedUrl) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "tiktok_pull_media_required",
        status: 400,
      }),
    );
  }
  const url = new URL(normalizedUrl);
  if (url.origin !== mediaPrefix.origin || !url.pathname.startsWith(mediaPrefix.pathname)) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "tiktok_media_prefix_invalid",
        status: 400,
      }),
    );
  }
  return { ...media, url: normalizedUrl };
}

/**
 * Derives one attachment's media kind from its MIME type. TikTok publishes
 * either a single video or an images-only photo post, so a type that is neither
 * image nor video is rejected instead of guessed.
 * @param media - Attachment whose content type decides its kind.
 * @returns The attachment kind.
 * @throws ProviderAdapterError when the content type is not image or video.
 */
function attachmentKind(media: ProviderMedia): "image" | "video" {
  const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("image/")) return "image";
  throw new ProviderAdapterError(
    classifyProviderFailure({
      code: "tiktok_asset_type_invalid",
      status: 400,
    }),
  );
}
/**
 * Validates creator publish options required by TikTok Direct Post API.
 * Enforces music usage confirmation, valid privacy level, boolean interaction toggles, and brand content constraints.
 * Returns validated TikTokPublishOptions record. Throws ProviderAdapterError if choices are invalid.
 */
function publishOptions(input: PublishInput): TikTokPublishOptions {
  const value = input.providerOptions?.tiktok;
  if (
    !value ||
    value.musicUsageConfirmed !== true ||
    !privacyLevels.has(value.privacyLevel) ||
    [
      value.allowComment,
      value.allowDuet,
      value.allowStitch,
      value.brandContent,
      value.brandOrganic,
      value.isAiGenerated,
    ].some((choice) => typeof choice !== "boolean") ||
    (value.brandContent && value.privacyLevel === "SELF_ONLY")
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "tiktok_publish_options_invalid",
        status: 400,
      }),
    );
  }
  return value;
}

/**
 * Validates that the number of hashtags does not exceed TikTok's maximum ceiling of 30.
 * Throws ProviderAdapterError if hashtags.length > 30.
 */
function validateHashtags(input: PublishInput): void {
  if (input.hashtags.length > 30) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "tiktok_hashtags_invalid",
        status: 400,
      }),
    );
  }
}

/**
 * Unpacks creator capability info from TikTok `/v2/post/publish/creator_info/query/`.
 * Validates username, allowed privacy levels, interaction toggles (duet, stitch, comment), and max duration.
 * Returns normalized TikTokPublicationRequirements record. Throws ProviderAdapterError if malformed.
 */
function creatorRequirements(value: unknown): TikTokPublicationRequirements {
  const data = envelope(value);
  const creatorAvatarUrl =
    data.creator_avatar_url === undefined ? undefined : secureUrl(data.creator_avatar_url);
  const creatorUsername = boundedText(data.creator_username, 255);
  const creatorDisplayName = boundedText(data.creator_nickname, 500);
  const rawPrivacyLevels = data.privacy_level_options;
  const maxVideoDurationSeconds = data.max_video_post_duration_sec;
  if (
    (data.creator_avatar_url !== undefined && !creatorAvatarUrl) ||
    !creatorUsername ||
    !creatorDisplayName ||
    !Array.isArray(rawPrivacyLevels) ||
    rawPrivacyLevels.length < 1 ||
    rawPrivacyLevels.length > privacyLevels.size ||
    new Set(rawPrivacyLevels).size !== rawPrivacyLevels.length ||
    rawPrivacyLevels.some(
      (level) => typeof level !== "string" || !privacyLevels.has(level as TikTokPrivacyLevel),
    ) ||
    typeof data.comment_disabled !== "boolean" ||
    typeof data.duet_disabled !== "boolean" ||
    typeof data.stitch_disabled !== "boolean" ||
    !Number.isInteger(maxVideoDurationSeconds) ||
    (maxVideoDurationSeconds as number) < 1 ||
    (maxVideoDurationSeconds as number) > 600
  ) {
    throw malformed();
  }
  return {
    commentAllowed: !data.comment_disabled,
    ...(creatorAvatarUrl ? { creatorAvatarUrl } : {}),
    creatorDisplayName,
    creatorUsername,
    duetAllowed: !data.duet_disabled,
    maxVideoDurationSeconds: maxVideoDurationSeconds as number,
    platform: "tiktok",
    privacyLevels: [...rawPrivacyLevels] as TikTokPrivacyLevel[],
    stitchAllowed: !data.stitch_disabled,
  };
}

/**
 * Formats a canonical TikTok operation identifier string from a publish ID (e.g. 'publish:v_pub_file_123').
 * Returns formatted operation identifier string.
 */
function operationId(publishId: string): string {
  return `publish:${publishId}`;
}

/**
 * Extracts and validates the raw TikTok publish ID from an operation identifier string.
 * Strips the 'publish:' prefix.
 * Returns raw publish identifier string, or undefined if invalid.
 */
function publishId(value: unknown): string | undefined {
  const normalized = tiktokIdentifier(value);
  if (!normalized) return undefined;
  const match = normalized.match(/^publish:(.+)$/);
  return tiktokIdentifier(match?.[1]);
}

/**
 * Constructs a confirmed failure operation result for TikTok with optional retained operation ID.
 * Returns ProviderOperationResult object with outcome 'confirmed_failure'.
 */
function confirmedFailure(
  failure: ProviderFailure,
  retainedOperationId?: string,
): Extract<ProviderOperationResult, { outcome: "confirmed_failure" }> {
  return {
    failure,
    outcome: "confirmed_failure",
    ...(retainedOperationId ? { providerOperationId: retainedOperationId } : {}),
  };
}

/**
 * Determines whether a failure during TikTok publishing could represent an ambiguous remote side effect.
 * Returns true if failure classification is 'ambiguous', 'timeout', or 'transient', false otherwise.
 */
function canBeAmbiguous(failure: ProviderFailure): boolean {
  return ["ambiguous", "timeout", "transient"].includes(failure.classification);
}

/**
 * Instantiates a ProviderAdapter for TikTok Direct Post publishing and OAuth management.
 * Enforces pre-publish creator capability queries, PULL_FROM_URL media ingest, and strict option validation.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createTikTokAdapter(options: TikTokAdapterOptions): ProviderAdapter {
  const clientKey = required("clientKey", options.clientKey, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const mediaPrefix = configuredMediaPrefix(options.mediaUrlPrefix);
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [apiOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    rateLimitBudget: (headers) => extractRateLimitBudget("tiktok", headers),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  const getRequirements = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ): Promise<TikTokPublicationRequirements> => {
    accountId(credentials);
    const response = await http.request<unknown>(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      url: `${apiOrigin}/v2/post/publish/creator_info/query/`,
    });
    return creatorRequirements(response.body);
  };

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("tiktok", headers),
    /**
     * Builds the TikTok v2 authorize URL for the configured client key, redirect URI,
     * scopes, and caller-supplied state. Throws TypeError when the attempted redirect
     * URI does not match the adapter configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL("/v2/auth/authorize/", authorizationOrigin);
      url.searchParams.set("client_key", clientKey);
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", configuredScopes.join(","));
      url.searchParams.set("state", required("state", input.state, 1_024));
      return url.toString();
    },

    async cancelPublication(context, credentials, lookup) {
      accountId(credentials);
      const retainedOperationId = operationId(publishId(lookup.providerOperationId) ?? "");
      const retainedPublishId = publishId(retainedOperationId);
      if (!retainedPublishId) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "tiktok_publish_id_required",
            status: 400,
          }),
        );
      }
      try {
        const response = await http.request<unknown>(context, {
          body: JSON.stringify({ publish_id: retainedPublishId }),
          headers: {
            ...bearer(credentials.accessToken),
            "Content-Type": "application/json; charset=UTF-8",
          },
          method: "POST",
          sideEffectPossible: true,
          url: `${apiOrigin}/v2/post/publish/cancel/`,
        });
        envelope(response.body, true);
        return {
          outcome: "confirmed_success",
          providerOperationId: retainedOperationId,
        };
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        return canBeAmbiguous(cause.failure)
          ? unknownResult(cause.failure, retainedOperationId)
          : confirmedFailure(cause.failure, retainedOperationId);
      }
    },

    capability,

    /**
     * Exchanges the authorization code for TikTok OAuth tokens, then binds the
     * connection to the user profile whose open_id matches the token response. Throws
     * TypeError on redirect URI mismatch; returns the OAuthConnection with access and
     * refresh tokens, expiry, scopes, and the user's display name and avatar.
     */
    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const form = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code: required("authorizationCode", input.code),
        grant_type: "authorization_code",
        redirect_uri: configuredRedirectUri,
      });
      const tokenResponse = await http.request<unknown>(context, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${apiOrigin}/v2/oauth/token/`,
      });
      const tokens = tokenBody(tokenResponse.body, now());
      const userUrl = new URL("/v2/user/info/", apiOrigin);
      userUrl.searchParams.set("fields", "open_id,display_name,avatar_url");
      const userResponse = await http.request<unknown>(context, {
        headers: bearer(tokens.accessToken),
        method: "GET",
        url: userUrl.toString(),
      });
      const user = record(envelope(userResponse.body).user);
      const openId = tiktokIdentifier(user?.open_id);
      const displayName = boundedText(user?.display_name, 500);
      const avatarUrl = user?.avatar_url === undefined ? undefined : secureUrl(user.avatar_url);
      if (
        openId !== tokens.openId ||
        !displayName ||
        (user?.avatar_url !== undefined && !avatarUrl)
      ) {
        throw malformed();
      }
      return {
        accessToken: tokens.accessToken,
        account: {
          ...(avatarUrl ? { avatarUrl } : {}),
          displayName,
          id: openId,
        },
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: [...configuredScopes],
      };
    },

    getPublicationRequirements: getRequirements,

    /**
     * Reconciles a Direct Post operation through TikTok's status/fetch endpoint.
     * PROCESSING_UPLOAD/PROCESSING_DOWNLOAD stay pollable; SEND_TO_USER_INBOX is terminal
     * (the video landed as an inbox draft, not a public post) and maps to a non-retryable
     * confirmed failure so reconciliation stops instead of polling forever. PUBLISH_COMPLETE
     * accepts TikTok's documented identifier list and adopts the first validated entry as the
     * primary providerPostId. Returns ProviderPublicationStatus; throws on malformed envelopes.
     */
    async lookupPublication(context, credentials, lookup) {
      accountId(credentials);
      const retainedPublishId = publishId(lookup.providerOperationId);
      if (!retainedPublishId) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "tiktok_publish_id_required",
            status: 400,
          }),
        );
      }
      const retainedOperationId = operationId(retainedPublishId);
      const response = await http.request<unknown>(context, {
        body: JSON.stringify({ publish_id: retainedPublishId }),
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/json; charset=UTF-8",
        },
        method: "POST",
        url: `${apiOrigin}/v2/post/publish/status/fetch/`,
      });
      const responseBody = record(response.body);
      const responseError = record(responseBody?.error);
      if (responseError?.code === "invalid_publish_id") {
        return { state: "not_found" };
      }
      const data = envelope(response.body);
      const status = boundedString(data.status, 64);
      if (status === "PROCESSING_UPLOAD" || status === "PROCESSING_DOWNLOAD") {
        return {
          providerOperationId: retainedOperationId,
          state: "processing",
        };
      }
      if (status === "SEND_TO_USER_INBOX") {
        return {
          result: confirmedFailure(
            classifyProviderFailure({
              code: "tiktok_sent_to_inbox",
              status: 422,
            }),
            retainedOperationId,
          ),
          state: "failed",
        };
      }
      if (status === "FAILED") {
        const reason = boundedString(data.fail_reason, 80)?.toLowerCase();
        const code =
          reason && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(reason)
            ? `tiktok_${reason}`
            : "tiktok_publish_failed";
        return {
          result: confirmedFailure(
            classifyProviderFailure({ code, status: 422 }),
            retainedOperationId,
          ),
          state: "failed",
        };
      }
      if (status !== "PUBLISH_COMPLETE") throw malformed();
      const postIds = data.publicaly_available_post_id;
      if (
        postIds !== undefined &&
        (!Array.isArray(postIds) || postIds.some((id) => !tiktokIdentifier(id)))
      ) {
        throw malformed();
      }
      const providerPostId = Array.isArray(postIds) ? tiktokIdentifier(postIds[0]) : undefined;
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId: retainedOperationId,
          ...(providerPostId ? { providerPostId } : {}),
        },
        state: "published",
      };
    },

    /**
     * Executes a TikTok Direct Post publication for one video attachment or an
     * ordered set of up to 35 images as one photo post.
     * Validates the idempotency key, hashtag count, verified-prefix pull media
     * for every attachment, and creator options, then queries live creator
     * requirements before choosing the video or photo init endpoint. A set that
     * mixes kinds fails closed because TikTok publishes videos and photo posts
     * through different endpoints, and no attachment is ever dropped.
     * @param context - Request context carrying abort signal and rate telemetry.
     * @param credentials - Creator access token and open_id.
     * @param input - Composed caption plus the Post's ordered attachments.
     * @returns confirmed_success carrying only providerOperationId (never
     * providerPostId) so the caller reconciles through lookupPublication;
     * ambiguous transport failures return unknown.
     */
    async publish(context, credentials, input) {
      accountId(credentials);
      required("idempotencyKey", input.idempotencyKey, 255);
      validateHashtags(input);
      if (input.media.length === 0) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "tiktok_pull_media_required",
            status: 400,
          }),
        );
      }
      // Order is the creator's attachment order, so it must survive validation
      // unchanged: the published video and photo_images order both mirror it.
      const media = input.media.map((attachment) => pullMedia(attachment, mediaPrefix));
      // Videos and photo posts use different endpoints, so one publication must
      // be single-kind; a mixed set fails closed instead of dropping an attachment.
      const firstKind = attachmentKind(media[0]!);
      const isVideo = firstKind === "video";
      if (media.some((attachment) => attachmentKind(attachment) !== firstKind)) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "tiktok_mixed_media_unsupported",
            status: 400,
          }),
        );
      }
      const [first] = media;
      const choices = publishOptions(input);
      const requirements = await getRequirements(context, credentials);
      if (
        !requirements.privacyLevels.includes(choices.privacyLevel) ||
        (choices.allowComment && !requirements.commentAllowed) ||
        (choices.allowDuet && !requirements.duetAllowed) ||
        (choices.allowStitch && !requirements.stitchAllowed)
      ) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "tiktok_creator_choice_unavailable",
            status: 400,
          }),
        );
      }

      const caption = input.caption.trim();
      // `first` is the only attachment on a video publication, so its verified
      // facts are the whole publication's facts.
      const contentType = first!.contentType.split(";", 1)[0]!.toLowerCase();
      let endpoint: string;
      let body: Record<string, unknown>;
      if (isVideo) {
        const metadata = first!.metadata;
        if (
          media.length !== 1 ||
          caption.length > 2_200 ||
          !["video/mp4", "video/quicktime"].includes(contentType) ||
          !Number.isSafeInteger(first!.fileSize) ||
          first!.fileSize < 1 ||
          first!.fileSize > videoMaximumBytes ||
          !metadata ||
          !Number.isFinite(metadata.durationSeconds) ||
          metadata.durationSeconds! <= 0 ||
          metadata.durationSeconds! > requirements.maxVideoDurationSeconds ||
          !Number.isInteger(metadata.width) ||
          metadata.width! < 360 ||
          metadata.width! > 4_096 ||
          !Number.isInteger(metadata.height) ||
          metadata.height! < 360 ||
          metadata.height! > 4_096
        ) {
          throw new ProviderAdapterError(
            classifyProviderFailure({
              code: "tiktok_video_invalid",
              status: 400,
            }),
          );
        }
        endpoint = `${apiOrigin}/v2/post/publish/video/init/`;
        body = {
          post_info: {
            brand_content_toggle: choices.brandContent,
            brand_organic_toggle: choices.brandOrganic,
            disable_comment: !choices.allowComment,
            disable_duet: !choices.allowDuet,
            disable_stitch: !choices.allowStitch,
            is_aigc: choices.isAiGenerated,
            privacy_level: choices.privacyLevel,
            title: caption,
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: first!.url,
          },
        };
      } else {
        const title = caption
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);
        const imagesInvalid =
          media.length > maximumPhotoImages ||
          media.some((attachment) => {
            const metadata = attachment.metadata;
            return (
              !["image/jpeg", "image/webp"].includes(
                attachment.contentType.split(";", 1)[0]!.toLowerCase(),
              ) ||
              !Number.isSafeInteger(attachment.fileSize) ||
              attachment.fileSize < 1 ||
              attachment.fileSize > imageMaximumBytes ||
              !metadata ||
              !Number.isInteger(metadata.width) ||
              metadata.width! < 1 ||
              metadata.width! > 1_080 ||
              !Number.isInteger(metadata.height) ||
              metadata.height! < 1 ||
              metadata.height! > 1_080
            );
          });
        if (
          !title ||
          title.length > 90 ||
          caption.length > 4_000 ||
          choices.allowDuet ||
          choices.allowStitch ||
          choices.isAiGenerated ||
          imagesInvalid
        ) {
          throw new ProviderAdapterError(
            classifyProviderFailure({
              code: "tiktok_photo_invalid",
              status: 400,
            }),
          );
        }
        endpoint = `${apiOrigin}/v2/post/publish/content/init/`;
        body = {
          media_type: "PHOTO",
          post_info: {
            auto_add_music: false,
            brand_content_toggle: choices.brandContent,
            brand_organic_toggle: choices.brandOrganic,
            description: caption,
            disable_comment: !choices.allowComment,
            privacy_level: choices.privacyLevel,
            title,
          },
          post_mode: "DIRECT_POST",
          source_info: {
            photo_cover_index: 0,
            photo_images: media.map((attachment) => attachment.url),
            source: "PULL_FROM_URL",
          },
        };
      }

      try {
        const response = await http.request<unknown>(context, {
          body: JSON.stringify(body),
          headers: {
            ...bearer(credentials.accessToken),
            "Content-Type": "application/json; charset=UTF-8",
          },
          method: "POST",
          sideEffectPossible: true,
          url: endpoint,
        });
        const id = tiktokIdentifier(envelope(response.body, true).publish_id);
        if (!id) throw malformed(true);
        return {
          outcome: "confirmed_success",
          providerOperationId: operationId(id),
        };
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        return canBeAmbiguous(cause.failure)
          ? unknownResult(cause.failure)
          : confirmedFailure(cause.failure);
      }
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const form = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: required("refreshToken", refreshToken, 16_000),
      });
      const response = await http.request<unknown>(context, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${apiOrigin}/v2/oauth/token/`,
      });
      const tokens = tokenBody(response.body, now());
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: [...configuredScopes],
      };
    },

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 6,
      maxDelaySeconds: 900,
    },

    /** Revokes once; forwards caller/fiber cancellation to the token endpoint. */
    async revoke(accessToken, context) {
      const form = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        token: required("accessToken", accessToken, 16_000),
      });
      await http.request<undefined>(
        context ?? { operationId: "oauth-revoke", requestId: "oauth-revoke" },
        {
          body: form,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
