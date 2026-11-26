import {
  oauthCallbackPath,
  PLATFORM_IDS,
  type Platform,
  type PlatformCapability,
} from "@meltiply/domain";

import { createFacebookAdapter } from "./facebook/adapter";
import { createInstagramAdapter } from "./instagram/adapter";
import { PROVIDER_LIMITS } from "./limits";
import { createThreadsAdapter } from "./threads/adapter";
import { createTikTokAdapter } from "./tiktok/adapter";
import type {
  ProviderAdapter,
  ProviderAnalyticsMetric,
  ProviderOperationResult,
  ProviderPublicationStatus,
  ProviderRequestContext,
} from "./types";
import { assertHttpsOrLoopbackUrl } from "./values";
import { createYouTubeAdapter } from "./youtube/adapter";

const captionLimits: Readonly<Record<Platform, number | null>> = {
  facebook: PROVIDER_LIMITS.facebook.maxCaptionCodePoints,
  instagram: PROVIDER_LIMITS.instagram.maxCaptionCodePoints,
  threads: PROVIDER_LIMITS.threads.maxCaptionCodePoints,
  tiktok: PROVIDER_LIMITS.tiktok.maxCaptionCodePoints,
  youtube: PROVIDER_LIMITS.youtube.maxCaptionCodePoints,
};

function freezeCapability(capability: PlatformCapability): PlatformCapability {
  Object.freeze(capability.accepted_mime_types);
  Object.freeze(capability.asset_types);
  if (capability.multi_asset_types) Object.freeze(capability.multi_asset_types);
  Object.freeze(capability.notes);
  return Object.freeze(capability);
}

function makeUnconfiguredCapabilities(
  analytics: boolean,
): Readonly<Record<Platform, PlatformCapability>> {
  const map = {} as Record<Platform, PlatformCapability>;
  for (const platform of PLATFORM_IDS) {
    map[platform] = freezeCapability({
      accepted_mime_types: [],
      analytics,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: captionLimits[platform],
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: ["Provider adapter is not configured."],
      platform,
      publish: false,
      reply: false,
    });
  }
  return Object.freeze(map);
}

const unconfiguredWithAnalytics = makeUnconfiguredCapabilities(true);
const unconfiguredWithoutAnalytics = makeUnconfiguredCapabilities(false);

export {
  cancelPublicationEffect,
  createProviderServiceLive,
  createProviderServiceTest,
  exchangeAuthorizationCodeEffect,
  getAccountAnalyticsEffect,
  getPublicationRequirementsEffect,
  isRetryableFailure,
  listAnalyticsEffect,
  listCommentsEffect,
  lookupPublicationEffect,
  providerCallEffect,
  ProviderService,
  publishEffect,
  readRetrySchedule,
  refreshAccessTokenEffect,
  replyEffect,
  revokeEffect,
  withReadRetry,
  type ProviderAdapterSource,
  type ProviderServiceShape,
} from "./effect";
export {
  classifyProviderFailure,
  failureDiagnostic,
  normalizeProviderFailure,
  ProviderAdapterError,
  type ProviderAdapterErrorOptions,
  type ProviderFailureInput,
  type ProviderRequestDiagnostic,
} from "./failures";
export { createFacebookAdapter, type FacebookAdapterOptions } from "./facebook/adapter";
export {
  facebookOptimizationGoals,
  facebookOptionsToWire,
  resolveFacebookPostType,
} from "./facebook/options";
export {
  ProviderHttpClient,
  type ProviderErrorDiagnosis,
  type ProviderHttpClientOptions,
  type ProviderHttpMethod,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderHttpResponseType,
} from "./http";
export { createInstagramAdapter, type InstagramAdapterOptions } from "./instagram/adapter";
export {
  applyInstagramContent,
  defaultInstagramPostType,
  instagramContentIssue,
  parseInstagramContent,
  resolveInstagramOptions,
  type InstagramContentOptions,
  type InstagramMediaKind,
  type ResolvedInstagramOptions,
} from "./instagram/options";
export { PROVIDER_LIMITS } from "./limits";
export { extractRateLimitBudget, type RateLimitBudget } from "./rate-limit";
export { createThreadsAdapter, type ThreadsAdapterOptions } from "./threads/adapter";
export {
  applyThreadsOptions,
  parseThreadsOptions,
  parseThreadsPostOptions,
  threadsOptionsIssue,
  type ThreadsPostOptions,
  type ThreadsPublishOptions,
} from "./threads/options";
export { createTikTokAdapter, type TikTokAdapterOptions } from "./tiktok/adapter";
export type {
  FacebookABTestOptions,
  FacebookLinkCard,
  FacebookOptimizationGoal,
  FacebookPostType,
  FacebookPublishOptions,
  InstagramPostType,
  InstagramPublishOptions,
  InstagramTrialGraduation,
  OAuthAccountSelection,
  OAuthAuthorizationInput,
  OAuthConnection,
  OAuthExchangeInput,
  OAuthExchangeResult,
  ProviderAccountAnalytics,
  ProviderAdapter,
  ProviderAnalyticsMetric,
  ProviderAnalyticsRecord,
  ProviderBroadcastInfo,
  ProviderCommentRecord,
  ProviderCredentials,
  ProviderFailure,
  ProviderFailureClass,
  ProviderMedia,
  ProviderMediaMetadata,
  ProviderOperationMetadata,
  ProviderOperationResult,
  ProviderPage,
  ProviderPageInput,
  ProviderPublicationLookup,
  ProviderPublicationRequirements,
  ProviderPublicationStatus,
  ProviderPublishOptions,
  ProviderRemoteMedia,
  ProviderReplyInput,
  ProviderRequestContext,
  ProviderRetryPolicy,
  ProviderStreamMedia,
  ProviderTokenSet,
  ProviderTransferMode,
  PublishInput,
  TikTokPrivacyLevel,
  TikTokPublicationRequirements,
  TikTokPublishOptions,
  YouTubePrivacyStatus,
  YouTubePublishOptions,
} from "./types";
export {
  captionLength,
  composeCaption,
  validatePublishInput,
  type CaptionSource,
  type ValidationIssue,
} from "./validator";
export { createYouTubeAdapter, type YouTubeAdapterOptions } from "./youtube/adapter";

function wrapWithMetadata<
  Args extends readonly unknown[],
  R extends ProviderOperationResult | ProviderPublicationStatus,
>(
  fn: (context: ProviderRequestContext, ...args: Args) => Promise<R>,
): (context: ProviderRequestContext, ...args: Args) => Promise<R> {
  return async (context, ...args) => {
    context.metadata = undefined;
    const result = await fn(context, ...args);
    return context.metadata ? { ...result, metadata: context.metadata } : result;
  };
}

export interface ProviderRegistryEnvironment {
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  APP_URL?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_LIVE_ACCEPTED?: string;
  TIKTOK_MEDIA_URL_PREFIX?: string;
  THREADS_CLIENT_ID?: string;
  THREADS_CLIENT_SECRET?: string;
  THREADS_ENGAGEMENT_LIVE_ACCEPTED?: string;
  THREADS_LIVE_ACCEPTED?: string;
  YOUTUBE_LIVE_ACCEPTED?: string;
  YOUTUBE_SHORTS_CLIENT_ID?: string;
  YOUTUBE_SHORTS_CLIENT_SECRET?: string;
}

export interface ProviderRegistryFactoryOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMilliseconds?: number;
}

const registryConfigKeys = [
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "FACEBOOK_LIVE_ACCEPTED",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED",
  "INSTAGRAM_LIVE_ACCEPTED",
  "APP_URL",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_LIVE_ACCEPTED",
  "TIKTOK_MEDIA_URL_PREFIX",
  "THREADS_CLIENT_ID",
  "THREADS_CLIENT_SECRET",
  "THREADS_ENGAGEMENT_LIVE_ACCEPTED",
  "THREADS_LIVE_ACCEPTED",
  "YOUTUBE_LIVE_ACCEPTED",
  "YOUTUBE_SHORTS_CLIENT_ID",
  "YOUTUBE_SHORTS_CLIENT_SECRET",
] as const satisfies readonly (keyof ProviderRegistryEnvironment)[];

type RegistryConfigKey = (typeof registryConfigKeys)[number];
type RegistryConfigSnapshot = Record<RegistryConfigKey, string | undefined>;

interface RegistryCacheEntry {
  registry: ProviderRegistry;
  values: RegistryConfigSnapshot;
}

const registryCache = new WeakMap<object, RegistryCacheEntry>();

export class ProviderRegistry {
  readonly #adapters = new Map<Platform, ProviderAdapter>();

  register(platform: Platform, adapter: ProviderAdapter): void {
    if (this.#adapters.has(platform)) {
      throw new TypeError(`provider adapter is already registered: ${platform}`);
    }
    if (adapter.capability.platform !== platform) {
      throw new TypeError("provider adapter capability platform does not match registry key");
    }
    if (adapter.capability.publish && (!adapter.publish || !adapter.lookupPublication)) {
      throw new TypeError("publish capability requires publish and lookup adapters");
    }
    if (adapter.capability.publish && !adapter.retryPolicy) {
      throw new TypeError("publish capability requires a retry policy");
    }
    if (
      platform === "tiktok" &&
      adapter.capability.publish &&
      !adapter.getPublicationRequirements
    ) {
      throw new TypeError("TikTok publish capability requires publication requirements");
    }
    if (adapter.retryPolicy) {
      const { baseDelaySeconds, maxAttempts, maxDelaySeconds } = adapter.retryPolicy;
      if (
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > 10 ||
        !Number.isInteger(baseDelaySeconds) ||
        baseDelaySeconds < 1 ||
        baseDelaySeconds > 3_600 ||
        !Number.isInteger(maxDelaySeconds) ||
        maxDelaySeconds < baseDelaySeconds ||
        maxDelaySeconds > 86_400
      ) {
        throw new TypeError("provider retry policy is outside safe bounds");
      }
    }
    if (
      adapter.capability.publish &&
      adapter.capability.asset_types.length > 0 &&
      adapter.transferModes.length === 0
    ) {
      throw new TypeError("media publish capability requires at least one transfer mode");
    }
    if (
      adapter.capability.connect_available &&
      (!adapter.authorizationUrl || !adapter.exchangeAuthorizationCode)
    ) {
      throw new TypeError("connect capability requires authorization and code-exchange adapters");
    }
    if (adapter.capability.analytics && !adapter.listAnalytics) {
      throw new TypeError("analytics capability requires an analytics adapter");
    }
    if (adapter.capability.comments && !adapter.listComments) {
      throw new TypeError("comments capability requires a comments adapter");
    }
    if (adapter.capability.reply && !adapter.reply) {
      throw new TypeError("reply capability requires a reply adapter");
    }
    const frozenCapability = freezeCapability(structuredClone(adapter.capability));
    const registered: ProviderAdapter = {
      ...adapter,
      capability: frozenCapability,
      ...(adapter.publish
        ? {
            publish: wrapWithMetadata((context, credentials, input) => {
              const fn = adapter.publish;
              if (!fn) throw new TypeError("publish adapter method was removed");
              return fn(context, credentials, input);
            }),
          }
        : {}),
      ...(adapter.cancelPublication
        ? {
            cancelPublication: wrapWithMetadata((context, credentials, lookup) => {
              const fn = adapter.cancelPublication;
              if (!fn) throw new TypeError("cancelPublication adapter method was removed");
              return fn(context, credentials, lookup);
            }),
          }
        : {}),
      ...(adapter.reply
        ? {
            reply: wrapWithMetadata((context, credentials, input) => {
              const fn = adapter.reply;
              if (!fn) throw new TypeError("reply adapter method was removed");
              return fn(context, credentials, input);
            }),
          }
        : {}),
      ...(adapter.lookupPublication
        ? {
            lookupPublication: wrapWithMetadata((context, credentials, lookup) => {
              const fn = adapter.lookupPublication;
              if (!fn) throw new TypeError("lookupPublication adapter method was removed");
              return fn(context, credentials, lookup);
            }),
          }
        : {}),
    };
    this.#adapters.set(platform, registered);
  }

  get(platform: Platform): ProviderAdapter | undefined {
    return this.#adapters.get(platform);
  }

  ambiguousZeroMetrics(platform: Platform): readonly ProviderAnalyticsMetric[] {
    return this.#adapters.get(platform)?.ambiguousZeroMetrics ?? [];
  }

  capabilities(): PlatformCapability[] {
    const fallbacks =
      this.#adapters.size > 0 ? unconfiguredWithoutAnalytics : unconfiguredWithAnalytics;
    return PLATFORM_IDS.map(
      (platform) => this.#adapters.get(platform)?.capability ?? fallbacks[platform],
    );
  }
}

function acceptanceFlag(name: string, value: string | undefined): boolean {
  const normalized = value?.trim() ?? "false";
  if (!["", "false", "true"].includes(normalized)) {
    throw new TypeError(`${name} must be true or false`);
  }
  return normalized === "true";
}

function trustedPublicUrl(value: string | undefined): URL {
  if (!value?.trim()) {
    throw new TypeError("accepted provider configuration is incomplete");
  }
  return assertHttpsOrLoopbackUrl(value.trim(), "APP_URL");
}

/**
 * Factory that initializes and populates a ProviderRegistry from environment variables.
 * Checks live acceptance flags (`<PLATFORM>_LIVE_ACCEPTED=true`), verifies credentials,
 * derives canonical redirect URIs and the default TikTok provider-media prefix from APP_URL,
 * and configures provider adapters with HTTP clients and timeouts. A nonblank
 * TIKTOK_MEDIA_URL_PREFIX overrides the derived HTTPS directory; blank values use the default.
 * Returns populated ProviderRegistry. Throws TypeError if accepted provider configurations are incomplete.
 */
export function createProviderRegistryFromEnvironment(
  environment: ProviderRegistryEnvironment,
  options: ProviderRegistryFactoryOptions = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const facebookAccepted = acceptanceFlag(
    "FACEBOOK_LIVE_ACCEPTED",
    environment.FACEBOOK_LIVE_ACCEPTED,
  );
  const instagramAccepted = acceptanceFlag(
    "INSTAGRAM_LIVE_ACCEPTED",
    environment.INSTAGRAM_LIVE_ACCEPTED,
  );
  const instagramEngagementAccepted = acceptanceFlag(
    "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED",
    environment.INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED,
  );
  const threadsAccepted = acceptanceFlag(
    "THREADS_LIVE_ACCEPTED",
    environment.THREADS_LIVE_ACCEPTED,
  );
  const threadsEngagementAccepted = acceptanceFlag(
    "THREADS_ENGAGEMENT_LIVE_ACCEPTED",
    environment.THREADS_ENGAGEMENT_LIVE_ACCEPTED,
  );
  const tiktokAccepted = acceptanceFlag("TIKTOK_LIVE_ACCEPTED", environment.TIKTOK_LIVE_ACCEPTED);
  const youtubeAccepted = acceptanceFlag(
    "YOUTUBE_LIVE_ACCEPTED",
    environment.YOUTUBE_LIVE_ACCEPTED,
  );
  if (instagramEngagementAccepted && !instagramAccepted) {
    throw new TypeError("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED requires INSTAGRAM_LIVE_ACCEPTED=true");
  }
  if (threadsEngagementAccepted && !threadsAccepted) {
    throw new TypeError("THREADS_ENGAGEMENT_LIVE_ACCEPTED requires THREADS_LIVE_ACCEPTED=true");
  }
  if (
    !facebookAccepted &&
    !instagramAccepted &&
    !threadsAccepted &&
    !tiktokAccepted &&
    !youtubeAccepted
  ) {
    return registry;
  }

  const facebookClientId = environment.FACEBOOK_CLIENT_ID?.trim();
  const facebookClientSecret = environment.FACEBOOK_CLIENT_SECRET?.trim();
  if (facebookAccepted && (!facebookClientId || !facebookClientSecret)) {
    throw new TypeError("accepted Facebook provider configuration is incomplete");
  }
  const instagramClientId = environment.INSTAGRAM_CLIENT_ID?.trim();
  const instagramClientSecret = environment.INSTAGRAM_CLIENT_SECRET?.trim();
  if (instagramAccepted && (!instagramClientId || !instagramClientSecret)) {
    throw new TypeError("accepted Instagram provider configuration is incomplete");
  }
  const threadsClientId = environment.THREADS_CLIENT_ID?.trim();
  const threadsClientSecret = environment.THREADS_CLIENT_SECRET?.trim();
  if (threadsAccepted && (!threadsClientId || !threadsClientSecret)) {
    throw new TypeError("accepted Threads provider configuration is incomplete");
  }
  const tiktokClientKey = environment.TIKTOK_CLIENT_KEY?.trim();
  const tiktokClientSecret = environment.TIKTOK_CLIENT_SECRET?.trim();
  const tiktokMediaUrlPrefix = environment.TIKTOK_MEDIA_URL_PREFIX?.trim();
  if (tiktokAccepted && (!tiktokClientKey || !tiktokClientSecret)) {
    throw new TypeError("accepted TikTok provider configuration is incomplete");
  }
  const youtubeClientId = environment.YOUTUBE_SHORTS_CLIENT_ID?.trim();
  const youtubeClientSecret = environment.YOUTUBE_SHORTS_CLIENT_SECRET?.trim();
  if (youtubeAccepted && (!youtubeClientId || !youtubeClientSecret)) {
    throw new TypeError("accepted YouTube provider configuration is incomplete");
  }
  const publicUrl = trustedPublicUrl(environment.APP_URL);
  const commonOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  };

  if (facebookAccepted && facebookClientId && facebookClientSecret) {
    registry.register(
      "facebook",
      createFacebookAdapter({
        clientId: facebookClientId,
        clientSecret: facebookClientSecret,
        redirectUri: `${publicUrl.origin}${oauthCallbackPath("facebook")}`,
        ...commonOptions,
      }),
    );
  }
  if (instagramAccepted && instagramClientId && instagramClientSecret) {
    registry.register(
      "instagram",
      createInstagramAdapter({
        clientId: instagramClientId,
        clientSecret: instagramClientSecret,
        engagementEnabled: instagramEngagementAccepted,
        redirectUri: `${publicUrl.origin}${oauthCallbackPath("instagram")}`,
        ...commonOptions,
      }),
    );
  }
  if (threadsAccepted && threadsClientId && threadsClientSecret) {
    registry.register(
      "threads",
      createThreadsAdapter({
        clientId: threadsClientId,
        clientSecret: threadsClientSecret,
        engagementEnabled: threadsEngagementAccepted,
        redirectUri: `${publicUrl.origin}${oauthCallbackPath("threads")}`,
        ...commonOptions,
      }),
    );
  }
  if (tiktokAccepted && tiktokClientKey && tiktokClientSecret) {
    registry.register(
      "tiktok",
      createTikTokAdapter({
        clientId: tiktokClientKey,
        clientSecret: tiktokClientSecret,
        mediaUrlPrefix: tiktokMediaUrlPrefix || `${publicUrl.origin}/api/v1/provider-media/`,
        redirectUri: `${publicUrl.origin}${oauthCallbackPath("tiktok")}`,
        ...commonOptions,
      }),
    );
  }
  if (youtubeAccepted && youtubeClientId && youtubeClientSecret) {
    registry.register(
      "youtube",
      createYouTubeAdapter({
        clientId: youtubeClientId,
        clientSecret: youtubeClientSecret,
        redirectUri: `${publicUrl.origin}${oauthCallbackPath("youtube")}`,
        ...commonOptions,
      }),
    );
  }
  return registry;
}

/**
 * Reuses the immutable provider graph for repeated requests in one Worker isolate.
 * The environment object is cached in a WeakMap alongside a snapshot of configuration keys;
 * invalidates and recreates the registry if any configuration value is mutated in place.
 * Returns the cached or freshly initialized ProviderRegistry.
 */
export function cachedProviderRegistryFromEnvironment(
  environment: ProviderRegistryEnvironment,
): ProviderRegistry {
  const key = environment as object;
  const cached = registryCache.get(key);
  if (cached) {
    let unchanged = true;
    for (const name of registryConfigKeys) {
      if (cached.values[name] !== environment[name]) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return cached.registry;
  }
  const values = {} as RegistryConfigSnapshot;
  for (const name of registryConfigKeys) values[name] = environment[name];
  const registry = createProviderRegistryFromEnvironment(environment);
  registryCache.set(key, { registry, values });
  return registry;
}
