import { addSeconds, malformed } from "../adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "../failures";
import type { ProviderHttpClient } from "../http";
import { OAUTH_STATE_MAX_CHARS } from "../limits";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedString,
  boundedText,
  providerIdentifier,
  record,
  required,
  secureUrl,
} from "../meta-common";
import { exchangeAuthorizationCodeForm } from "../oauth-helpers";
import type {
  OAuthAuthorizationInput,
  OAuthConnection,
  OAuthExchangeInput,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import {
  YOUTUBE_API_ORIGIN,
  YOUTUBE_AUTHORIZATION_ORIGIN,
  YOUTUBE_CONFIGURED_SCOPES,
  YOUTUBE_LIMITS,
  YOUTUBE_PUBLISHING_SCOPES,
  YOUTUBE_TOKEN_ORIGIN,
  type GoogleRequest,
} from "./types";

const pkcePattern = /^[A-Za-z0-9_-]{43,128}$/;
const whitespacePattern = /\s+/;
const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const handlePrefixPattern = /^@/;
const handlePattern = /^[A-Za-z0-9_.-]{1,100}$/;

export interface YouTubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  configuredRedirectUri: string;
  googleRequest: GoogleRequest;
  http: ProviderHttpClient;
  now: () => Date;
}

interface GoogleTokenResponse<RequireRefresh extends boolean> {
  accessToken: string;
  expiresAt: string;
  refreshToken: RequireRefresh extends true ? string : string | undefined;
  scopes?: string[];
}

/** Validates a PKCE `code_verifier` or `code_challenge` according to RFC 7636. */
function pkce(name: string, value: string): string {
  const normalized = required(name, value, 128);
  if (!pkcePattern.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

/** Parses whitespace-delimited Google OAuth scope tokens with length and uniqueness bounds. */
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

/**
 * Parses and verifies an OAuth 2.0 token response from Google's token endpoint.
 * Preserves explicit grants; omitted scopes stay absent so refresh callers
 * preserve stored grants. Return type guarantees `refreshToken` is a string
 * when `requireRefreshToken` is true, removing downstream non-null assertions.
 */
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
  const accessToken = boundedString(body?.access_token, YOUTUBE_LIMITS.tokenMaxChars);
  const refreshToken = boundedString(body?.refresh_token, YOUTUBE_LIMITS.tokenMaxChars);
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
    expiresAt: addSeconds(now, body?.expires_in, YOUTUBE_LIMITS.tokenLifetimeMaxSeconds),
    refreshToken,
    ...(scopes ? { scopes: [...scopes] } : {}),
  };
}

/** Extracts a legitimate YouTube channel handle from `snippet.customUrl`. */
function youtubeHandle(customUrl: unknown): string | undefined {
  if (typeof customUrl !== "string") return undefined;
  const normalized = customUrl.trim().replace(handlePrefixPattern, "");
  return normalized && handlePattern.test(normalized) ? normalized : undefined;
}

/**
 * Builds the YouTube OAuth handler methods (`authorizationUrl`,
 * `exchangeAuthorizationCode`, `refreshAccessToken`).
 */
export function createYouTubeOAuth(config: YouTubeOAuthConfig) {
  const { clientId, clientSecret, configuredRedirectUri, googleRequest, http, now } = config;

  return {
    /**
     * Builds the Google OAuth v2 authorization URL with offline access, PKCE S256
     * challenge, incremental grants, account selection and consent prompts, and the
     * configured redirect URI, scopes, and state.
     */
    authorizationUrl(input: OAuthAuthorizationInput): string {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL("/o/oauth2/v2/auth", YOUTUBE_AUTHORIZATION_ORIGIN);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("code_challenge", pkce("codeChallenge", input.codeChallenge));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent select_account");
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", YOUTUBE_CONFIGURED_SCOPES.join(" "));
      url.searchParams.set("state", required("state", input.state, OAUTH_STATE_MAX_CHARS));
      return url.toString();
    },

    /**
     * Exchanges a PKCE authorization code for Google tokens and binds the
     * connection to exactly one YouTube channel (`channels.list` `mine=true`).
     */
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
      const channelResponse = await googleRequest<unknown>(context, {
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
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "youtube_channel_selection_required",
            status: 409,
          }),
        );
      }
      const channel = record(channelBody.items[0]);
      const snippet = record(channel?.snippet);
      const thumbnails = record(snippet?.thumbnails);
      const thumbnail = record(thumbnails?.default);
      const id = providerIdentifier(channel?.id);
      const displayName = boundedText(snippet?.title, 500);
      const avatarUrl = thumbnail?.url === undefined ? undefined : secureUrl(thumbnail.url)?.href;
      const username = youtubeHandle(snippet?.customUrl);
      if (!id || !displayName || (thumbnail?.url !== undefined && !avatarUrl)) {
        throw malformed();
      }
      return {
        accessToken: tokens.accessToken,
        account: {
          ...(avatarUrl ? { avatarUrl } : {}),
          displayName,
          id,
          ...(username ? { username } : {}),
        },
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scopes ?? [...YOUTUBE_CONFIGURED_SCOPES],
      };
    },

    /** Refreshes publishing grants; an omitted scope list preserves the stored grant in the consumer. */
    async refreshAccessToken(
      context: ProviderRequestContext,
      refreshToken: string,
    ): Promise<ProviderTokenSet> {
      const currentRefreshToken = required(
        "refreshToken",
        refreshToken,
        YOUTUBE_LIMITS.tokenMaxChars,
      );
      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      });
      const response = await http.request<unknown>(context, {
        body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${YOUTUBE_TOKEN_ORIGIN}/token`,
      });
      const tokens = parseGoogleTokenResponse(response.body, now(), false);
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken ?? currentRefreshToken,
        scopes: tokens.scopes ?? [],
      };
    },
  };
}
