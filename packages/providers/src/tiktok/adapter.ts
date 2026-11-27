import type { PlatformCapability } from "@meltiply/domain";

import { malformed, rejected, requiredIdentifier, validateSnapshotPage } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import {
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
  postForm,
} from "../oauth";
import { engagementSnapshot, failedWriteResult } from "../results";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type {
  OAuthConnection,
  ProviderAdapter,
  ProviderCredentials,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderTokenSet,
  TikTokPublicationRequirements,
} from "../types";
import { bearer, formHeaders, record, required, requireIdempotencyKey } from "../values";
import {
  tiktokPublishPlan,
  tiktokPublishRequest,
  creatorChoiceUnavailable,
  configuredMediaPrefix,
} from "./publication";
import {
  accountId,
  creatorRequirements,
  envelope,
  operationId,
  publishingGrant,
  requiredOperation,
  tiktokAccount,
  tiktokAccountCounts,
  tiktokIdentifier,
  tiktokPublicationStatus,
  tiktokVideoCounts,
  tokenBody,
} from "./responses";

export const tiktokApiOrigin = "https://open.tiktokapis.com";
const apiOrigin = tiktokApiOrigin;
const limits = PROVIDER_LIMITS.tiktok;
const jsonContentType = "application/json; charset=UTF-8";
const requiredScopes = ["user.info.basic"] as const;
const requestedScopes = [
  ...requiredScopes,
  "video.publish",
  "video.upload",
  "user.info.profile",
  "user.info.stats",
  "video.list",
] as const;
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
      return {
        accessToken: tokens.accessToken,
        account: tiktokAccount(user, tokens.openId),
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
      return { ...tiktokAccountCounts(user), recordedAt: now().toISOString() };
    },

    async listAnalytics(context, credentials, lookup, page) {
      validateSnapshotPage("tiktok", page);
      const providerPostId = requiredIdentifier(lookup.providerPostId, "tiktok_video_id_required");
      const url = new URL("/v2/video/query/", apiOrigin);
      url.searchParams.set("fields", "id,view_count,like_count,comment_count,share_count");
      const response = await postJson(context, credentials.accessToken, url.toString(), {
        filters: { video_ids: [providerPostId] },
      });
      const counts = tiktokVideoCounts(response.body, providerPostId);
      return counts ? engagementSnapshot({ ...counts, providerPostId }, now()) : { items: [] };
    },

    async lookupPublication(context, credentials, lookup): Promise<ProviderPublicationStatus> {
      accountId(credentials);
      const operation = requiredOperation(lookup.providerOperationId);
      const response = await postJson(
        context,
        credentials.accessToken,
        `${apiOrigin}/v2/post/publish/status/fetch/`,
        { publish_id: operation.publishId },
        { preserveLargeIntegers: true },
      );
      return tiktokPublicationStatus(response.body, operation);
    },

    async publish(context, credentials, input) {
      accountId(credentials);
      requireIdempotencyKey(input.idempotencyKey);
      const plan = tiktokPublishPlan(input, mediaPrefix);
      const requirements = plan.inbox ? undefined : await getRequirements(context, credentials);
      if (requirements && creatorChoiceUnavailable(plan.choices, requirements)) {
        throw rejected("tiktok_creator_choice_unavailable");
      }
      const { path, body } = tiktokPublishRequest(plan, input.caption, requirements);

      try {
        const response = await postJson(
          context,
          credentials.accessToken,
          `${apiOrigin}${path}`,
          body,
          {
            sideEffectPossible: true,
          },
        );
        const publishId = tiktokIdentifier(envelope(response.body, true).publish_id);
        if (!publishId) throw malformed(true);
        return {
          outcome: "confirmed_success",
          providerOperationId: operationId({ inbox: plan.inbox, publishId }),
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
