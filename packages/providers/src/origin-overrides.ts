import { FACEBOOK_GRAPH_ORIGIN, FACEBOOK_UPLOAD_ORIGIN } from "./facebook/types";
import { instagramApiOrigin, instagramGraphOrigin } from "./instagram/adapter";
import { threadsGraphOrigin } from "./threads/adapter";
import { tiktokApiOrigin } from "./tiktok/adapter";
import {
  YOUTUBE_ANALYTICS_ORIGIN,
  YOUTUBE_API_ORIGIN,
  YOUTUBE_TOKEN_ORIGIN,
} from "./youtube/types";

const overridableOrigins = {
  PROVIDER_ORIGIN_FACEBOOK_GRAPH: FACEBOOK_GRAPH_ORIGIN,
  PROVIDER_ORIGIN_FACEBOOK_UPLOAD: FACEBOOK_UPLOAD_ORIGIN,
  PROVIDER_ORIGIN_INSTAGRAM_API: instagramApiOrigin,
  PROVIDER_ORIGIN_INSTAGRAM_GRAPH: instagramGraphOrigin,
  PROVIDER_ORIGIN_THREADS_GRAPH: threadsGraphOrigin,
  PROVIDER_ORIGIN_TIKTOK_API: tiktokApiOrigin,
  PROVIDER_ORIGIN_YOUTUBE_ANALYTICS: YOUTUBE_ANALYTICS_ORIGIN,
  PROVIDER_ORIGIN_YOUTUBE_API: YOUTUBE_API_ORIGIN,
  PROVIDER_ORIGIN_YOUTUBE_TOKEN: YOUTUBE_TOKEN_ORIGIN,
} as const;

export type ProviderOriginSetting = keyof typeof overridableOrigins;

export const providerOriginSettings = Object.keys(overridableOrigins) as ProviderOriginSetting[];

const loopbackHosts: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

function loopbackOrigin(name: ProviderOriginSetting, value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    url?.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.href !== `${url.origin}/`
  ) {
    throw new TypeError(`${name} must be a loopback HTTP origin`);
  }
  return url.origin;
}

/** Maps each overridden provider origin to its loopback replacement; throws for any other value. */
export function providerOriginOverrides(
  environment: Partial<Record<ProviderOriginSetting, string>>,
): ReadonlyMap<string, string> {
  const overrides = new Map<string, string>();
  for (const name of providerOriginSettings) {
    const value = environment[name]?.trim();
    if (value) overrides.set(overridableOrigins[name], loopbackOrigin(name, value));
  }
  return overrides;
}

export function overriddenUrl(url: string, overrides: ReadonlyMap<string, string>): string {
  const parsed = new URL(url);
  const replacement = overrides.get(parsed.origin);
  return replacement ? `${replacement}${parsed.pathname}${parsed.search}` : url;
}

/** Sends requests for overridden origins elsewhere, after every allowlist check has run on the real URL. */
export function redirectingFetch(
  overrides: ReadonlyMap<string, string>,
  send: typeof fetch,
): typeof fetch {
  return (input, init) =>
    send.call(
      globalThis,
      input instanceof Request ? input : overriddenUrl(String(input), overrides),
      init,
    );
}
