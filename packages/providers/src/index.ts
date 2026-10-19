import {
  oauthCallbackPath,
  PLATFORM_IDS,
  type Platform,
  type PlatformCapability,
} from "@meltiply/domain";

import { assertHttpsOrLoopbackUrl } from "./meta-common";
import { createFacebookAdapter, FACEBOOK_MAX_CAPTION_LENGTH } from "./facebook";
import { createInstagramAdapter, INSTAGRAM_MAX_CAPTION_LENGTH } from "./instagram";
import { createThreadsAdapter, THREADS_MAX_CAPTION_LENGTH } from "./threads";
import { createTikTokAdapter, TIKTOK_MAX_CAPTION_LENGTH } from "./tiktok";
import type {
  ProviderAdapter,
  ProviderOperationResult,
  ProviderPublicationStatus,
  ProviderRequestContext,
} from "./types";
import { createYouTubeAdapter, YOUTUBE_MAX_CAPTION_LENGTH } from "./youtube";

/** Draft caption constraints are independent of credentials and runtime activation. */
const captionLimits: Readonly<Record<Platform, number>> = {
  facebook: FACEBOOK_MAX_CAPTION_LENGTH,
  instagram: INSTAGRAM_MAX_CAPTION_LENGTH,
  threads: THREADS_MAX_CAPTION_LENGTH,
  tiktok: TIKTOK_MAX_CAPTION_LENGTH,
  youtube: YOUTUBE_MAX_CAPTION_LENGTH,
};

export * from "./effect";
export * from "./failures";
export * from "./facebook";
export * from "./http";
export * from "./instagram";
export * from "./rate-limit";
export * from "./threads";
export * from "./tiktok";
export type * from "./types";
export * from "./validator";
export * from "./youtube";

/**
 * Attaches extracted provider telemetry metadata from the request context to an operation result.
 * Preserves rate limit budget headers discovered during execution in the returned result object.
 * Returns operation result with metadata attached if present, or original result otherwise.
 */
function operationResultWithMetadata(
  context: ProviderRequestContext,
  result: ProviderOperationResult,
): ProviderOperationResult {
  return context.metadata ? { ...result, metadata: context.metadata } : result;
}

/**
 * Attaches extracted provider telemetry metadata from the request context to a publication status record.
 * Returns publication status record with rate limit metadata attached if present.
 */
function publicationStatusWithMetadata(
  context: ProviderRequestContext,
  result: ProviderPublicationStatus,
): ProviderPublicationStatus {
  return context.metadata ? { ...result, metadata: context.metadata } : result;
}

export interface ProviderRegistryEnvironment {
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  PUBLIC_API_URL?: string;
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
  "PUBLIC_API_URL",
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

  /**
   * Registers and wraps an initialized ProviderAdapter for a specific social media platform.
   * Enforces strict capability validation, required lifecycle methods, retry policy bounds (1-10 attempts, up to 24h),
   * and wraps mutation operations to attach telemetry context metadata to operation results.
   * Throws TypeError if the platform is already registered, capabilities mismatch, or contracts are violated.
   */
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
    const registered: ProviderAdapter = { ...adapter };
    if (adapter.publish) {
      registered.publish = async (context, credentials, input) => {
        context.metadata = undefined;
        return operationResultWithMetadata(
          context,
          await adapter.publish!(context, credentials, input),
        );
      };
    }
    if (adapter.cancelPublication) {
      registered.cancelPublication = async (context, credentials, lookup) => {
        context.metadata = undefined;
        return operationResultWithMetadata(
          context,
          await adapter.cancelPublication!(context, credentials, lookup),
        );
      };
    }
    if (adapter.reply) {
      registered.reply = async (context, credentials, input) => {
        context.metadata = undefined;
        return operationResultWithMetadata(
          context,
          await adapter.reply!(context, credentials, input),
        );
      };
    }
    if (adapter.lookupPublication) {
      registered.lookupPublication = async (context, credentials, lookup) => {
        context.metadata = undefined;
        return publicationStatusWithMetadata(
          context,
          await adapter.lookupPublication!(context, credentials, lookup),
        );
      };
    }
    this.#adapters.set(platform, registered);
  }

  /**
   * Retrieves the registered ProviderAdapter instance for a platform.
   * Returns the ProviderAdapter if registered, or undefined if unconfigured.
   */
  get(platform: Platform): ProviderAdapter | undefined {
    return this.#adapters.get(platform);
  }

  /**
   * Returns capability descriptors for all platforms defined in PLATFORM_IDS.
   * Registered adapters supply their active descriptors. Unconfigured providers
   * retain their declared caption ceilings while every runtime operation remains
   * unavailable. Returned descriptors are isolated and follow canonical platform order.
   */
  capabilities(): PlatformCapability[] {
    return PLATFORM_IDS.map((platform) => {
      const adapter = this.#adapters.get(platform);
      return adapter
        ? structuredClone(adapter.capability)
        : {
            accepted_mime_types: [],
            analytics: false,
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
          };
    });
  }
}

/**
 * Parses and validates an environment boolean acceptance flag.
 * Requires value to be 'true', 'false', or empty/undefined (defaults to false).
 * Returns true if value is 'true', false otherwise. Throws TypeError if value contains invalid text.
 */
function acceptanceFlag(name: string, value: string | undefined): boolean {
  const normalized = value?.trim() ?? "false";
  if (!["", "false", "true"].includes(normalized)) {
    throw new TypeError(`${name} must be true or false`);
  }
  return normalized === "true";
}

/**
 * Validates that the public API base URL is a non-empty, credential-free HTTPS or loopback URL.
 * Required for deriving canonical OAuth callback URLs for provider redirect registrations.
 * Returns validated URL object. Throws TypeError if empty, malformed, or untrusted.
 */
function trustedPublicUrl(value: string | undefined): URL {
  if (!value?.trim()) {
    throw new TypeError("accepted provider configuration is incomplete");
  }
  return assertHttpsOrLoopbackUrl(value.trim(), "PUBLIC_API_URL");
}

/**
 * Factory that initializes and populates a ProviderRegistry from environment variables.
 * Checks live acceptance flags (`<PLATFORM>_LIVE_ACCEPTED=true`), verifies credentials,
 * derives canonical redirect URIs, and configures provider adapters with HTTP clients and timeouts.
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
  if (tiktokAccepted && (!tiktokClientKey || !tiktokClientSecret || !tiktokMediaUrlPrefix)) {
    throw new TypeError("accepted TikTok provider configuration is incomplete");
  }
  const youtubeClientId = environment.YOUTUBE_SHORTS_CLIENT_ID?.trim();
  const youtubeClientSecret = environment.YOUTUBE_SHORTS_CLIENT_SECRET?.trim();
  if (youtubeAccepted && (!youtubeClientId || !youtubeClientSecret)) {
    throw new TypeError("accepted YouTube provider configuration is incomplete");
  }
  const publicUrl = trustedPublicUrl(environment.PUBLIC_API_URL);
  const commonOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  };

  if (facebookAccepted) {
    registry.register(
      "facebook",
      createFacebookAdapter({
        clientId: facebookClientId!,
        clientSecret: facebookClientSecret!,
        redirectUri: new URL(oauthCallbackPath("facebook"), publicUrl).toString(),
        ...commonOptions,
      }),
    );
  }
  if (instagramAccepted) {
    registry.register(
      "instagram",
      createInstagramAdapter({
        clientId: instagramClientId!,
        clientSecret: instagramClientSecret!,
        engagementEnabled: instagramEngagementAccepted,
        redirectUri: new URL(oauthCallbackPath("instagram"), publicUrl).toString(),
        ...commonOptions,
      }),
    );
  }
  if (threadsAccepted) {
    registry.register(
      "threads",
      createThreadsAdapter({
        clientId: threadsClientId!,
        clientSecret: threadsClientSecret!,
        engagementEnabled: threadsEngagementAccepted,
        redirectUri: new URL(oauthCallbackPath("threads"), publicUrl).toString(),
        ...commonOptions,
      }),
    );
  }
  if (tiktokAccepted) {
    registry.register(
      "tiktok",
      createTikTokAdapter({
        clientKey: tiktokClientKey!,
        clientSecret: tiktokClientSecret!,
        mediaUrlPrefix: tiktokMediaUrlPrefix!,
        redirectUri: new URL(oauthCallbackPath("tiktok"), publicUrl).toString(),
        ...commonOptions,
      }),
    );
  }
  if (youtubeAccepted) {
    registry.register(
      "youtube",
      createYouTubeAdapter({
        clientId: youtubeClientId!,
        clientSecret: youtubeClientSecret!,
        redirectUri: new URL(oauthCallbackPath("youtube"), publicUrl).toString(),
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
