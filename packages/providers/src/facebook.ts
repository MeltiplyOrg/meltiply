import type { PlatformCapability } from "@meltiply/domain";

import { createFacebookAnalytics } from "./facebook/analytics";
import { createFacebookOAuth } from "./facebook/oauth";
import { createFacebookPublish } from "./facebook/publish";
import { FACEBOOK_GRAPH_ORIGIN, FACEBOOK_LIMITS, FACEBOOK_UPLOAD_ORIGIN } from "./facebook/types";
import { ProviderHttpClient } from "./http";
import { exactRedirectUri, required } from "./meta-common";
import { extractRateLimitBudget } from "./rate-limit";
import type { ProviderAdapter } from "./types";

const capability: PlatformCapability = {
  accepted_mime_types: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "video/mp4",
    "video/quicktime",
  ],
  analytics: true,
  asset_types: ["image", "video"],
  comments: false,
  connect_available: true,
  max_caption_length: FACEBOOK_LIMITS.maxCaptionCodePoints,
  max_file_size: FACEBOOK_LIMITS.maxVideoBytes,
  max_hashtags: FACEBOOK_LIMITS.maxHashtags,
  max_media_count: FACEBOOK_LIMITS.maxMediaCount,
  max_video_duration_sec: null,
  min_media_count: 0,
  multi_asset_types: ["image"],
  notes: [
    "Facebook Pages use an explicit Page access token; personal profiles are unsupported.",
    "Page Reels use a hosted HTTPS video and the documented remote-ingest flow.",
    "Text, links, photos, and ordered multi-photo posts publish to the Page feed.",
    "Reels accept one video up to 90 seconds; photo uploads accept up to 10 MB.",
    "Regular videos, photo/video Stories, 3–7-image slideshows, authorized video crossposts, unpublished video experiments, and encoder-backed Live use their own endpoints.",
    "Native Page drafts, experiments, and created broadcasts are delivered handoffs, not published Posts.",
    "Stories do not accept captions or signatures; native experiments require existing unpublished video IDs and engagement permissions.",
    "Analytics reads Reel plays from Video Insights and likes/comments from the Video edges; shares come from the documented comments-plus-shares social-actions metric.",
    "Video Insights requires read_insights and pages_manage_engagement; old connections must reconnect to grant them.",
  ],
  platform: "facebook",
  publish: true,
  reply: false,
};

export interface FacebookAdapterOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

/**
 * Instantiates a ProviderAdapter for Facebook Page feed publishing, Reels, and OAuth.
 * Configures Graph API v25.0 endpoints, remote ingest flow, rate limit budget extraction,
 * Page token derivation, and publication-kind-aware reconciliation.
 * OAuth validation failures identify invalid fields without exposing credentials;
 * inspected zero expiry is represented by the token contract's absent expiry.
 * Returns configured ProviderAdapter conforming to Meltiply provider contracts.
 */
export function createFacebookAdapter(options: FacebookAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [FACEBOOK_GRAPH_ORIGIN, FACEBOOK_UPLOAD_ORIGIN],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    platform: "facebook",
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  const oauth = createFacebookOAuth({
    clientId,
    clientSecret,
    configuredRedirectUri,
    http,
    now,
  });
  const analytics = createFacebookAnalytics(http, now);
  const publish = createFacebookPublish(http);

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("facebook", headers),
    authorizationUrl: oauth.authorizationUrl,
    capability,
    exchangeAuthorizationCode: oauth.exchangeAuthorizationCode,
    getBroadcastInfo: publish.getBroadcastInfo,
    endBroadcast: publish.endBroadcast,
    getAccountAnalytics: analytics.getAccountAnalytics,
    listAnalytics: analytics.listAnalytics,
    lookupPublication: publish.lookupPublication,
    publish: publish.publish,
    refreshAccessToken: oauth.refreshAccessToken,
    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 8,
      maxDelaySeconds: 900,
    },
    transferModes: ["remote_ingest"],
  };
}
