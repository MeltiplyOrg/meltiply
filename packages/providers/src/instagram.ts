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
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
} from "./types";

const apiOrigin = "https://graph.instagram.com";
const exchangeOrigin = "https://api.instagram.com";
const authorizationOrigin = "https://www.instagram.com";
const apiVersion = "v25.0";
const imageMaximumBytes = 8 * 1024 * 1024;
const videoMaximumBytes = 300_000_000;
const tokenLifetimeMaximumSeconds = 90 * 24 * 60 * 60;

const publishingScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;
const engagementScopes = [
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
] as const;

/** Instagram's documented carousel ceiling for one API-published post. */
const maximumCarouselItems = 10;

/** Instagram's caption ceiling remains known even before live publishing is configured. */
export const INSTAGRAM_MAX_CAPTION_LENGTH = 2_200;

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: INSTAGRAM_MAX_CAPTION_LENGTH,
  max_file_size: videoMaximumBytes,
  max_hashtags: 30,
  max_media_count: 10,
  max_video_duration_sec: 900,
  min_media_count: 1,
  multi_asset_types: ["image", "video"],
  notes: [
    "Professional Business or Creator accounts use Instagram Login.",
    "Single images and Reels use public HTTPS remote-ingest URLs.",
    "Up to 10 images and Reels combine as one carousel post.",
    "Images are limited to 8 MiB; Reels are limited to 1 GiB and 15 minutes.",
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
  if ([...value].length > 2_200 || input.hashtags.length > 30) {
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
 * Validates one ordered attachment and returns the remote-ingest URL Instagram
 * will fetch, checking transfer mode, HTTPS shape, the JPEG-only 8 MiB image
 * ceiling, and a conservative 300 MB (decimal) MP4/MOV Reel ceiling. Carousel items are validated
 * identically to single posts because Instagram publishes them as one media item.
 * @param input - Publish input whose `media[index]` is being validated.
 * @param index - Attachment position, quoted in the thrown failure context.
 * @returns The attachment kind and its canonical HTTPS URL.
 * @throws ProviderAdapterError when the attachment cannot be published.
 */
function attachment(input: PublishInput, index: number): InstagramAttachment {
  const media = input.media[index]!;
  if (media.mode !== "remote_ingest") {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_remote_media_required",
        status: 400,
      }),
    );
  }
  const url = secureUrl(media.url);
  const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
  const fileSize = media.fileSize;
  const valid =
    url !== undefined &&
    Number.isSafeInteger(fileSize) &&
    fileSize >= 1 &&
    ((contentType === "image/jpeg" && fileSize <= imageMaximumBytes) ||
      (["video/mp4", "video/quicktime"].includes(contentType) && fileSize <= videoMaximumBytes));
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
 * Instagram requires at least one attachment and accepts at most 10 as one
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
  if (input.media.length > maximumCarouselItems) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "instagram_carousel_too_large",
        status: 400,
      }),
    );
  }
  return {
    attachments: input.media.map((_, index) => attachment(input, index)),
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
 * Builds container-creation parameters for a single-attachment post, keeping
 * the historical image_url or REELS shape so accepted behavior and its
 * reconciliation lifecycle are unchanged.
 * @param item - The single validated attachment being published.
 * @param text - Trimmed caption for the published post.
 * @returns Parameters for the container creation request.
 */
function singleParameters(item: InstagramAttachment, text: string): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text) parameters.set("caption", text);
  if (item.kind === "image") {
    parameters.set("image_url", item.url);
  } else {
    parameters.set("media_type", "REELS");
    parameters.set("share_to_feed", "true");
    parameters.set("video_url", item.url);
  }
  return parameters;
}

/**
 * Extracts a numeric metric value from an Instagram Graph API insight payload.
 * Supports both periodic bucket arrays (e.g. `metric.values[0]`) and lifetime objects (`metric.total_value`).
 * Returns non-negative safe integer value, or undefined if absent or non-numeric.
 */
function insightValue(metric: Record<string, unknown>): number | undefined {
  const values = metric.values;
  if (Array.isArray(values)) return metricValue(record(values[0])?.value);
  return metricValue(record(metric.total_value)?.value);
}

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
 * Optionally strips engagement methods if options.engagementEnabled is false.
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
    rateLimitBudget: (headers) => extractRateLimitBudget("instagram", headers),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  /**
   * Issues the single finalizing publish for a ready Instagram media container.
   * Success and deterministic rejection retain the 'created' operation identity; an
   * ambiguous outcome records 'submitted:<container>' so reconciliation can prove the
   * publish was dispatched and must never be issued again. A retryable rejection keeps
   * the container 'processing' so the next poll retries finalization.
   * Returns the publication status produced by the publish attempt.
   */
  const publishContainer = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    containerId: string,
  ): Promise<ProviderPublicationStatus> => {
    const createdOperationId = containerOperationId("created", containerId);
    const url = new URL(
      `/${apiVersion}/${encodeURIComponent(accountId(credentials))}/media_publish`,
      apiOrigin,
    );
    url.searchParams.set("creation_id", containerId);
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      const providerPostId = providerIdentifier(record(response.body)?.id);
      if (!providerPostId) throw malformed(true);
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId: createdOperationId,
          providerPostId,
        },
        state: "published",
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (cause.failure.classification === "ambiguous") {
        return {
          result: unknownResult(cause.failure, containerOperationId("submitted", containerId)),
          state: "unknown",
        };
      }
      if (cause.failure.retryable) {
        return { providerOperationId: createdOperationId, state: "processing" };
      }
      return {
        result: {
          failure: cause.failure,
          outcome: "confirmed_failure",
          providerOperationId: createdOperationId,
        },
        state: "failed",
      };
    }
  };

  /**
   * Reconciles a persisted Instagram container operation into a publication status.
   * Requests the documented `status_code` plus the `status` detail field; a 'created'
   * container that reports FINISHED is finalized exactly once through publishContainer,
   * while a 'submitted' container is never republished. PUBLISHED proves completion
   * even when a lost final response withheld the media ID. Container ERROR detail is
   * normalized to a safe diagnostic category code so raw provider text never persists.
   * Returns ProviderPublicationStatus for the operation, or not_found when the
   * container no longer exists.
   */
  const lookupContainer = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    operation: MetaContainerOperation,
  ): Promise<ProviderPublicationStatus> => {
    const retainedOperationId = containerOperationId(operation.phase, operation.id);
    const url = new URL(`/${apiVersion}/${encodeURIComponent(operation.id)}`, apiOrigin);
    url.searchParams.set("fields", "id,status_code,status");
    let response;
    try {
      response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
    } catch (cause) {
      if (isHttp404(cause)) return { state: "not_found" };
      throw cause;
    }
    const body = record(response.body);
    if (providerIdentifier(body?.id) !== operation.id) throw malformed();
    switch (body?.status_code) {
      case "IN_PROGRESS":
        return {
          providerOperationId: retainedOperationId,
          state: "processing",
        };
      case "FINISHED":
        if (operation.phase === "created") {
          return publishContainer(context, credentials, operation.id);
        }
        return {
          result: unknownResult(
            classifyProviderFailure({
              code: "instagram_publish_evidence_missing",
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
            providerOperationId: containerOperationId("submitted", operation.id),
          },
          state: "published",
        };
      case "ERROR":
        return {
          result: confirmedFailure(
            metaContainerFailureCode("instagram", body.status),
            422,
            retainedOperationId,
          ),
          state: "failed",
        };
      case "EXPIRED":
        return {
          result: confirmedFailure("instagram_container_expired", 410, retainedOperationId),
          state: "failed",
        };
      default:
        throw malformed();
    }
  };

  const adapter: ProviderAdapter = {
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
      url.searchParams.set("state", required("state", input.state, 1_024));
      return url.toString();
    },

    capability: {
      ...capability,
      analytics: engagementEnabled,
      comments: engagementEnabled,
      reply: engagementEnabled,
    },

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
        url: `${exchangeOrigin}/oauth/access_token`,
      });
      const shortBody = loginRecord(shortResponse.body);
      const shortToken = boundedString(shortBody?.access_token, 16_384);
      const exchangedAccountId = providerIdentifier(String(shortBody?.user_id ?? ""));
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
      const longBody = record(longResponse.body);
      const accessToken = boundedString(longBody?.access_token, 16_384);
      if (!accessToken || longBody?.token_type !== "bearer") throw malformed();
      const expiresAt = addSeconds(now(), longBody.expires_in, tokenLifetimeMaximumSeconds);

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
      const username = boundedString(profile?.username, 255);
      const name = boundedText(profile?.name, 500);
      const displayName = name ?? (username ? boundedString(username, 500) : undefined);
      const avatarUrl =
        profile?.profile_picture_url === undefined
          ? undefined
          : secureUrl(profile.profile_picture_url);
      if (
        !profileScopedId ||
        !profileAccountId ||
        !username ||
        !displayName ||
        !["BUSINESS", "MEDIA_CREATOR"].includes(String(profile?.account_type).toUpperCase()) ||
        (profile?.profile_picture_url !== undefined && !avatarUrl)
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
     * Uses the same long-lived token as publishing; no Post identity is needed.
     */
    async getAccountAnalytics(context, credentials) {
      const url = new URL(`/${apiVersion}/me`, apiOrigin);
      url.searchParams.set("fields", "followers_count,follows_count,media_count");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      const followers = metricValue(body?.followers_count);
      const following = metricValue(body?.follows_count);
      const posts = metricValue(body?.media_count);
      if (followers === undefined) throw malformed();
      return {
        followers,
        ...(following === undefined ? {} : { following }),
        ...(posts === undefined ? {} : { posts }),
        recordedAt: now().toISOString(),
      };
    },

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
      const data = record(response.body)?.data;
      if (!Array.isArray(data) || data.length > 20) throw malformed();
      const metrics = new Map<string, number>();
      for (const value of data) {
        const metric = record(value);
        const name = boundedString(metric?.name, 64);
        const result = metric ? insightValue(metric) : undefined;
        if (!name || result === undefined || metrics.has(name)) {
          throw malformed();
        }
        metrics.set(name, result);
      }
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
      const body = record(response.body);
      if (!Array.isArray(body?.data) || body.data.length > page.limit) {
        throw malformed();
      }
      const identifiers = new Set<string>();
      const items = body.data.map((value) => {
        const comment = record(value);
        const author = record(comment?.from);
        const providerCommentId = providerIdentifier(comment?.id);
        const text = boundedText(comment?.text, 10_000, true);
        const commentedAt = timestamp(comment?.timestamp);
        const authorDisplayName =
          author?.username === undefined ? undefined : boundedString(author.username, 500);
        if (
          !providerCommentId ||
          identifiers.has(providerCommentId) ||
          text === undefined ||
          !commentedAt ||
          (author?.username !== undefined && !authorDisplayName)
        ) {
          throw malformed();
        }
        identifiers.add(providerCommentId);
        return {
          ...(authorDisplayName ? { authorDisplayName } : {}),
          body: text,
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
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    },

    /**
     * Resolves publication status from either a confirmed media ID or a persisted
     * container operation identity. Media lookups confirm the permalink; container
     * lookups delegate to lookupContainer, which polls readiness and finalizes a
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
      accountId(credentials);
      return lookupContainer(context, credentials, operation);
    },

    /**
     * Creates Instagram media containers for a post's ordered attachments and
     * returns the durable 'created:<parent>' operation identity without
     * publishing; lookupPublication polls the parent and finalizes it exactly
     * once. Multi-attachment posts first create one unpublished child container
     * per attachment, then a CAROUSEL parent that binds those child ids in
     * creator order, so nothing is published until every child is retrievable.
     * A single attachment keeps the direct image/Reel container shape.
     * @param context - Request context carrying abort signal and rate telemetry.
     * @param credentials - Page access token and professional account id.
     * @param input - Composed caption plus the Post's ordered attachments.
     * @returns confirmed_success carrying only the container operation identity,
     * never a provider post id, so the caller reconciles through lookupPublication.
     */
    async publish(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, 255);
      const { attachments, text } = carouselAttachments(input);
      const account = accountId(credentials);

      const createContainer = async (parameters: URLSearchParams): Promise<string> => {
        const url = new URL(`/${apiVersion}/${encodeURIComponent(account)}/media`, apiOrigin);
        url.search = parameters.toString();
        const response = await http.request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "POST",
          url: url.toString(),
        });
        const containerId = providerIdentifier(record(response.body)?.id);
        if (!containerId) throw malformed();
        return containerId;
      };

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
      // Children are created one at a time in creator order so a rejected
      // attachment stops the flow before later children exist, and the returned
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

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const currentToken = required("refreshToken", refreshToken);
      const url = new URL("/refresh_access_token", apiOrigin);
      url.searchParams.set("grant_type", "ig_refresh_token");
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

    async reply(context, credentials, input) {
      required("idempotencyKey", input.idempotencyKey, 255);
      const providerCommentId = providerIdentifier(input.providerCommentId);
      const text = boundedText(input.text.trim(), 2_200);
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

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 6,
      maxDelaySeconds: 900,
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
