import type { PlatformCapability } from "@meltiply/domain";

import {
  confirmedFailure,
  isHttp404,
  malformed,
  requiredIdentifier,
  unknownResult,
} from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import { ProviderHttpClient } from "./http";
import { IDEMPOTENCY_KEY_MAX_CHARS, OAUTH_STATE_MAX_CHARS, PROVIDER_LIMITS } from "./limits";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedString,
  boundedText,
  codePointLength,
  containerOperationId,
  exactRedirectUri,
  insightValue,
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
import {
  lookupMetaContainer,
  readMetaContainer,
  type MetaContainerProtocolConfig,
} from "./meta-containers";
import { exchangeAuthorizationCodeForm, parseMetaBearerToken } from "./oauth-helpers";
import { extractRateLimitBudget } from "./rate-limit";
import {
  applyThreadsOptions,
  parseThreadsOptions,
  threadsOptionsIssue,
  type ThreadsPublishOptions,
} from "./threads-options";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderPublicationLookup,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
} from "./types";

const apiOrigin = "https://graph.threads.com";
const authorizationOrigin = "https://threads.com";
const limits = PROVIDER_LIMITS.threads;

const publishingScopes = ["threads_basic", "threads_content_publish", "threads_delete"] as const;
const additionalPublishingScopes = [
  "threads_location_tagging",
  "threads_share_to_instagram",
  "threads_keyword_search",
  "threads_manage_mentions",
] as const;

const engagementScopes = [
  "threads_manage_insights",
  "threads_manage_replies",
  "threads_read_replies",
] as const;

/** Threads' caption ceiling remains known even before live publishing is configured. */
export const THREADS_MAX_CAPTION_LENGTH = limits.maxCaptionCodePoints;

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: THREADS_MAX_CAPTION_LENGTH,
  max_file_size: limits.maxVideoBytes,
  max_hashtags: limits.maxHashtags,
  max_media_count: limits.maxCarouselItems,
  max_video_duration_sec: limits.maxVideoDurationSeconds,
  min_media_count: 0,
  multi_asset_types: ["image", "video"],
  notes: [
    "Text, image, video, and carousel posts use the Threads container flow.",
    "Up to 20 images and videos combine as one carousel post.",
    "Text-only containers support polls, GIPHY GIFs, long-text attachments, and 24-hour ghost Posts; quotes, replies, and reposts preserve the source identity.",
    "Location and Instagram Story cross-sharing need optional grants; country restrictions need an eligible account.",
    "Images are limited to 8 MiB; videos use Meltiply's 500 MiB upload ceiling.",
    "Only the first in-text hashtag becomes a native topic tag; other hashtags remain ordinary caption text.",
    "Media is transferred through a short-lived HTTPS remote-ingest URL.",
    "Live-account acceptance remains required before runtime enablement.",
  ],
  platform: "threads",
  publish: true,
  reply: true,
};

export interface ThreadsAdapterOptions {
  clientId: string;
  clientSecret: string;
  engagementEnabled?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

/**
 * Validates and extracts caption text for a Threads post.
 * Enforces the 500-codepoint caption ceiling; only the first in-text tag becomes
 * a native topic tag, so additional literal hashtags do not invalidate the Post.
 * Returns trimmed caption string. Throws ProviderAdapterError on constraint violations.
 */
function postText(input: PublishInput): string {
  const caption = input.caption.trim();
  if (codePointLength(caption) > THREADS_MAX_CAPTION_LENGTH) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_content_invalid",
        status: 400,
      }),
    );
  }
  return caption;
}

/** One validated Threads attachment: its kind and the HTTPS URL Threads fetches. */
interface ThreadsAttachment {
  kind: "image" | "video";
  url: string;
}

/**
 * Validates one ordered attachment for a Threads container, enforcing
 * remote_ingest mode, an HTTPS URL, JPEG/PNG under 8 MiB, and MP4/MOV under the
 * 500 MiB upload ceiling. Carousel items are held to the same bounds as single
 * posts because Threads publishes them as one container.
 * @param media - Attachment in creator order.
 * @returns The attachment kind and its canonical HTTPS URL.
 * @throws ProviderAdapterError when the attachment cannot be published.
 */
function attachment(media: PublishInput["media"][number]): ThreadsAttachment {
  if (media.mode !== "remote_ingest") {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_remote_media_required",
        status: 400,
      }),
    );
  }
  const mediaUrl = secureUrl(media.url)?.href;
  if (!mediaUrl) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_media_url_invalid",
        status: 400,
      }),
    );
  }
  const contentType = normalizeContentType(media.contentType);
  const fileSize = media.fileSize;
  const valid =
    Number.isSafeInteger(fileSize) &&
    fileSize >= 1 &&
    ((["image/jpeg", "image/png"].includes(contentType) && fileSize <= limits.maxImageBytes) ||
      (["video/mp4", "video/quicktime"].includes(contentType) && fileSize <= limits.maxVideoBytes));
  if (!valid) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_media_invalid",
        status: 400,
      }),
    );
  }
  return {
    kind: contentType.startsWith("video/") ? "video" : "image",
    url: mediaUrl,
  };
}

/**
 * Builds the query parameters for one carousel item container. Items carry no
 * text — the post text belongs to the parent container — and are marked
 * is_carousel_item=true with an IMAGE or VIDEO media_type discriminator so
 * Threads holds them unpublished until the parent binds them.
 * @param item - The validated attachment to create an item container for.
 * @returns Parameters for the item container creation request.
 */
function carouselItemParameters(item: ThreadsAttachment): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set("is_carousel_item", "true");
  parameters.set("media_type", item.kind === "image" ? "IMAGE" : "VIDEO");
  parameters.set(item.kind === "image" ? "image_url" : "video_url", item.url);
  return parameters;
}

/**
 * Builds a TEXT parent container. Plain Posts require text; a validated GIF or
 * long-text attachment supplies its own content and does not need a fabricated
 * teaser caption. Media Posts use their separate explicit media discriminators.
 */
function textParameters(text: string, options: ThreadsPublishOptions): URLSearchParams {
  if (!text && !options.gif_attachment && !options.text_attachment) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_text_invalid",
        status: 400,
      }),
    );
  }
  const parameters = new URLSearchParams();
  if (text) parameters.set("text", text);
  parameters.set("media_type", "TEXT");
  return parameters;
}

/**
 * Builds container parameters for a single-attachment Threads post, keeping
 * the historical IMAGE or VIDEO shape so accepted behavior and its
 * reconciliation lifecycle are unchanged.
 * @param item - The single validated attachment being published.
 * @param text - Trimmed post text, omitted when empty.
 * @returns Parameters for the container creation request.
 */
function singleParameters(item: ThreadsAttachment, text: string): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text) parameters.set("text", text);
  parameters.set("media_type", item.kind === "image" ? "IMAGE" : "VIDEO");
  parameters.set(item.kind === "image" ? "image_url" : "video_url", item.url);
  return parameters;
}

/**
 * Builds the parent carousel container parameters that bind ordered item
 * container ids into one Threads post. The post text is attached here rather
 * than on the items, so it appears exactly once on the published post.
 * @param children - Carousel item container ids in creator order.
 * @param text - Trimmed post text, omitted when empty.
 * @returns Parameters for the parent container creation request.
 */
function carouselParentParameters(children: readonly string[], text: string): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text) parameters.set("text", text);
  parameters.set("media_type", "CAROUSEL");
  parameters.set("children", children.join(","));
  return parameters;
}

/**
 * Validates the ordered attachment set and the post text for one Threads post,
 * accepting zero attachments (text-only), one attachment, or up to 20 ordered
 * attachments that become a single carousel post.
 * @param input - Composed text plus the Post's ordered attachments.
 * @returns Validated attachments in creator order plus the trimmed post text.
 * @throws ProviderAdapterError on an oversized or invalid attachment set, or on
 * an attachment-free post with no text to publish.
 */
function postAttachments(input: PublishInput): {
  attachments: ThreadsAttachment[];
  text: string;
} {
  if (input.media.length > limits.maxCarouselItems) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_carousel_too_large",
        status: 400,
      }),
    );
  }
  return {
    attachments: input.media.map(attachment),
    text: postText(input),
  };
}

/**
 * Extracts and validates the required Threads post identifier from a publication lookup request.
 * Used for status checking, analytics collection, and comment retrieval.
 * Returns validated provider post ID string. Throws ProviderAdapterError if missing or malformed.
 */
function requiredPostId(lookup: ProviderPublicationLookup): string {
  return requiredIdentifier(lookup.providerPostId, "threads_post_id_required");
}

/** Threads' Meta container protocol parameters. */
const containerProtocol: MetaContainerProtocolConfig = {
  apiOrigin,
  containerReadUrl(containerId) {
    const url = new URL(`/${encodeURIComponent(containerId)}`, apiOrigin);
    url.searchParams.set("fields", "id,status,error_message");
    return url.toString();
  },
  extractWarnings(body) {
    return body.crossreshare_to_ig_status === "FAILED"
      ? ["instagram_crossshare_failed"]
      : undefined;
  },
  failureDetailField: "error_message",
  provider: "threads",
  publishUrl(_credentials, containerId) {
    const url = new URL("/me/threads_publish", apiOrigin);
    url.searchParams.set("creation_id", containerId);
    return url.toString();
  },
  publishedOperationPhase: "retain",
  statusField: "status",
};

/**
 * Instantiates a ProviderAdapter for Threads publishing, replies, comments, and analytics.
 * Configures Graph API endpoints, container creation and publication flow,
 * rate limit extraction, token refreshes, and optional engagement method exclusion.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createThreadsAdapter(options: ThreadsAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const engagementEnabled = options.engagementEnabled ?? true;
  const configuredScopes = [
    ...publishingScopes,
    ...additionalPublishingScopes,
    ...(engagementEnabled ? engagementScopes : []),
  ];
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [apiOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    platform: "threads",
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  /**
   * Introspects the current token with the app credential, retaining only
   * provider-reported grants. Requesting a new optional publishing permission
   * cannot make an existing account appear to have granted it after refresh.
   */
  const grantedScopes = async (
    context: ProviderRequestContext,
    token: string,
    expectedAccount?: string,
  ): Promise<string[]> => {
    const url = new URL("/v1.0/debug_token", apiOrigin);
    url.searchParams.set("input_token", token);
    const response = await http.request<unknown>(context, {
      headers: bearer(`TH|${clientId}|${clientSecret}`),
      method: "GET",
      url: url.toString(),
    });
    const data = record(record(response.body)?.data);
    const rawScopes = data?.scopes;
    if (
      data?.is_valid !== true ||
      !providerIdentifier(data.user_id) ||
      (expectedAccount && data.user_id !== expectedAccount) ||
      !Array.isArray(rawScopes)
    ) {
      throw malformed();
    }
    const scopes = new Set<string>();
    for (const scope of rawScopes) {
      if (typeof scope !== "string" || !/^[a-z_]+$/.test(scope)) throw malformed();
      scopes.add(scope);
    }
    return [...scopes];
  };

  const engagementMethods: Pick<ProviderAdapter, "listAnalytics" | "listComments" | "reply"> = {
    async listAnalytics(context, credentials, lookup, page) {
      validatePageInput("threads", page);
      if (page.cursor) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "threads_analytics_not_paginated",
            status: 400,
          }),
        );
      }
      const providerPostId = requiredPostId(lookup);
      const url = new URL(`/${encodeURIComponent(providerPostId)}/insights`, apiOrigin);
      url.searchParams.set("metric", "views,likes,replies,reposts,quotes,shares");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const metrics = parseMetaInsightsMap(response.body, { valuesOnly: true });
      return {
        items: [
          {
            comments: metrics.get("replies") ?? 0,
            impressions: 0,
            likes: metrics.get("likes") ?? 0,
            providerPostId,
            reach: 0,
            recordedAt: now().toISOString(),
            shares:
              (metrics.get("shares") ?? 0) +
              (metrics.get("reposts") ?? 0) +
              (metrics.get("quotes") ?? 0),
            views: metrics.get("views") ?? 0,
            watchTimeSeconds: 0,
          },
        ],
      };
    },

    async listComments(context, credentials, lookup, page) {
      validatePageInput("threads", page);
      const providerPostId = requiredPostId(lookup);
      const url = new URL(`/${encodeURIComponent(providerPostId)}/conversation`, apiOrigin);
      url.searchParams.set("fields", "id,text,timestamp,username,profile_picture_url");
      url.searchParams.set("limit", String(page.limit));
      url.searchParams.set("reverse", "false");
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      return parseMetaCommentPage(response.body, providerPostId, page.limit, {
        avatarField: "profile_picture_url",
        usernameField: "username",
      });
    },

    /**
     * Creates a Threads reply container and returns its durable 'created:<container>'
     * operation identity without publishing. Reply containers follow the same readiness
     * lifecycle as distribution containers: lookupPublication polls the container and
     * finalizes it exactly once, so a reply is never published before it is ready.
     */
    async reply(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
      const providerCommentId = providerIdentifier(input.providerCommentId);
      const text = boundedText(input.text.trim(), THREADS_MAX_CAPTION_LENGTH);
      if (!providerCommentId || !text) {
        return confirmedFailure("threads_reply_invalid", 400);
      }
      const url = new URL("/me/threads", apiOrigin);
      url.searchParams.set("media_type", "TEXT");
      url.searchParams.set("reply_to_id", providerCommentId);
      url.searchParams.set("text", text);
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        url: url.toString(),
      });
      const containerId = providerIdentifier(record(response.body)?.id);
      if (!containerId) throw malformed();
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId("created", containerId),
      };
    },
  };

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("threads", headers),
    /**
     * Builds the Threads OAuth authorize URL for the configured client, redirect URI,
     * publishing and engagement scopes, and caller-supplied state. Throws TypeError when
     * the attempted redirect URI does not match the adapter configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL("/oauth/authorize", authorizationOrigin);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", configuredScopes.join(","));
      url.searchParams.set("state", required("state", input.state, OAUTH_STATE_MAX_CHARS));
      return url.toString();
    },

    /**
     * Cancels a published Threads post, or resolves a container operation that never
     * produced a post. Without a post ID the container is inspected read-only: a failed
     * or vanished container means nothing was published, while any live container stays
     * ambiguous because a container ID cannot authorize deletion of a published post.
     */
    async cancelPublication(context, credentials, lookup) {
      const providerPostId = providerIdentifier(lookup.providerPostId);
      const providerOperationId = providerIdentifier(lookup.providerOperationId);
      if (!providerPostId) {
        const operation = parseContainerOperationId(providerOperationId);
        if (!operation) {
          return confirmedFailure("threads_cancel_evidence_invalid", 400);
        }
        const retainedOperationId = containerOperationId(operation.phase, operation.id);
        const body = await readMetaContainer(
          http,
          containerProtocol,
          context,
          credentials.accessToken,
          operation.id,
        );
        if (!body || body.status === "ERROR" || body.status === "EXPIRED") {
          return {
            outcome: "confirmed_success",
            providerOperationId: retainedOperationId,
          };
        }
        return unknownResult(
          classifyProviderFailure({
            code: "threads_cancel_requires_post_id",
            sideEffectPossible: true,
          }),
          retainedOperationId,
        );
      }
      try {
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "DELETE",
          sideEffectPossible: true,
          url: `${apiOrigin}/${encodeURIComponent(providerPostId)}`,
        });
        const body = record(response.body);
        if (
          body?.success !== true ||
          (body.deleted_id !== undefined && providerIdentifier(body.deleted_id) !== providerPostId)
        ) {
          throw malformed(true);
        }
        return {
          outcome: "confirmed_success",
          ...(providerOperationId ? { providerOperationId } : {}),
          providerPostId,
        };
      } catch (cause) {
        if (isHttp404(cause)) {
          return {
            outcome: "confirmed_success",
            ...(providerOperationId ? { providerOperationId } : {}),
            providerPostId,
          };
        }
        throw cause;
      }
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
     * th_exchange_token to a long-lived token, then binds the connection to the Threads
     * profile returned by /me. The profile's string ID is authoritative; numeric
     * user_id values in the token response can exceed JavaScript's safe integer range.
     * Uses Meta's required access_token query parameter for token exchange.
     * Throws on malformed responses or redirect mismatch; retains the long-lived
     * token as its own refresh token.
     */
    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const shortBody = record(
        await exchangeAuthorizationCodeForm(http, context, {
          clientId,
          clientSecret,
          code: input.code,
          redirectUri: configuredRedirectUri,
          tokenUrl: `${apiOrigin}/oauth/access_token`,
        }),
      );
      const shortToken = boundedString(shortBody?.access_token, limits.tokenMaxChars);
      if (!shortToken || !providerIdentifier(String(shortBody?.user_id ?? ""))) {
        throw malformed();
      }

      const longUrl = new URL("/access_token", apiOrigin);
      longUrl.searchParams.set("grant_type", "th_exchange_token");
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

      const profileUrl = new URL("/me", apiOrigin);
      profileUrl.searchParams.set("fields", "id,username,name,threads_profile_picture_url");
      const profileResponse = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: profileUrl.toString(),
      });
      const profile = record(profileResponse.body);
      const accountId = providerIdentifier(profile?.id);
      const username = boundedString(profile?.username, 255);
      const name = boundedText(profile?.name, 500);
      const displayName = name ?? (username ? boundedString(username, 500) : undefined);
      const avatarUrl =
        profile?.threads_profile_picture_url === undefined
          ? undefined
          : secureUrl(profile.threads_profile_picture_url)?.href;
      if (
        !accountId ||
        !username ||
        !displayName ||
        (profile?.threads_profile_picture_url !== undefined && !avatarUrl)
      ) {
        throw malformed();
      }
      return {
        accessToken,
        account: {
          ...(avatarUrl ? { avatarUrl } : {}),
          displayName,
          id: accountId,
          ...(username ? { username } : {}),
        },
        expiresAt,
        refreshToken: accessToken,
        scopes: await grantedScopes(context, accessToken, accountId),
      };
    },

    /**
     * Reads lifetime follower count from the Threads user insights edge.
     * Threads returns the total under `total_value` (or a values array).
     */
    async getAccountAnalytics(context, credentials) {
      const providerAccountId = requiredIdentifier(
        credentials.accountId,
        "threads_account_id_required",
      );
      const url = new URL(`/${encodeURIComponent(providerAccountId)}/threads_insights`, apiOrigin);
      url.searchParams.set("metric", "followers_count");
      url.searchParams.set("period", "lifetime");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const data = record(response.body)?.data;
      if (!Array.isArray(data)) throw malformed();
      const metric = data.map(record).find((item) => item?.name === "followers_count");
      const followers = metric ? insightValue(metric) : undefined;
      if (followers === undefined) throw malformed();
      return { followers, recordedAt: now().toISOString() };
    },

    ...(engagementEnabled ? engagementMethods : {}),

    /**
     * Resolves publication status from either a confirmed post ID or a persisted
     * container operation identity. A matching Post ID confirms publication even
     * when Meta omits a copyright-restricted permalink; present URLs stay validated.
     * Container lookups delegate to lookupMetaContainer, which polls readiness and finalizes a
     * 'created' container exactly once without ever republishing a 'submitted' one.
     */
    async lookupPublication(context, credentials, lookup) {
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      if (providerPostId) {
        const url = new URL(`/${encodeURIComponent(providerPostId)}`, apiOrigin);
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
          if (responseId !== providerPostId || (body?.permalink !== undefined && !providerUrl))
            throw malformed();
          return {
            result: {
              outcome: "confirmed_success",
              ...(providerIdentifier(lookup.providerOperationId)
                ? { providerOperationId: lookup.providerOperationId }
                : {}),
              providerPostId,
              ...(providerUrl ? { providerUrl } : {}),
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
      return lookupMetaContainer(http, containerProtocol, context, credentials, operation);
    },

    /**
     * Creates a durable 'created:<parent>' operation for text or ordered media;
     * lookupPublication polls readiness and finalizes it exactly once. Text
     * containers can also be asynchronous, so they never bypass that gate.
     * Multi-attachment posts first create one unpublished item container per
     * attachment in creator order, then a CAROUSEL parent binding those item ids.
     * @param context - Request context carrying abort signal and rate telemetry.
     * @param credentials - Threads long-lived access token.
     * @param input - Composed post text plus the Post's ordered attachments.
     * @returns confirmed_success carrying the container operation awaiting
     * reconciliation, or the published identity of a native repost.
     */
    async publish(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, IDEMPOTENCY_KEY_MAX_CHARS);
      const { attachments, text } = postAttachments(input);
      const options = parseThreadsOptions(input.providerOptions?.threads ?? {});
      if (!options || threadsOptionsIssue(options, text, attachments.length)) {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "threads_publish_options_invalid", status: 400 }),
        );
      }
      if (options.repost_id) {
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "POST",
          sideEffectPossible: true,
          url: new URL(`/${encodeURIComponent(options.repost_id)}/repost`, apiOrigin).toString(),
        });
        const providerPostId = providerIdentifier(record(response.body)?.id);
        if (!providerPostId) throw malformed(true);
        return { outcome: "confirmed_success", providerPostId };
      }

      const createContainer = async (
        parameters: URLSearchParams,
        parent = true,
      ): Promise<string> => {
        if (parent) applyThreadsOptions(parameters, options);
        const createUrl = new URL("/me/threads", apiOrigin);
        createUrl.search = parameters.toString();
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "POST",
          url: createUrl.toString(),
        });
        const containerId = providerIdentifier(record(response.body)?.id);
        if (!containerId) throw malformed();
        return containerId;
      };

      const [only] = attachments;
      if (attachments.length <= 1) {
        return {
          outcome: "confirmed_success",
          providerOperationId: containerOperationId(
            "created",
            await createContainer(
              only ? singleParameters(only, text) : textParameters(text, options),
            ),
          ),
        };
      }
      // Sequential item creation preserves creator order and stops on the first
      // rejected attachment before creating later remote containers.
      const children: string[] = [];
      for (const item of attachments) {
        children.push(await createContainer(carouselItemParameters(item), false));
      }
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId(
          "created",
          await createContainer(carouselParentParameters(children, text)),
        ),
      };
    },

    /**
     * Refreshes an unexpired, at-least-24-hour-old Threads long-lived token through
     * Meta's documented query parameters; returns the rotated token and expiry.
     * Provider errors propagate so expired grants require authorization again.
     */
    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const currentToken = required("refreshToken", refreshToken);
      const url = new URL("/refresh_access_token", apiOrigin);
      url.searchParams.set("grant_type", "th_refresh_token");
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
        scopes: await grantedScopes(context, accessToken),
      };
    },

    retryPolicy: {
      baseDelaySeconds: 15,
      maxAttempts: 5,
      maxDelaySeconds: 300,
    },

    transferModes: ["remote_ingest"],
  };
}
