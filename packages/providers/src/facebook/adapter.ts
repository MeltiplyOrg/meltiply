import type { PlatformCapability } from "@meltiply/domain";

import { PROVIDER_LIMITS } from "../limits";
import { adapterRuntime, type ProviderAdapterOptions } from "../runtime";
import type { ProviderAdapter } from "../types";
import { createFacebookAnalytics } from "./analytics";
import { createFacebookOAuth, discoveryRequestLimit } from "./oauth";
import { createFacebookPublish } from "./publish";
import {
  FACEBOOK_GRAPH_ORIGIN,
  FACEBOOK_IMAGE_TYPES,
  FACEBOOK_UPLOAD_ORIGIN,
  FACEBOOK_VIDEO_TYPES,
} from "./types";

const capability: PlatformCapability = {
  accepted_mime_types: [...FACEBOOK_IMAGE_TYPES, ...FACEBOOK_VIDEO_TYPES],
  analytics: true,
  asset_types: ["image", "video"],
  comments: false,
  connect_available: true,
  max_caption_length: PROVIDER_LIMITS.facebook.maxCaptionCodePoints,
  max_file_size: PROVIDER_LIMITS.facebook.maxVideoBytes,
  max_hashtags: PROVIDER_LIMITS.facebook.maxHashtags,
  max_media_count: PROVIDER_LIMITS.facebook.maxMediaCount,
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

export interface FacebookAdapterOptions extends ProviderAdapterOptions {
  maxDiscoveredPages?: number;
  maxDiscoveryRequests?: number;
}

export function createFacebookAdapter(options: FacebookAdapterOptions): ProviderAdapter {
  const runtime = adapterRuntime(
    "facebook",
    [FACEBOOK_GRAPH_ORIGIN, FACEBOOK_UPLOAD_ORIGIN],
    options,
  );
  const oauth = createFacebookOAuth(
    runtime,
    discoveryRequestLimit(options.maxDiscoveryRequests),
    options.maxDiscoveredPages,
  );
  const analytics = createFacebookAnalytics(runtime.http, runtime.now);
  const publish = createFacebookPublish(runtime.http);
  return {
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
    retryPolicy: { baseDelaySeconds: 30, maxAttempts: 8, maxDelaySeconds: 900 },
    transferModes: ["remote_ingest"],
  };
}
