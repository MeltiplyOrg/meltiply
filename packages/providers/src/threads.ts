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
import { ProviderHttpClient } from "./http";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  containerOperationId,
  exactRedirectUri,
  metaContainerFailureCode,
  metricValue,
  parseContainerOperationId,
  providerIdentifier,
  record,
  required,
  secureUrl,
  timestamp,
  validatePageInput,
} from "./meta-common";
import type { MetaContainerOperation } from "./meta-common";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderOperationResult,
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
} from "./types";

const apiOrigin = "https://graph.threads.com";
const authorizationOrigin = "https://threads.com";
const imageMaximumBytes = 8 * 1024 * 1024;
const videoMaximumBytes = 500 * 1024 * 1024;
const tokenLifetimeMaximumSeconds = 90 * 24 * 60 * 60;

const publishingScopes = ["threads_basic", "threads_content_publish", "threads_delete"] as const;

const engagementScopes = [
  "threads_manage_insights",
  "threads_manage_replies",
  "threads_read_replies",
] as const;

/** Threads' caption ceiling remains known even before live publishing is configured. */
export const THREADS_MAX_CAPTION_LENGTH = 500;

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: THREADS_MAX_CAPTION_LENGTH,
  max_file_size: videoMaximumBytes,
  max_hashtags: 1,
  max_media_count: 20,
  max_video_duration_sec: 300,
  min_media_count: 0,
  multi_asset_types: ["image", "video"],
  notes: [
    "Text, image, video, and carousel posts use the Threads container flow.",
    "Up to 20 images and videos combine as one carousel post.",
    "Images are limited to 8 MiB; videos use Meltiply's 500 MiB upload ceiling.",
    "Media is transferred through a short-lived HTTPS remote-ingest URL.",
    "Live-account acceptance remains required before runtime enablement.",
  ],
  platform: "threads",
  publish: true,
  reply: true,
};

/** Threads' documented carousel ceiling of items in a single container. */
const maximumCarouselItems = 20;

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
 * Enforces Threads-specific constraints: maximum 500 Unicode codepoints and at most 1 hashtag.
 * Returns trimmed caption string. Throws ProviderAdapterError on constraint violations.
 */
function postText(input: PublishInput): string {
  const caption = input.caption.trim();
  if ([...caption].length > THREADS_MAX_CAPTION_LENGTH || input.hashtags.length > 1) {
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
 * @param input - Publish input whose `media[index]` is being validated.
 * @param index - Attachment position in creator order.
 * @returns The attachment kind and its canonical HTTPS URL.
 * @throws ProviderAdapterError when the attachment cannot be published.
 */
function attachment(input: PublishInput, index: number): ThreadsAttachment {
  const media = input.media[index]!;
  if (media.mode !== "remote_ingest") {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_remote_media_required",
        status: 400,
      }),
    );
  }
  const mediaUrl = secureUrl(media.url);
  if (!mediaUrl) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_media_url_invalid",
        status: 400,
      }),
    );
  }
  const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
  const fileSize = media.fileSize;
  const valid =
    Number.isSafeInteger(fileSize) &&
    fileSize >= 1 &&
    ((["image/jpeg", "image/png"].includes(contentType) && fileSize <= imageMaximumBytes) ||
      (["video/mp4", "video/quicktime"].includes(contentType) && fileSize <= videoMaximumBytes));
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
 * Builds the parent container parameters for a Threads post without
 * attachments: a text-only post uses the synchronous TEXT container and
 * requires text, so an attachment-free post with nothing to say is rejected.
 * @param text - Trimmed post text.
 * @returns Parameters for the TEXT container creation request.
 * @throws ProviderAdapterError when there is no text to publish.
 */
function textParameters(text: string): URLSearchParams {
  if (!text) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_text_invalid",
        status: 400,
      }),
    );
  }
  const parameters = new URLSearchParams();
  parameters.set("text", text);
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
  if (input.media.length > maximumCarouselItems) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "threads_carousel_too_large",
        status: 400,
      }),
    );
  }
  return {
    attachments: input.media.map((_, index) => attachment(input, index)),
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

/**
 * Instantiates a ProviderAdapter for Threads publishing, replies, comments, and analytics.
 * Configures Graph API endpoints on graph.threads.net, container creation and publication flow,
 * rate limit extraction, token refreshes, and optional engagement method exclusion.
 * Returns configured ProviderAdapter conforming to Meltiply contracts.
 */
export function createThreadsAdapter(options: ThreadsAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const engagementEnabled = options.engagementEnabled ?? true;
  const configuredScopes = engagementEnabled
    ? [...publishingScopes, ...engagementScopes]
    : [...publishingScopes];
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [apiOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    rateLimitBudget: (headers) => extractRateLimitBudget("threads", headers),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  /**
   * Issues the single finalizing publish for a ready Threads media container.
   * Success and deterministic rejection retain the 'created' operation identity; an
   * ambiguous outcome records 'submitted:<container>' so reconciliation can prove the
   * publish was dispatched and must never be issued again.
   * Returns the normalized ProviderOperationResult for the publish attempt.
   */
  const publishContainer = async (
    context: ProviderRequestContext,
    accessToken: string,
    containerId: string,
  ): Promise<ProviderOperationResult> => {
    const url = new URL("/me/threads_publish", apiOrigin);
    url.searchParams.set("creation_id", containerId);
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      const providerPostId = providerIdentifier(record(response.body)?.id);
      if (!providerPostId) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId("created", containerId),
        providerPostId,
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      return cause.failure.classification === "ambiguous"
        ? unknownResult(cause.failure, containerOperationId("submitted", containerId))
        : {
            failure: cause.failure,
            outcome: "confirmed_failure",
            providerOperationId: containerOperationId("created", containerId),
          };
    }
  };

  /**
   * Reads a Threads media container's processing status without side effects.
   * Requests the documented `status` and `error_message` fields; the raw error detail is
   * bounded here and only ever consumed through metaContainerFailureCode so provider
   * payloads are never persisted or returned.
   * Returns the validated container record, or undefined when the container is gone (404).
   * Throws ProviderAdapterError on transport failure or malformed payloads.
   */
  const readContainer = async (
    context: ProviderRequestContext,
    accessToken: string,
    containerId: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const url = new URL(`/${encodeURIComponent(containerId)}`, apiOrigin);
    url.searchParams.set("fields", "id,status,error_message");
    let response;
    try {
      response = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: url.toString(),
      });
    } catch (cause) {
      if (isHttp404(cause)) return undefined;
      throw cause;
    }
    const body = record(response.body);
    if (providerIdentifier(body?.id) !== containerId) throw malformed();
    return body;
  };

  /**
   * Reconciles a persisted Threads container operation into a publication status.
   * A 'created' container that reports FINISHED is finalized exactly once through
   * publishContainer; a 'submitted' container is never republished, so FINISHED stays
   * an ambiguous outcome awaiting operator disposition. Container ERROR detail is
   * normalized to a safe diagnostic category code.
   * Returns ProviderPublicationStatus for the operation, or not_found when the
   * container no longer exists.
   */
  const lookupContainer = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: MetaContainerOperation,
  ): Promise<ProviderPublicationStatus> => {
    const retainedOperationId = containerOperationId(operation.phase, operation.id);
    const body = await readContainer(context, credentials.accessToken, operation.id);
    if (!body) return { state: "not_found" };
    switch (body.status) {
      case "IN_PROGRESS":
        return {
          providerOperationId: retainedOperationId,
          state: "processing",
        };
      case "FINISHED":
        if (operation.phase === "created") {
          const result = await publishContainer(context, credentials.accessToken, operation.id);
          if (result.outcome === "confirmed_success") {
            return { result, state: "published" };
          }
          if (result.outcome === "unknown") {
            return { result, state: "unknown" };
          }
          // A retryable publish rejection keeps the ready container under its
          // 'created' identity so the next poll retries finalization.
          return result.failure.retryable
            ? {
                providerOperationId: retainedOperationId,
                state: "processing",
              }
            : { result, state: "failed" };
        }
        return {
          result: unknownResult(
            classifyProviderFailure({
              code: "threads_publish_evidence_missing",
              sideEffectPossible: true,
            }),
            retainedOperationId,
          ),
          state: "unknown",
        };
      case "PUBLISHED":
        return {
          result: {
            outcome: "confirmed_success",
            providerOperationId: retainedOperationId,
          },
          state: "published",
        };
      case "ERROR":
        return {
          result: confirmedFailure(
            metaContainerFailureCode("threads", body.error_message),
            422,
            retainedOperationId,
          ),
          state: "failed",
        };
      case "EXPIRED":
        return {
          result: confirmedFailure("threads_container_expired", 410, retainedOperationId),
          state: "failed",
        };
      default:
        throw malformed();
    }
  };

  const adapter: ProviderAdapter = {
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
      url.searchParams.set("state", required("state", input.state, 1_024));
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
        const body = await readContainer(context, credentials.accessToken, operation.id);
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
      const url = new URL(`/${encodeURIComponent(providerPostId)}`, apiOrigin);
      try {
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "DELETE",
          sideEffectPossible: true,
          url: url.toString(),
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
      const shortForm = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: required("authorizationCode", input.code),
        grant_type: "authorization_code",
        redirect_uri: configuredRedirectUri,
      });
      const shortResponse = await http.request<unknown>(context, {
        body: shortForm,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${apiOrigin}/oauth/access_token`,
      });
      const shortBody = record(shortResponse.body);
      const shortToken = boundedString(shortBody?.access_token, 16_384);
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
      const longBody = record(longResponse.body);
      const accessToken = boundedString(longBody?.access_token, 16_384);
      if (!accessToken || longBody?.token_type !== "bearer") throw malformed();
      const expiresAt = addSeconds(now(), longBody.expires_in, tokenLifetimeMaximumSeconds);

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
          : secureUrl(profile.threads_profile_picture_url);
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
        scopes: [...configuredScopes],
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
      const values = metric?.values;
      const total = record(metric?.total_value)?.value;
      const followers = Array.isArray(values)
        ? metricValue(record(values[0])?.value)
        : metricValue(total);
      if (followers === undefined) throw malformed();
      return { followers, recordedAt: now().toISOString() };
    },

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
      const data = record(response.body)?.data;
      if (!Array.isArray(data) || data.length > 20) throw malformed();
      const metrics = new Map<string, number>();
      for (const item of data) {
        const metric = record(item);
        const name = boundedString(metric?.name, 64);
        const values = metric?.values;
        const value = Array.isArray(values) ? metricValue(record(values[0])?.value) : undefined;
        if (!name || value === undefined || metrics.has(name)) {
          throw malformed();
        }
        metrics.set(name, value);
      }
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
      const body = record(response.body);
      if (!Array.isArray(body?.data) || body.data.length > page.limit) {
        throw malformed();
      }
      const identifiers = new Set<string>();
      const items = body.data.map((value) => {
        const comment = record(value);
        const providerCommentId = providerIdentifier(comment?.id);
        const bodyText = boundedText(comment?.text, 10_000, true);
        const commentedAt = timestamp(comment?.timestamp);
        const authorDisplayName =
          comment?.username === undefined ? undefined : boundedString(comment.username, 500);
        const authorAvatarUrl =
          comment?.profile_picture_url === undefined
            ? undefined
            : secureUrl(comment.profile_picture_url);
        if (
          !providerCommentId ||
          identifiers.has(providerCommentId) ||
          bodyText === undefined ||
          !commentedAt ||
          (comment?.username !== undefined && !authorDisplayName) ||
          (comment?.profile_picture_url !== undefined && !authorAvatarUrl)
        ) {
          throw malformed();
        }
        identifiers.add(providerCommentId);
        return {
          ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
          ...(authorDisplayName ? { authorDisplayName } : {}),
          body: bodyText,
          commentedAt,
          providerCommentId,
          providerPostId,
        };
      });
      const paging = record(body.paging);
      const cursors = record(paging?.cursors);
      if ((body.paging !== undefined && !paging) || (paging?.cursors !== undefined && !cursors)) {
        throw malformed();
      }
      const rawNextCursor = cursors?.after;
      const nextCursor = rawNextCursor === undefined ? undefined : boundedCursor(rawNextCursor);
      if (rawNextCursor !== undefined && !nextCursor) throw malformed();
      return {
        items,
        ...(nextCursor ? { nextCursor } : {}),
      };
    },

    /**
     * Resolves publication status from either a confirmed post ID or a persisted
     * container operation identity. Post lookups confirm the permalink; container
     * lookups delegate to lookupContainer, which polls readiness and finalizes a
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
          const providerUrl = secureUrl(body?.permalink);
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
      return lookupContainer(context, credentials, operation);
    },
    /**
     * Creates Threads containers for a post's ordered attachments and, for
     * media posts, returns the durable 'created:<parent>' operation identity
     * without publishing; lookupPublication polls the parent and finalizes it
     * exactly once. Multi-attachment posts first create one unpublished item
     * container per attachment, then a CAROUSEL parent binding those item ids
     * in creator order. Text-only posts use the synchronous TEXT container and
     * keep the single-call create-and-publish flow.
     * @param context - Request context carrying abort signal and rate telemetry.
     * @param credentials - Threads long-lived access token.
     * @param input - Composed post text plus the Post's ordered attachments.
     * @returns confirmed_success for a text post, otherwise the container
     * operation identity awaiting reconciliation.
     */
    async publish(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, 255);
      const { attachments, text } = postAttachments(input);

      const createContainer = async (parameters: URLSearchParams): Promise<string> => {
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

      if (attachments.length === 0) {
        return publishContainer(
          context,
          credentials.accessToken,
          await createContainer(textParameters(text)),
        );
      }
      const [only] = attachments;
      if (attachments.length === 1) {
        return {
          outcome: "confirmed_success",
          providerOperationId: containerOperationId(
            "created",
            await createContainer(singleParameters(only!, text)),
          ),
        };
      }
      // Items are created one at a time in creator order so a rejected
      // attachment stops the flow before later items exist, and the returned
      // ids stay aligned with the published carousel order.
      const children: string[] = [];
      for (const item of attachments) {
        children.push(await createContainer(carouselItemParameters(item)));
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
      const body = record(response.body);
      const accessToken = boundedString(body?.access_token, 16_384);
      if (!accessToken || body?.token_type !== "bearer") throw malformed();
      return {
        accessToken,
        expiresAt: addSeconds(now(), body.expires_in, tokenLifetimeMaximumSeconds),
        refreshToken: accessToken,
        scopes: [...configuredScopes],
      };
    },

    /**
     * Creates a Threads reply container and returns its durable 'created:<container>'
     * operation identity without publishing. Reply containers follow the same readiness
     * lifecycle as distribution containers: lookupPublication polls the container and
     * finalizes it exactly once, so a reply is never published before it is ready.
     */
    async reply(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, 255);
      const providerCommentId = providerIdentifier(input.providerCommentId);
      const text = boundedText(input.text.trim(), 500);
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

    retryPolicy: {
      baseDelaySeconds: 15,
      maxAttempts: 5,
      maxDelaySeconds: 300,
    },

    transferModes: ["remote_ingest"],
  };
  if (!engagementEnabled) {
    delete adapter.listAnalytics;
    delete adapter.listComments;
    delete adapter.reply;
  }
  return adapter;
}
