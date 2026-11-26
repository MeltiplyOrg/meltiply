import { malformed, rejected } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import {
  addSeconds,
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
  postForm,
} from "../oauth";
import type { AdapterRuntime } from "../runtime";
import type {
  OAuthAuthorizationInput,
  OAuthConnection,
  OAuthExchangeInput,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import {
  bearer,
  boundedString,
  boundedText,
  optionalSecureUrl,
  providerIdentifier,
  record,
  required,
} from "../values";
import {
  YOUTUBE_API_ORIGIN,
  YOUTUBE_AUTHORIZATION_ORIGIN,
  YOUTUBE_CONFIGURED_SCOPES,
  YOUTUBE_PUBLISHING_SCOPES,
  YOUTUBE_TOKEN_ORIGIN,
  type GoogleRequest,
} from "./types";

const pkcePattern = /^[A-Za-z0-9_-]{43,128}$/;
const whitespacePattern = /\s+/;
const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const handlePrefixPattern = /^@/;
const handlePattern = /^[A-Za-z0-9_.-]{1,100}$/;

interface GoogleTokenResponse<RequireRefresh extends boolean> {
  accessToken: string;
  expiresAt: string;
  refreshToken: RequireRefresh extends true ? string : string | undefined;
  scopes?: string[];
}

function pkce(name: string, value: string): string {
  const normalized = required(name, value, 128);
  if (!pkcePattern.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function scopeSet(value: unknown): Set<string> | undefined {
  const normalized = boundedString(value, 4_096);
  if (!normalized) return undefined;
  const scopes = normalized.split(whitespacePattern);
  if (
    scopes.length > 20 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !scopePattern.test(scope))
  ) {
    return undefined;
  }
  return new Set(scopes);
}

function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: true,
): GoogleTokenResponse<true>;
function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: false,
): GoogleTokenResponse<false>;
function parseGoogleTokenResponse(
  value: unknown,
  now: Date,
  requireRefreshToken: boolean,
): GoogleTokenResponse<boolean> {
  const body = record(value);
  const accessToken = boundedString(body?.access_token, PROVIDER_LIMITS.youtube.tokenMaxChars);
  const refreshToken = boundedString(body?.refresh_token, PROVIDER_LIMITS.youtube.tokenMaxChars);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  const scopes = scopeSet(body?.scope);
  if (
    !accessToken ||
    tokenType !== "bearer" ||
    (requireRefreshToken && !refreshToken) ||
    (body?.scope !== undefined && !scopes) ||
    (scopes && YOUTUBE_PUBLISHING_SCOPES.some((scope) => !scopes.has(scope)))
  ) {
    throw malformed();
  }
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, PROVIDER_LIMITS.youtube.tokenLifetimeMaxSeconds),
    refreshToken,
    ...(scopes ? { scopes: [...scopes] } : {}),
  };
}

function youtubeHandle(customUrl: unknown): string | undefined {
  if (typeof customUrl !== "string") return undefined;
  const normalized = customUrl.trim().replace(handlePrefixPattern, "");
  return normalized && handlePattern.test(normalized) ? normalized : undefined;
}

export function createYouTubeOAuth(runtime: AdapterRuntime, googleRequest: GoogleRequest) {
  const { clientId, clientSecret, redirectUri: configuredRedirectUri, http, now } = runtime;

  return {
    authorizationUrl(input: OAuthAuthorizationInput): string {
      return authorizationCodeUrl(
        `${YOUTUBE_AUTHORIZATION_ORIGIN}/o/oauth2/v2/auth`,
        input,
        configuredRedirectUri,
        {
          access_type: "offline",
          client_id: clientId,
          code_challenge: pkce("codeChallenge", input.codeChallenge),
          code_challenge_method: "S256",
          include_granted_scopes: "true",
          prompt: "consent select_account",
          scope: YOUTUBE_CONFIGURED_SCOPES.join(" "),
        },
      );
    },

    async exchangeAuthorizationCode(
      context: ProviderRequestContext,
      input: OAuthExchangeInput,
    ): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const tokenPayload = await exchangeAuthorizationCodeForm(http, context, {
        clientId,
        clientSecret,
        code: input.code,
        codeVerifier: pkce("codeVerifier", input.codeVerifier),
        redirectUri: configuredRedirectUri,
        tokenUrl: `${YOUTUBE_TOKEN_ORIGIN}/token`,
      });
      const tokens = parseGoogleTokenResponse(tokenPayload, now(), true);
      const channelUrl = new URL("/youtube/v3/channels", YOUTUBE_API_ORIGIN);
      channelUrl.searchParams.set("part", "id,snippet");
      channelUrl.searchParams.set("mine", "true");
      channelUrl.searchParams.set("maxResults", "2");
      const channelResponse = await googleRequest(context, {
        headers: bearer(tokens.accessToken),
        method: "GET",
        url: channelUrl.toString(),
      });
      const channelBody = record(channelResponse.body);
      if (
        !Array.isArray(channelBody?.items) ||
        channelBody.items.length !== 1 ||
        channelBody.nextPageToken !== undefined
      ) {
        throw rejected("youtube_channel_selection_required", 409);
      }
      const channel = record(channelBody.items[0]);
      const snippet = record(channel?.snippet);
      const thumbnails = record(snippet?.thumbnails);
      const thumbnail = record(thumbnails?.default);
      const id = providerIdentifier(channel?.id);
      const displayName = boundedText(snippet?.title, 500);
      const avatar = optionalSecureUrl(thumbnail?.url);
      const username = youtubeHandle(snippet?.customUrl);
      if (!id || !displayName || !avatar.valid) {
        throw malformed();
      }
      return {
        accessToken: tokens.accessToken,
        account: {
          ...(avatar.href ? { avatarUrl: avatar.href } : {}),
          displayName,
          id,
          ...(username ? { username } : {}),
        },
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scopes ?? [...YOUTUBE_CONFIGURED_SCOPES],
      };
    },

    async refreshAccessToken(
      context: ProviderRequestContext,
      refreshToken: string,
    ): Promise<ProviderTokenSet> {
      const currentRefreshToken = required(
        "refreshToken",
        refreshToken,
        PROVIDER_LIMITS.youtube.tokenMaxChars,
      );
      const body = await postForm(http, context, `${YOUTUBE_TOKEN_ORIGIN}/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      });
      const tokens = parseGoogleTokenResponse(body, now(), false);
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken ?? currentRefreshToken,
        scopes: tokens.scopes ?? [],
      };
    },
  };
}
