import type { PlatformCapability } from "@meltiply/domain";

import { malformed, rejected, rejection } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import {
  containerOperationId,
  createMetaContainer,
  lookupMetaContainer,
  lookupMetaPost,
  META_GRAPH_API_VERSION,
  parseContainerOperationId,
  parseMetaCommentPage,
  parseMetaInsightsMap,
  parseMetaReply,
  requestMetaBearerToken,
  type MetaContainerProtocol,
} from "../meta";
import {
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
} from "../oauth";
import { confirmedFailure, engagementSnapshot } from "../results";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderMedia,
  ProviderTokenSet,
  PublishInput,
} from "../types";
import {
  bearer,
  boundedString,
  boundedText,
  codePointLength,
  jsonHeaders,
  mediaKind,
  metricValue,
  normalizeContentType,
  optionalSecureUrl,
  providerIdentifier,
  record,
  required,
  requiredIdentifier,
  requireIdempotencyKey,
  secureUrl,
  validatePageInput,
  validateSnapshotPage,
  validFileSize,
} from "../values";
import {
  applyInstagramContent,
  defaultInstagramPostType,
  resolveInstagramOptions,
  type ResolvedInstagramOptions,
} from "./options";

export const instagramGraphOrigin = "https://graph.instagram.com";
export const instagramApiOrigin = "https://api.instagram.com";
const apiOrigin = instagramGraphOrigin;
const exchangeOrigin = instagramApiOrigin;
const graphUrl = (path: string) => new URL(`/${META_GRAPH_API_VERSION}/${path}`, apiOrigin);
const limits = PROVIDER_LIMITS.instagram;
const videoTypes = ["video/mp4", "video/quicktime"];
const professionalAccountTypes = ["BUSINESS", "MEDIA_CREATOR"];
const maxGrantedPermissions = 32;

const publishingScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;
const engagementScopes = [
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
] as const;

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", ...videoTypes],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: limits.maxCaptionCodePoints,
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

export interface InstagramAdapterOptions extends ProviderAdapterOptions {
  engagementEnabled?: boolean;
}

interface InstagramAttachment {
  kind: "image" | "video";
  url: string;
}

function accountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "instagram_professional_account_required");
}

function attachment(media: ProviderMedia, postType: string): InstagramAttachment {
  if (media.mode !== "remote_ingest") throw rejected("instagram_remote_media_required");
  const url = secureUrl(media.url)?.href;
  const contentType = normalizeContentType(media.contentType);
  const maximumVideoBytes =
    postType === "story"
      ? limits.maxStoryBytes
      : postType === "reel"
        ? limits.maxReelBytes
        : limits.maxVideoBytes;
  const kind = videoTypes.includes(contentType)
    ? "video"
    : contentType === "image/jpeg"
      ? "image"
      : undefined;
  if (
    !url ||
    !kind ||
    !validFileSize(media.fileSize, kind === "video" ? maximumVideoBytes : limits.maxImageBytes)
  ) {
    throw rejected("instagram_media_invalid");
  }
  return { kind, url };
}

function publishInput(input: PublishInput): {
  attachments: InstagramAttachment[];
  options: ResolvedInstagramOptions;
  text: string;
} {
  if (input.media.length === 0) throw rejected("instagram_media_required");
  if (input.media.length > limits.maxCarouselItems) throw rejected("instagram_carousel_too_large");
  const requestedPostType =
    input.providerOptions?.instagram?.postType ??
    defaultInstagramPostType(input.media.map((media) => mediaKind(media.contentType)));
  const attachments = input.media.map((media) => attachment(media, requestedPostType));
  const text = input.caption.trim();
  if (
    codePointLength(text) > limits.maxCaptionCodePoints ||
    input.hashtags.length > limits.maxHashtags
  ) {
    throw rejected("instagram_content_invalid");
  }
  const options = resolveInstagramOptions(
    input.providerOptions?.instagram,
    attachments.map((item) => item.kind),
  );
  if (!options) throw rejected("instagram_post_options_invalid");
  if (options.postType === "story" && (text || input.hashtags.length)) {
    throw rejected("instagram_story_caption_unsupported");
  }
  return { attachments, options, text };
}

function carouselItemParameters(item: InstagramAttachment): URLSearchParams {
  return new URLSearchParams(
    item.kind === "image"
      ? { is_carousel_item: "true", image_url: item.url }
      : { is_carousel_item: "true", media_type: "VIDEO", video_url: item.url },
  );
}

function singleParameters(
  item: InstagramAttachment,
  text: string,
  options: ResolvedInstagramOptions,
): URLSearchParams {
  const parameters = new URLSearchParams();
  if (text && options.postType !== "story") parameters.set("caption", text);
  parameters.set(item.kind === "image" ? "image_url" : "video_url", item.url);
  if (options.postType === "story") {
    parameters.set("media_type", "STORIES");
  } else if (item.kind === "video" && options.postType === "feed") {
    parameters.set("media_type", "VIDEO");
  } else if (item.kind === "video") {
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
  }
  return parameters;
}

const partialConfigIssues = new Set(["CAPTION_NOT_ATTACHED", "USER_TAGGING_FAILURE"]);
const partialAddOnStatuses = new Set(["POLL_CREATION_FAILURE", "PROMPT_CREATION_FAILURE"]);

const containerProtocol: MetaContainerProtocol = {
  containerReadUrl(containerId) {
    const url = graphUrl(encodeURIComponent(containerId));
    url.searchParams.set("fields", "id,status_code,status");
    return url.toString();
  },
  extractWarnings: (body) =>
    partialConfigIssues.has(String(body.config_issue)) ||
    partialAddOnStatuses.has(String(body.caption_add_on_attachment_status))
      ? ["instagram_publish_partial"]
      : undefined,
  failureDetailField: "status",
  provider: "instagram",
  publishUrl(credentials, containerId) {
    const url = graphUrl(`${encodeURIComponent(accountId(credentials))}/media_publish`);
    url.searchParams.set("creation_id", containerId);
    return url.toString();
  },
  publishedOperationPhase: "submitted",
  statusField: "status_code",
};

function loginRecord(value: unknown): Record<string, unknown> {
  const body = record(value);
  if (!body) throw malformed();
  if (body.data === undefined) return body;
  if (!Array.isArray(body.data) || body.data.length !== 1) throw malformed();
  const account = record(body.data[0]);
  if (!account) throw malformed();
  return account;
}

function grantedPermissions(value: unknown): (string | undefined)[] | undefined {
  if (Array.isArray(value)) {
    return value.length <= maxGrantedPermissions
      ? value.map((scope: unknown) => boundedString(scope, 128))
      : undefined;
  }
  return boundedString(value, 4_096)
    ?.split(",")
    .map((scope) => scope.trim());
}

export function createInstagramAdapter(options: InstagramAdapterOptions): ProviderAdapter {
  const { clientId, clientSecret, http, now, redirectUri } = adapterRuntime(
    "instagram",
    [apiOrigin, exchangeOrigin],
    options,
  );
  const engagementEnabled = options.engagementEnabled ?? true;
  const configuredScopes = [...publishingScopes, ...(engagementEnabled ? engagementScopes : [])];
  const tokenGrant = (
    context: Parameters<typeof http.request>[0],
    path: string,
    parameters: Record<string, string>,
  ) => requestMetaBearerToken(http, context, `${apiOrigin}${path}`, parameters, limits, now());

  const engagementMethods: Pick<ProviderAdapter, "listAnalytics" | "listComments" | "reply"> = {
    async listAnalytics(context, credentials, lookup, page) {
      validateSnapshotPage("instagram", page);
      const providerPostId = requiredIdentifier(
        lookup.providerPostId,
        "instagram_media_id_required",
      );
      const url = graphUrl(`${encodeURIComponent(providerPostId)}/insights`);
      url.searchParams.set("metric", "views,reach,likes,comments,shares");
      const response = await http.request(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const metrics = parseMetaInsightsMap(response.body);
      return engagementSnapshot(
        {
          comments: metrics.get("comments") ?? 0,
          likes: metrics.get("likes") ?? 0,
          providerPostId,
          reach: metrics.get("reach") ?? 0,
          shares: metrics.get("shares") ?? 0,
          views: metrics.get("views") ?? 0,
        },
        now(),
      );
    },

    async listComments(context, credentials, lookup, page) {
      validatePageInput("instagram", page);
      const providerPostId = requiredIdentifier(
        lookup.providerPostId,
        "instagram_media_id_required",
      );
      const url = graphUrl(`${encodeURIComponent(providerPostId)}/comments`);
      url.searchParams.set("fields", "id,text,timestamp,from{id,username}");
      url.searchParams.set("limit", String(page.limit));
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await http.request(context, {
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
      const reply = parseMetaReply(input, limits.maxCaptionCodePoints);
      if (!reply) return confirmedFailure(rejection("instagram_reply_invalid"));
      const response = await http.request(context, {
        body: JSON.stringify({ message: reply.text }),
        headers: jsonHeaders(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: graphUrl(`${encodeURIComponent(reply.providerCommentId)}/replies`).toString(),
      });
      const replyId = providerIdentifier(record(response.body)?.id);
      if (!replyId) throw malformed(true);
      return { outcome: "confirmed_success", providerPostId: replyId };
    },
  };

  return {
    authorizationUrl: (input) =>
      authorizationCodeUrl("https://www.instagram.com/oauth/authorize", input, redirectUri, {
        client_id: clientId,
        force_reauth: "true",
        scope: configuredScopes.join(","),
      }),

    capability: {
      ...capability,
      analytics: engagementEnabled,
      comments: engagementEnabled,
      reply: engagementEnabled,
    },
    ambiguousZeroMetrics: ["views", "reactions", "comments", "shares"],

    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, redirectUri);
      const shortBody = loginRecord(
        await exchangeAuthorizationCodeForm(http, context, {
          clientId,
          clientSecret,
          code: input.code,
          redirectUri,
          tokenUrl: `${exchangeOrigin}/oauth/access_token`,
        }),
      );
      const shortToken = boundedString(shortBody.access_token, limits.tokenMaxChars);
      if (!shortToken || !providerIdentifier(String(shortBody.user_id ?? ""))) throw malformed();
      if (shortBody.permissions !== undefined) {
        const permissions = grantedPermissions(shortBody.permissions);
        if (
          !permissions ||
          permissions.some((scope) => !scope) ||
          configuredScopes.some((scope) => !permissions.includes(scope))
        ) {
          throw rejected("instagram_permissions_missing", 403);
        }
      }
      const { accessToken, expiresAt } = await tokenGrant(context, "/access_token", {
        grant_type: "ig_exchange_token",
        client_secret: clientSecret,
        access_token: shortToken,
      });

      const profileUrl = graphUrl("me");
      profileUrl.searchParams.set(
        "fields",
        "id,user_id,username,name,profile_picture_url,account_type",
      );
      const profileResponse = await http.request(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: profileUrl.toString(),
      });
      const profile = loginRecord(profileResponse.body);
      const profileAccountId = providerIdentifier(profile.user_id);
      const username = boundedString(profile.username, 255);
      const displayName = boundedText(profile.name, 500) ?? username;
      const avatar = optionalSecureUrl(profile.profile_picture_url);
      if (
        !providerIdentifier(profile.id) ||
        !profileAccountId ||
        !username ||
        !displayName ||
        !professionalAccountTypes.includes(String(profile.account_type).toUpperCase()) ||
        !avatar.valid
      ) {
        throw malformed();
      }
      return {
        accessToken,
        account: {
          ...(avatar.href ? { avatarUrl: avatar.href } : {}),
          displayName,
          id: profileAccountId,
          username,
        },
        expiresAt,
        refreshToken: accessToken,
        scopes: [...configuredScopes],
      };
    },

    async getAccountAnalytics(context, credentials) {
      const url = graphUrl("me");
      url.searchParams.set("fields", "followers_count,follows_count,media_count");
      const response = await http.request(context, {
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

    async lookupPublication(context, credentials, lookup) {
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      if (providerPostId) {
        return lookupMetaPost(
          http,
          context,
          credentials,
          { ...lookup, providerPostId },
          graphUrl(encodeURIComponent(providerPostId)),
          "required",
        );
      }
      const operation = parseContainerOperationId(lookup.providerOperationId);
      if (!operation) throw malformed();
      accountId(credentials);
      return lookupMetaContainer(http, containerProtocol, context, credentials, operation);
    },

    async publish(context, credentials, input) {
      requireIdempotencyKey(input.idempotencyKey);
      const { attachments, options: resolved, text } = publishInput(input);
      const metadata = input.providerOptions?.instagram;
      const mediaUrl = graphUrl(`${encodeURIComponent(accountId(credentials))}/media`);
      const createContainer = (parameters: URLSearchParams) =>
        createMetaContainer(http, context, credentials.accessToken, new URL(mediaUrl), parameters);

      const [only] = attachments;
      if (attachments.length === 1 && only) {
        const parameters = singleParameters(only, text, resolved);
        applyInstagramContent(parameters, metadata?.content);
        applyInstagramContent(parameters, metadata?.mediaOptions?.[0]);
        return {
          outcome: "confirmed_success",
          providerOperationId: containerOperationId("created", await createContainer(parameters)),
        };
      }
      const children: string[] = [];
      for (const [index, item] of attachments.entries()) {
        const parameters = carouselItemParameters(item);
        applyInstagramContent(parameters, metadata?.mediaOptions?.[index]);
        children.push(await createContainer(parameters));
      }
      const parent = new URLSearchParams();
      if (text) parent.set("caption", text);
      parent.set("media_type", "CAROUSEL");
      parent.set("children", children.join(","));
      applyInstagramContent(parent, metadata?.content);
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId("created", await createContainer(parent)),
      };
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const { accessToken, expiresAt } = await tokenGrant(context, "/refresh_access_token", {
        grant_type: "ig_refresh_token",
        access_token: required("refreshToken", refreshToken),
      });
      return { accessToken, expiresAt, refreshToken: accessToken, scopes: [...configuredScopes] };
    },

    retryPolicy: { baseDelaySeconds: 30, maxAttempts: 6, maxDelaySeconds: 900 },
    transferModes: ["remote_ingest"],
  };
}
