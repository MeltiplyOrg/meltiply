import type { PlatformCapability } from "@meltiply/domain";

import { confirmedFailure, isHttp404, malformed, requiredIdentifier } from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import { ProviderHttpClient } from "./http";
import { applyInstagramContent } from "./instagram-content";
import { resolveInstagramOptions, type ResolvedInstagramOptions } from "./instagram-options";
import {
  IDEMPOTENCY_KEY_MAX_CHARS,
  META_GRAPH_API_VERSION,
  OAUTH_STATE_MAX_CHARS,
  PROVIDER_LIMITS,
} from "./limits";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedString,
  boundedText,
  codePointLength,
  containerOperationId,
  exactRedirectUri,
  metricValue,
  normalizeContentType,
  parseContainerOperationId,
  parseMetaCommentPage,
  parseMetaInsightsMap,
  providerIdentifier,
  record,
  required,
  secureUrl,
  validatePageInput,
} from "./meta-common";
import { lookupMetaContainer, type MetaContainerProtocolConfig } from "./meta-containers";
import { exchangeAuthorizationCodeForm, parseMetaBearerToken } from "./oauth-helpers";
import { extractRateLimitBudget } from "./rate-limit";
import type {
  InstagramPostType,
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderPublicationLookup,
  ProviderTokenSet,
  PublishInput,
} from "./types";

const apiOrigin = "https://graph.instagram.com";
const exchangeOrigin = "https://api.instagram.com";
const authorizationOrigin = "https://www.instagram.com";
const apiVersion = META_GRAPH_API_VERSION;
const limits = PROVIDER_LIMITS.instagram;

const publishingScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;
const engagementScopes = [
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
] as const;

/** Instagram's caption ceiling remains known even before live publishing is configured. */
export const INSTAGRAM_MAX_CAPTION_LENGTH = limits.maxCaptionCodePoints;

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: INSTAGRAM_MAX_CAPTION_LENGTH,
  max_file_size: limits.maxVideoBytes,
  max_hashtags: limits.maxHashtags,
  max_media_count: limits.maxCarouselItems,
  max_video_duration_sec: null,
  min_media_count: 1,
  multi_asset_types: ["image", "video"],
  notes: [
    "Professional Business or Creator accounts use Instagram Login.",
    "Single images, videos, Reels, and Stories use public HTTPS remote-ingest URLs.",
    "Up to 20 images and videos combine as one feed carousel post.",
    "Trial Reels are shared to non-followers first and support manual or performance graduation.",
    "Images are limited to 8 MiB; Reels are limited to 300 MB and 15 minutes, and Story videos to 100 MB and 60 seconds.",
    "Live-account acceptance remains required before runtime enablement.",
  ],
  platform: "instagram",
  publish: true,
  reply: true,
};

export interface InstagramAdapterOptions {
  clientId: string;
  clientSecret: string;
  engagementEnabled?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

/**
 * Validates and extracts the professional Instagram account identifier from credentials.
 * Ensures the account is present and conforms to provider identifier structure.
 * Returns the validated Instagram account ID string. Throws ProviderAdapterError if absent or malformed.
 */
function accountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "instagram_professional_account_required");
}

/**
 * Extracts and asserts the required Instagram provider post/media identifier from a lookup object.
 * Used for status queries, analytics collection, and comment threads.
 * Returns the valid media ID string. Throws ProviderAdapterError if missing or malformed.
 */
function requiredPostId(lookup: ProviderPublicationLookup): string {
  return requiredIdentifier(lookup.providerPostId, "instagram_media_id_required");
}

/**
 * Validates and normalizes caption text for an Instagram post or Reel.
 * Enforces codepoint length limit (up to 2,200) and maximum hashtag count (up to 30).
 * Returns the trimmed caption text string. Throws ProviderAdapterError on validation failure.
 */
function caption(input: PublishInput): string {
  const value = input.caption.trim();
  if (
    codePointLength(value) > limits.maxCaptionCodePoints ||
    input.hashtags.length > limits.maxHashtags
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_content_invalid",
        status: 400,
      }),
    );
  }
  return value;
}

/** One validated Instagram attachment: its kind and the HTTPS URL Instagram fetches. */
interface InstagramAttachment {
  kind: "image" | "video";
  url: string;
}

/**
 * Validates one ordered remote-ingest attachment, keeping the JPEG-only image
 * ceiling and method-specific video bounds. Feed videos/carousel children use
 * the app's 500 MiB ceiling; only Reels use 300 MB and Stories use 100 MB.
 * @param input - Publish input whose `media[index]` is being validated.
 * @param media - Attachment at `index`.
 * @returns The attachment kind and its canonical HTTPS URL.
 * @throws ProviderAdapterError when the attachment cannot be published.
 */
function attachment(
  input: PublishInput,
  media: PublishInput["media"][number],
): InstagramAttachment {
  if (media.mode !== "remote_ingest") {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_remote_media_required",
        status: 400,
      }),
    );
  }
  const url = secureUrl(media.url)?.href;
  const contentType = normalizeContentType(media.contentType);
  const fileSize = media.fileSize;
  const postType =
    input.providerOptions?.instagram?.postType ??
    (input.media.length === 1 && contentType.startsWith("video/") ? "reel" : "feed");
  const maximumVideoBytes =
    postType === "story"
      ? limits.maxStoryBytes
      : postType === "reel"
        ? limits.maxReelBytes
        : limits.maxVideoBytes;
  const valid =
    url !== undefined &&
    Number.isSafeInteger(fileSize) &&
    fileSize >= 1 &&
    ((contentType === "image/jpeg" && fileSize <= limits.maxImageBytes) ||
      (["video/mp4", "video/quicktime"].includes(contentType) && fileSize <= maximumVideoBytes));
  if (!valid) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_media_invalid",
        status: 400,
      }),
    );
  }
  return {
    kind: contentType.startsWith("video/") ? "video" : "image",
    url,
  };
}

/**
 * Validates the ordered attachment set and reports the caption for this post.
 * Instagram requires at least one attachment and accepts at most 20 as one
 * carousel, so anything else fails closed here rather than being truncated.
 * @param input - Composed caption plus the Post's ordered attachments.
 * @returns Every validated attachment in creator order plus the trimmed caption.
 * @throws ProviderAdapterError on an empty, oversized, or invalid attachment set.
 */
function carouselAttachments(input: PublishInput): {
  attachments: InstagramAttachment[];
  text: string;
} {
  if (input.media.length === 0) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_media_required",
        status: 400,
      }),
    );
  }
  if (input.media.length > limits.maxCarouselItems) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_carousel_too_large",
        status: 400,
      }),
    );
  }
  return {
    attachments: input.media.map((media) => attachment(input, media)),
    text: caption(input),
  };
}

/**
 * Builds the container-creation parameters for one carousel item.
 * Items carry no caption — the caption belongs to the parent carousel — and
 * use is_carousel_item=true. Video children use VIDEO, not the standalone
 * REELS/share_to_feed surface, which Instagram does not accept in carousels.
 * @param item - The validated attachment to create a child container for.
 * @returns Parameters for the child container creation request.
 */
function carouselItemParameters(item: InstagramAttachment): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set("is_carousel_item", "true");
  if (item.kind === "image") {
    parameters.set("image_url", item.url);
  } else {
    parameters.set("media_type", "VIDEO");
    parameters.set("video_url", item.url);
  }
  return parameters;
}

/**
 * Builds the parent carousel container parameters that bind ordered child
 * container ids into one feed post. The caption is attached here rather than
 * on the children, so it appears exactly once on the published post.
 * @param children - Carousel child container ids in creator order.
 * @param text - Trimmed caption for the published post.
 * @returns Parameters for the parent container creation request.
 */
function carouselParentParameters(children: readonly string[], text: string): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text) parameters.set("caption", text);
  parameters.set("media_type", "CAROUSEL");
  parameters.set("children", children.join(","));
  return parameters;
}

/**
 * Resolves Instagram's publication shape against the actual attachment set,
 * failing closed when the stored choices cannot apply to this media set. The
 * rule lives in `instagram-options` so the pre-flight validator and this
 * adapter cannot disagree.
 *
 * @param input - Composed caption plus the Post's ordered attachments.
 * @param attachments - Validated attachments in creator order.
 * @returns The validated post type and trial settings.
 * @throws ProviderAdapterError when the choices cannot apply to this media set.
 */
function instagramOptions(
  input: PublishInput,
  attachments: readonly InstagramAttachment[],
): ResolvedInstagramOptions {
  const resolved = resolveInstagramOptions(
    input.providerOptions?.instagram,
    attachments.map((attachment) => attachment.kind),
  );
  if (!resolved) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_post_options_invalid",
        status: 400,
      }),
    );
  }
  return resolved;
}

/**
 * Builds container-creation parameters for a single-attachment post. Images
 * use a feed image or Story container; videos use VIDEO, REELS, or STORIES.
 * share_to_feed remains true for a standard Reel, and trial Reels carry the
 * documented graduation strategy.
 * @param item - The single validated attachment being published.
 * @param text - Trimmed caption for the published post.
 * @param options - Validated post type and trial settings.
 * @returns Parameters for the container creation request.
 */
function singleParameters(
  item: InstagramAttachment,
  text: string,
  options: {
    postType: InstagramPostType;
    trialGraduation: "manual" | "performance";
    trialReel: boolean;
  },
): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text && options.postType !== "story") parameters.set("caption", text);
  if (item.kind === "image") {
    parameters.set("image_url", item.url);
    if (options.postType === "story") parameters.set("media_type", "STORIES");
    return parameters;
  }
  parameters.set("video_url", item.url);
  if (options.postType === "story") {
    parameters.set("media_type", "STORIES");
    return parameters;
  }
  if (options.postType === "feed") {
    parameters.set("media_type", "VIDEO");
    return parameters;
  }
  parameters.set("media_type", "REELS");
  parameters.set("share_to_feed", "true");
  if (options.trialReel) {
    parameters.set(
      "trial_params",
      JSON.stringify({
        graduation_strategy:
          options.trialGraduation === "performance" ? "SS_PERFORMANCE" : "MANUAL",
      }),
    );
  }
  return parameters;
}

/** Instagram's Meta container protocol parameters. */
const containerProtocol: MetaContainerProtocolConfig = {
  apiOrigin,
  containerReadUrl(containerId) {
    const url = new URL(`/${apiVersion}/${encodeURIComponent(containerId)}`, apiOrigin);
    url.searchParams.set("fields", "id,status_code,status");
    return url.toString();
  },
  extractWarnings(body) {
    return body.config_issue === "CAPTION_NOT_ATTACHED" ||
      body.config_issue === "USER_TAGGING_FAILURE" ||
      body.caption_add_on_attachment_status === "POLL_CREATION_FAILURE" ||
      body.caption_add_on_attachment_status === "PROMPT_CREATION_FAILURE"
      ? ["instagram_publish_partial"]
      : undefined;
  },
  failureDetailField: "status",
  provider: "instagram",
  publishUrl(credentials, containerId) {
    const url = new URL(
      `/${apiVersion}/${encodeURIComponent(accountId(credentials))}/media_publish`,
      apiOrigin,
    );
    url.searchParams.set("creation_id", containerId);
    return url.toString();
  },
  publishedOperationPhase: "submitted",
  statusField: "status_code",
};

/**
 * Reads the single account in an Instagram Login response. Meta documents both
 * a Graph node object and a `data` envelope; multiple or empty entries cannot
 * identify the one professional account authorized by this token.
 */
function loginRecord(value: unknown): Record<string, unknown> {
  const body = record(value);
  if (!body) throw malformed();
  if (body.data === undefined) return body;
  if (!Array.isArray(body.data) || body.data.length !== 1) throw malformed();
  const account = record(body.data[0]);
  if (!account) throw malformed();
  return account;
}

/**
 * Instantiates a ProviderAdapter for Instagram Professional (Business/Creator) accounts.
 * Supports image and Reel publishing via container ingestion, analytics, comments, and replies.
 * Optionally omits engagement methods if options.engagementEnabled is false.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createInstagramAdapter(options: InstagramAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const engagementEnabled = options.engagementEnabled ?? true;
  const configuredScopes = engagementEnabled
    ? [...publishingScopes, ...engagementScopes]
    : [...publishingScopes];
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [apiOrigin, exchangeOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    platform: "instagram",
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  const engagementMethods: Pick<ProviderAdapter, "listAnalytics" | "listComments" | "reply"> = {
    async listAnalytics(context, credentials, lookup, page) {
      validatePageInput("instagram", page);
      if (page.cursor) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "instagram_analytics_not_paginated",
            status: 400,
          }),
        );
      }
      const providerPostId = requiredPostId(lookup);
      const url = new URL(
        `/${apiVersion}/${encodeURIComponent(providerPostId)}/insights`,
        apiOrigin,
      );
      url.searchParams.set("metric", "views,reach,likes,comments,shares");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const metrics = parseMetaInsightsMap(response.body);
      return {
        items: [
          {
            comments: metrics.get("comments") ?? 0,
            impressions: 0,
            likes: metrics.get("likes") ?? 0,
            providerPostId,
            reach: metrics.get("reach") ?? 0,
            recordedAt: now().toISOString(),
            shares: metrics.get("shares") ?? 0,
            views: metrics.get("views") ?? 0,
            watchTimeSeconds: 0,
          },
        ],
      };
    },

    async listComments(context, credentials, lookup, page) {
      validatePageInput("instagram", page);
      const providerPostId = requiredPostId(lookup);
      const url = new URL(
        `/${apiVersion}/${encodeURIComponent(providerPostId)}/comments`,
        apiOrigin,
      );
      url.searchParams.set("fields", "id,text,timestamp,from{id,username}");
      url.searchParams.set("limit", String(page.limit));
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      return parseMetaCommentPage(response.body, providerPostId, page.limit, {
        nestedAuthorField: "from",
        usernameField: "username",
      });
    },

    async reply(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
      const providerCommentId = providerIdentifier(input.providerCommentId);
      const text = boundedText(input.text.trim(), limits.maxCaptionCodePoints);
      if (!providerCommentId || !text) {
        return confirmedFailure("instagram_reply_invalid", 400);
      }
      const url = new URL(
        `/${apiVersion}/${encodeURIComponent(providerCommentId)}/replies`,
        apiOrigin,
      );
      const response = await http.request<unknown>(context, {
        body: JSON.stringify({ message: text }),
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/json",
        },
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      const replyId = providerIdentifier(record(response.body)?.id);
      if (!replyId) throw malformed(true);
      return { outcome: "confirmed_success", providerPostId: replyId };
    },
  };

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("instagram", headers),
    /**
     * Builds the Instagram OAuth authorize URL for the configured client, redirect URI,
     * publishing and engagement scopes, and caller-supplied state. Throws TypeError when
     * the attempted redirect URI does not match the adapter configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL("/oauth/authorize", authorizationOrigin);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("force_reauth", "true");
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", configuredScopes.join(","));
      url.searchParams.set("state", required("state", input.state, OAUTH_STATE_MAX_CHARS));
      return url.toString();
    },

    capability: {
      ...capability,
      analytics: engagementEnabled,
      comments: engagementEnabled,
      reply: engagementEnabled,
    },
    ambiguousZeroMetrics: ["views", "reactions", "comments", "shares"] as const,

    /**
     * Exchanges the authorization code for a short-lived token, upgrades it via
     * ig_exchange_token to a long-lived token, then reads the authorized Business or
     * Creator profile. The long-lived token authenticates `/me`; its `user_id`
     * is the professional account ID retained for publishing and webhooks.
     * Token-response and profile IDs need not match. Accepts permissions as a
     * live array or comma-separated string, rejecting malformed or incomplete grants;
     * retains the long-lived token as its own refresh token.
     */
    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const shortBody = loginRecord(
        await exchangeAuthorizationCodeForm(http, context, {
          clientId,
          clientSecret,
          code: input.code,
          redirectUri: configuredRedirectUri,
          tokenUrl: `${exchangeOrigin}/oauth/access_token`,
        }),
      );
      const shortToken = boundedString(shortBody.access_token, limits.tokenMaxChars);
      const exchangedAccountId = providerIdentifier(String(shortBody.user_id ?? ""));
      if (!shortToken || !exchangedAccountId) throw malformed();
      if (shortBody.permissions !== undefined) {
        let permissions: (string | undefined)[] | undefined;
        if (Array.isArray(shortBody.permissions)) {
          if (shortBody.permissions.length <= 32) {
            permissions = shortBody.permissions.map((scope: unknown) => boundedString(scope, 128));
          }
        } else {
          permissions = boundedString(shortBody.permissions, 4_096)
            ?.split(",")
            .map((scope) => scope.trim());
        }
        if (
          !permissions ||
          permissions.some((scope) => !scope) ||
          configuredScopes.some((scope) => !permissions.includes(scope))
        ) {
          throw new ProviderAdapterError(
            classifyProviderFailure({ code: "instagram_permissions_missing", status: 403 }),
          );
        }
      }

      const longUrl = new URL("/access_token", apiOrigin);
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", clientSecret);
      longUrl.searchParams.set("access_token", shortToken);
      const longResponse = await http.request<unknown>(context, {
        method: "GET",
        url: longUrl.toString(),
      });
      const { accessToken, expiresAt } = parseMetaBearerToken(longResponse.body, {
        maxLifetimeSeconds: limits.tokenLifetimeMaxSeconds,
        maxTokenChars: limits.tokenMaxChars,
        now: now(),
      });

      const profileUrl = new URL(`/${apiVersion}/me`, apiOrigin);
      profileUrl.searchParams.set(
        "fields",
        "id,user_id,username,name,profile_picture_url,account_type",
      );
      const profileResponse = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: profileUrl.toString(),
      });
      const profile = loginRecord(profileResponse.body);
      const profileScopedId = providerIdentifier(profile.id);
      const profileAccountId = providerIdentifier(profile.user_id);
      const username = boundedString(profile.username, 255);
      const name = boundedText(profile.name, 500);
      const displayName = name ?? (username ? boundedString(username, 500) : undefined);
      const avatarUrl =
        profile.profile_picture_url === undefined
          ? undefined
          : secureUrl(profile.profile_picture_url)?.href;
      if (
        !profileScopedId ||
        !profileAccountId ||
        !username ||
        !displayName ||
        !["BUSINESS", "MEDIA_CREATOR"].includes(String(profile.account_type).toUpperCase()) ||
        (profile.profile_picture_url !== undefined && !avatarUrl)
      ) {
        throw malformed();
      }
      return {
        accessToken,
        account: {
          ...(avatarUrl ? { avatarUrl } : {}),
          displayName,
          id: profileAccountId,
          ...(username ? { username } : {}),
        },
        expiresAt,
        refreshToken: accessToken,
        scopes: [...configuredScopes],
      };
    },

    /**
     * Reads the professional account's lifetime follower and media counters.
     * Accepts the same flat or single-account data envelope as Instagram Login;
     * a missing/invalid follower count or ambiguous account envelope fails closed.
     * Uses the publishing token; no Post identity is needed.
     */
    async getAccountAnalytics(context, credentials) {
      const url = new URL(`/${apiVersion}/me`, apiOrigin);
      url.searchParams.set("fields", "followers_count,follows_count,media_count");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = loginRecord(response.body);
      const followers = metricValue(body.followers_count);
      const following = metricValue(body.follows_count);
      const posts = metricValue(body.media_count);
      if (followers === undefined) throw malformed();
      return {
        followers,
        ...(following === undefined ? {} : { following }),
        ...(posts === undefined ? {} : { posts }),
        recordedAt: now().toISOString(),
      };
    },

    ...(engagementEnabled ? engagementMethods : {}),

    /**
     * Resolves publication status from either a confirmed media ID or a persisted
     * container operation identity. Media lookups confirm the permalink; container
     * lookups delegate to lookupMetaContainer, which polls readiness and finalizes a
     * 'created' container exactly once without ever republishing a 'submitted' one.
     */
    async lookupPublication(context, credentials, lookup) {
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      if (providerPostId) {
        const url = new URL(`/${apiVersion}/${encodeURIComponent(providerPostId)}`, apiOrigin);
        url.searchParams.set("fields", "id,permalink");
        try {
          const response = await http.request<unknown>(context, {
            headers: bearer(credentials.accessToken),
            method: "GET",
            url: url.toString(),
          });
          const body = record(response.body);
          const responseId = providerIdentifier(body?.id);
          const providerUrl = secureUrl(body?.permalink)?.href;
          if (responseId !== providerPostId || !providerUrl) throw malformed();
          return {
            result: {
              outcome: "confirmed_success",
              ...(providerIdentifier(lookup.providerOperationId)
                ? { providerOperationId: lookup.providerOperationId }
                : {}),
              providerPostId,
              providerUrl,
            },
            state: "published",
          };
        } catch (cause) {
          if (isHttp404(cause)) return { state: "not_found" };
          throw cause;
        }
      }
      const operation = parseContainerOperationId(lookup.providerOperationId);
      if (!operation) throw malformed();
      accountId(credentials);
      return lookupMetaContainer(http, containerProtocol, context, credentials, operation);
    },

    /**
     * Creates Instagram media containers for a post's ordered attachments and
     * returns the durable 'created:<parent>' operation identity without
     * publishing; lookupPublication polls the parent and finalizes it exactly
     * once. Multi-attachment posts first create one unpublished child container
     * per attachment in creator order, then a CAROUSEL parent that binds those
     * child ids in creator order. A single attachment keeps the direct image/Reel
     * container shape.
     * @param context - Request context carrying abort signal and rate telemetry.
     * @param credentials - Page access token and professional account id.
     * @param input - Composed caption plus the Post's ordered attachments.
     * @returns confirmed_success carrying only the container operation identity,
     * never a provider post id, so the caller reconciles through lookupPublication.
     */
    async publish(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
      const { attachments, text } = carouselAttachments(input);
      const account = accountId(credentials);
      const metadata = input.providerOptions?.instagram;
      const resolved = instagramOptions(input, attachments);
      if (resolved.postType === "story" && (text || input.hashtags.length)) {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "instagram_story_caption_unsupported", status: 400 }),
        );
      }

      const createContainer = async (
        parameters: URLSearchParams,
        childIndex?: number,
      ): Promise<string> => {
        if (childIndex !== undefined)
          applyInstagramContent(parameters, metadata?.mediaOptions?.[childIndex]);
        else {
          applyInstagramContent(parameters, metadata?.content);
          if (attachments.length === 1)
            applyInstagramContent(parameters, metadata?.mediaOptions?.[0]);
        }
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "POST",
          url: `${apiOrigin}/${apiVersion}/${encodeURIComponent(account)}/media?${parameters}`,
        });
        const containerId = providerIdentifier(record(response.body)?.id);
        if (!containerId) throw malformed();
        return containerId;
      };

      const [only] = attachments;
      if (attachments.length === 1 && only) {
        return {
          outcome: "confirmed_success",
          providerOperationId: containerOperationId(
            "created",
            await createContainer(singleParameters(only, text, resolved)),
          ),
        };
      }
      // Sequential child creation preserves creator order and short-circuits on
      // the first invalid attachment before creating later remote containers.
      const children: string[] = [];
      for (const [index, item] of attachments.entries()) {
        children.push(await createContainer(carouselItemParameters(item), index));
      }
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId(
          "created",
          await createContainer(carouselParentParameters(children, text)),
        ),
      };
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const currentToken = required("refreshToken", refreshToken);
      const url = new URL("/refresh_access_token", apiOrigin);
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", currentToken);
      const response = await http.request<unknown>(context, {
        method: "GET",
        url: url.toString(),
      });
      const { accessToken, expiresAt } = parseMetaBearerToken(response.body, {
        maxLifetimeSeconds: limits.tokenLifetimeMaxSeconds,
        maxTokenChars: limits.tokenMaxChars,
        now: now(),
      });
      return {
        accessToken,
        expiresAt,
        refreshToken: accessToken,
        scopes: [...configuredScopes],
      };
    },

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 6,
      maxDelaySeconds: 900,
    },

    transferModes: ["remote_ingest"],
  };
}
