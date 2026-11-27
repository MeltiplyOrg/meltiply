import type { PlatformCapability } from "@meltiply/domain";

import {
  isHttp404,
  malformed,
  rejection,
  requiredIdentifier,
  validatePageInput,
  validateSnapshotPage,
} from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import {
  containerOperationId,
  createMetaContainer,
  lookupMetaContainer,
  lookupMetaPost,
  parseContainerOperationId,
  parseMetaCommentPage,
  parseMetaInsightsMap,
  parseMetaReply,
  readMetaContainer,
  requestMetaBearerToken,
  type MetaContainerProtocol,
} from "../meta";
import {
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
} from "../oauth";
import { confirmedFailure, engagementSnapshot, unknownResult } from "../results";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import {
  bearer,
  boundedString,
  providerIdentifier,
  record,
  required,
  requireIdempotencyKey,
} from "../values";
import { applyThreadsOptions } from "./options";
import {
  imageTypes,
  threadsMediaParameters,
  threadsPublishPlan,
  threadsPublishWarnings,
  threadsTextParameters,
  videoTypes,
} from "./publication";
import {
  confirmsThreadsDeletion,
  threadsAccount,
  threadsEngagement,
  threadsFollowers,
  threadsGrantedScopes,
} from "./responses";

export const threadsGraphOrigin = "https://graph.threads.com";
const apiOrigin = threadsGraphOrigin;
const limits = PROVIDER_LIMITS.threads;

const publishingScopes = [
  "threads_basic",
  "threads_content_publish",
  "threads_delete",
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

const capability: PlatformCapability = {
  accepted_mime_types: [...imageTypes, ...videoTypes],
  analytics: true,
  asset_types: ["image", "video"],
  comments: true,
  connect_available: true,
  max_caption_length: limits.maxCaptionCodePoints,
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

export interface ThreadsAdapterOptions extends ProviderAdapterOptions {
  engagementEnabled?: boolean;
}

const containerProtocol: MetaContainerProtocol = {
  containerReadUrl(containerId) {
    const url = new URL(`/${encodeURIComponent(containerId)}`, apiOrigin);
    url.searchParams.set("fields", "id,status,error_message");
    return url.toString();
  },
  extractWarnings: threadsPublishWarnings,
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

export function createThreadsAdapter(options: ThreadsAdapterOptions): ProviderAdapter {
  const { clientId, clientSecret, http, now, redirectUri } = adapterRuntime(
    "threads",
    [apiOrigin],
    options,
  );
  const engagementEnabled = options.engagementEnabled ?? true;
  const configuredScopes = [...publishingScopes, ...(engagementEnabled ? engagementScopes : [])];
  const tokenGrant = (
    context: ProviderRequestContext,
    path: string,
    parameters: Record<string, string>,
  ) => requestMetaBearerToken(http, context, `${apiOrigin}${path}`, parameters, limits, now());

  const grantedScopes = async (
    context: ProviderRequestContext,
    token: string,
    expectedAccount?: string,
  ): Promise<string[]> => {
    const url = new URL("/v1.0/debug_token", apiOrigin);
    url.searchParams.set("input_token", token);
    const response = await http.request(context, {
      headers: bearer(`TH|${clientId}|${clientSecret}`),
      method: "GET",
      url: url.toString(),
    });
    return threadsGrantedScopes(response.body, expectedAccount);
  };

  const engagementMethods: Pick<ProviderAdapter, "listAnalytics" | "listComments" | "reply"> = {
    async listAnalytics(context, credentials, lookup, page) {
      validateSnapshotPage("threads", page);
      const providerPostId = requiredIdentifier(lookup.providerPostId, "threads_post_id_required");
      const url = new URL(`/${encodeURIComponent(providerPostId)}/insights`, apiOrigin);
      url.searchParams.set("metric", "views,likes,replies,reposts,quotes,shares");
      const response = await http.request(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const metrics = parseMetaInsightsMap(response.body);
      return engagementSnapshot({ ...threadsEngagement(metrics), providerPostId }, now());
    },

    async listComments(context, credentials, lookup, page) {
      validatePageInput("threads", page);
      const providerPostId = requiredIdentifier(lookup.providerPostId, "threads_post_id_required");
      const url = new URL(`/${encodeURIComponent(providerPostId)}/conversation`, apiOrigin);
      url.searchParams.set("fields", "id,text,timestamp,username,profile_picture_url");
      url.searchParams.set("limit", String(page.limit));
      url.searchParams.set("reverse", "false");
      if (page.cursor) url.searchParams.set("after", page.cursor);
      const response = await http.request(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      return parseMetaCommentPage(response.body, providerPostId, page.limit, {
        avatarField: "profile_picture_url",
        usernameField: "username",
      });
    },

    async reply(context, credentials, input) {
      const reply = parseMetaReply(input, limits.maxCaptionCodePoints);
      if (!reply) return confirmedFailure(rejection("threads_reply_invalid"));
      const containerId = await createMetaContainer(
        http,
        context,
        credentials.accessToken,
        new URL("/me/threads", apiOrigin),
        new URLSearchParams({
          media_type: "TEXT",
          reply_to_id: reply.providerCommentId,
          text: reply.text,
        }),
      );
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId("created", containerId),
      };
    },
  };

  return {
    authorizationUrl: (input) =>
      authorizationCodeUrl("https://threads.com/oauth/authorize", input, redirectUri, {
        client_id: clientId,
        scope: configuredScopes.join(","),
      }),

    async cancelPublication(context, credentials, lookup) {
      const providerPostId = providerIdentifier(lookup.providerPostId);
      const providerOperationId = providerIdentifier(lookup.providerOperationId);
      if (!providerPostId) {
        const operation = parseContainerOperationId(providerOperationId);
        if (!operation) return confirmedFailure(rejection("threads_cancel_evidence_invalid"));
        const retainedOperationId = containerOperationId(operation.phase, operation.id);
        const body = await readMetaContainer(
          http,
          containerProtocol,
          context,
          credentials.accessToken,
          operation.id,
        );
        if (!body || body.status === "ERROR" || body.status === "EXPIRED") {
          return { outcome: "confirmed_success", providerOperationId: retainedOperationId };
        }
        return unknownResult("threads_cancel_requires_post_id", retainedOperationId);
      }
      const deleted = {
        outcome: "confirmed_success",
        ...(providerOperationId ? { providerOperationId } : {}),
        providerPostId,
      } as const;
      try {
        const response = await http.request(context, {
          headers: bearer(credentials.accessToken),
          method: "DELETE",
          sideEffectPossible: true,
          url: `${apiOrigin}/${encodeURIComponent(providerPostId)}`,
        });
        const body = record(response.body);
        if (!confirmsThreadsDeletion(body, providerPostId)) throw malformed(true);
        return deleted;
      } catch (cause) {
        if (isHttp404(cause)) return deleted;
        throw cause;
      }
    },

    capability: {
      ...capability,
      analytics: engagementEnabled,
      comments: engagementEnabled,
      reply: engagementEnabled,
    },
    ambiguousZeroMetrics: ["views", "reactions", "comments", "shares"],

    async exchangeAuthorizationCode(context, input): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, redirectUri);
      const shortBody = record(
        await exchangeAuthorizationCodeForm(http, context, {
          clientId,
          clientSecret,
          code: input.code,
          redirectUri,
          tokenUrl: `${apiOrigin}/oauth/access_token`,
        }),
      );
      const shortToken = boundedString(shortBody?.access_token, limits.tokenMaxChars);
      if (!shortToken || !providerIdentifier(String(shortBody?.user_id ?? ""))) throw malformed();
      const { accessToken, expiresAt } = await tokenGrant(context, "/access_token", {
        grant_type: "th_exchange_token",
        client_secret: clientSecret,
        access_token: shortToken,
      });

      const profileUrl = new URL("/me", apiOrigin);
      profileUrl.searchParams.set("fields", "id,username,name,threads_profile_picture_url");
      const profileResponse = await http.request(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: profileUrl.toString(),
      });
      const account = threadsAccount(profileResponse.body);
      return {
        accessToken,
        account,
        expiresAt,
        refreshToken: accessToken,
        scopes: await grantedScopes(context, accessToken, account.id),
      };
    },

    async getAccountAnalytics(context, credentials) {
      const accountId = requiredIdentifier(credentials.accountId, "threads_account_id_required");
      const url = new URL(`/${encodeURIComponent(accountId)}/threads_insights`, apiOrigin);
      url.searchParams.set("metric", "followers_count");
      url.searchParams.set("period", "lifetime");
      const response = await http.request(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      return { followers: threadsFollowers(response.body), recordedAt: now().toISOString() };
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
          new URL(`/${encodeURIComponent(providerPostId)}`, apiOrigin),
          "optional",
        );
      }
      const operation = parseContainerOperationId(lookup.providerOperationId);
      if (!operation) throw malformed();
      return lookupMetaContainer(http, containerProtocol, context, credentials, operation);
    },

    async publish(context, credentials, input) {
      requireIdempotencyKey(input.idempotencyKey);
      const { attachments, options, text } = threadsPublishPlan(input);
      if (options.repost_id) {
        const response = await http.request(context, {
          headers: bearer(credentials.accessToken),
          method: "POST",
          sideEffectPossible: true,
          url: new URL(`/${encodeURIComponent(options.repost_id)}/repost`, apiOrigin).toString(),
        });
        const providerPostId = providerIdentifier(record(response.body)?.id);
        if (!providerPostId) throw malformed(true);
        return { outcome: "confirmed_success", providerPostId };
      }
      const createContainer = (parameters: URLSearchParams) =>
        createMetaContainer(
          http,
          context,
          credentials.accessToken,
          new URL("/me/threads", apiOrigin),
          parameters,
        );
      const createParent = (parameters: URLSearchParams) => {
        applyThreadsOptions(parameters, options);
        return createContainer(parameters);
      };

      const [only] = attachments;
      let parentId: string;
      if (attachments.length > 1) {
        const children: string[] = [];
        for (const item of attachments) {
          children.push(
            await createContainer(
              new URLSearchParams({ is_carousel_item: "true", ...threadsMediaParameters(item) }),
            ),
          );
        }
        parentId = await createParent(
          new URLSearchParams({
            ...(text ? { text } : {}),
            media_type: "CAROUSEL",
            children: children.join(","),
          }),
        );
      } else {
        parentId = await createParent(
          only
            ? new URLSearchParams({ ...(text ? { text } : {}), ...threadsMediaParameters(only) })
            : threadsTextParameters(text, options),
        );
      }
      return {
        outcome: "confirmed_success",
        providerOperationId: containerOperationId("created", parentId),
      };
    },

    async refreshAccessToken(context, refreshToken): Promise<ProviderTokenSet> {
      const { accessToken, expiresAt } = await tokenGrant(context, "/refresh_access_token", {
        grant_type: "th_refresh_token",
        access_token: required("refreshToken", refreshToken),
      });
      return {
        accessToken,
        expiresAt,
        refreshToken: accessToken,
        scopes: await grantedScopes(context, accessToken),
      };
    },

    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: ["remote_ingest"],
  };
}
